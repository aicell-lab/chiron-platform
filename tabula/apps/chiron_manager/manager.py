import asyncio
import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import logging

from bioengine.datasets import BioEngineDatasets
from hypha_rpc import connect_to_server
from hypha_rpc.utils import ObjectProxy
from hypha_rpc.utils.schema import schema_method
from pydantic import Field
from ray import serve

logger = logging.getLogger("ray.serve")


@serve.deployment(
    ray_actor_options={
        "num_cpus": 0,
        "num_gpus": 0,
    },
    max_ongoing_requests=5,
    max_queued_requests=10,
    health_check_period_s=10.0,
    health_check_timeout_s=30.0,
    graceful_shutdown_timeout_s=300.0,
    graceful_shutdown_wait_loop_s=2.0,
)
class FederatedTrainingManager:
    bioengine_datasets: BioEngineDatasets  # Injected BioEngine Datasets Service

    def __init__(
        self, orchestrator_artifact_id: str = "chiron-platform/chiron-orchestrator"
    ) -> None:
        """Manager for Federated Learning"""
        # BioEngine Worker Service
        self._server_url = os.getenv("HYPHA_SERVER_URL")
        if not self._server_url:
            raise ValueError("HYPHA_SERVER_URL environment variable is not set.")
        self._hypha_token = os.getenv("HYPHA_TOKEN")
        if not self._hypha_token:
            raise ValueError("HYPHA_TOKEN environment variable is not set.")
        self._worker_service_id = os.getenv("BIOENGINE_WORKER_SERVICE_ID")
        if not self._worker_service_id:
            raise ValueError(
                "BIOENGINE_WORKER_SERVICE_ID environment variable is not set."
            )
        self.worker_service: ObjectProxy = None  # type: ignore
        self.hypha_client: ObjectProxy = None  # type: ignore

        self.orchestrator_artifact_id: str = orchestrator_artifact_id

        # Known trainer artifact IDs — used to validate remove_trainer calls.
        self.trainer_artifact_ids: set = {"chiron-platform/tabula-trainer"}

        # Cache of dataset info keyed by trainer application ID, populated when
        # create_trainer is called from this session.
        self._trainer_datasets: Dict[str, dict] = {}


    # === BioEngine App Method - will be called when the deployment is started ===

    async def async_init(self) -> None:
        client = await connect_to_server(
            {
                "server_url": self._server_url,
                "token": self._hypha_token,
            }
        )
        self.hypha_client = client
        logger.info(f"Connected to Hypha Server at {self._server_url}")
        self.worker_service = await client.get_service(self._worker_service_id)
        logger.info(f"Connected to BioEngine Worker Service: {self._worker_service_id}")

    async def test_deployment(self):
        pass

    # === Ray Serve Health Check Method - will be called periodically to check the health of the deployment ===

    async def check_health(self) -> None:
        # Test connection to the BioEngine Worker Service
        has_access = await self.worker_service.check_access()

        # Require admin access to the BioEngine Worker Service for calling the functions:
        # - deploy_app
        # - stop_app
        if not has_access:
            deployment_name = self.__class__.__name__
            raise RuntimeError(
                f"{deployment_name} has no admin access to the BioEngine Worker Service."
            )

    # === Internal Helper Methods ===

    async def _get_apps_status(self) -> Tuple[Dict[str, dict], Dict[str, dict]]:
        """
        Discover all chiron-orchestrator and tabula-trainer applications currently
        running on the worker by scanning their artifact IDs, regardless of whether
        they were deployed from this manager session.
        """
        trainers_status = {}
        orchestrators_status = {}

        applications = await self.worker_service.get_app_status()

        running_trainer_ids = set()
        for app_id, app_info in applications.items():
            artifact_id = app_info.get("artifact_id", "")
            if app_info.get("status") == "NOT_RUNNING":
                continue
            if artifact_id == self.orchestrator_artifact_id:
                app_info["application_id"] = app_id
                orchestrators_status[app_id] = app_info
            elif artifact_id in self.trainer_artifact_ids:
                if app_id in self._trainer_datasets:
                    app_info["datasets"] = self._trainer_datasets[app_id]
                trainers_status[app_id] = app_info
                running_trainer_ids.add(app_id)

        # Evict stale dataset cache entries
        for app_id in list(self._trainer_datasets.keys()):
            if app_id not in running_trainer_ids:
                del self._trainer_datasets[app_id]

        return trainers_status, orchestrators_status

    async def _check_app_busy(self, websocket_service_id: str) -> bool:
        """Return True if the app's is_busy() method returns True, False on any error."""
        try:
            svc = await self.hypha_client.get_service(websocket_service_id)
            return await svc.is_busy()
        except Exception:
            return False

    async def _get_registered_orchestrator(self, websocket_service_id: str) -> Optional[str]:
        """Return the orchestrator service ID a trainer is registered to, or None on any error."""
        try:
            svc = await self.hypha_client.get_service(websocket_service_id)
            return await svc.get_registered_orchestrator()
        except Exception:
            return None

    async def _get_running_app_info(self, application_id: str) -> dict:
        """
        Fetch the full status dict for a running application from the worker.
        Raises ValueError if the application is not found or not running.
        """
        apps_status = await self.worker_service.get_app_status(
            application_ids=[application_id],
            logs_tail=0,
            n_previous_replica=0,
        )
        app_info = apps_status.get(application_id)
        if app_info is None or app_info.get("status") == "NOT_RUNNING":
            raise ValueError(
                f"Application '{application_id}' is not running on this worker."
            )
        return app_info

    def _get_deployed_by(self, app_info: dict) -> Optional[str]:
        """
        Extract the CHIRON_DEPLOYED_BY env var from a running app's status dict.
        Returns None if the var was not set (e.g. the app was deployed outside Chiron Manager).
        """
        env_vars = app_info.get("application_env_vars") or {}
        # env_vars is a dict keyed by deployment class name; check all inner dicts
        for inner in env_vars.values():
            if isinstance(inner, dict) and "CHIRON_DEPLOYED_BY" in inner:
                return inner["CHIRON_DEPLOYED_BY"]
        return None

    async def _get_admin_users(self) -> List[str]:
        """Return the list of admin users configured on this BioEngine worker."""
        worker_status = await self.worker_service.get_status()
        return worker_status.get("admin_users") or []

    def _check_delete_permission(
        self, caller: Optional[str], deployed_by: Optional[str], admin_users: List[str]
    ) -> None:
        """
        Raise PermissionError if caller is not allowed to delete the application.

        Allowed if:
        - caller is in the worker's admin_users list, OR
        - caller matches the user who deployed the app (deployed_by).

        If deployed_by is None the app was deployed in a previous manager session
        and ownership is no longer tracked — only admin users may delete it.
        """
        if caller is None:
            raise PermissionError(
                "Cannot determine caller identity. "
                "Pass your user ID via the caller_id parameter."
            )
        if caller in admin_users:
            return
        if deployed_by is None:
            raise PermissionError(
                "Ownership of this application is not tracked in the current manager "
                "session (it may have been deployed before the manager was last restarted). "
                "Only a worker admin may delete it."
            )
        if caller == deployed_by:
            return
        raise PermissionError(
            f"User '{caller}' is not authorised to delete this application. "
            f"Only the user who deployed it ('{deployed_by}') or a worker admin may delete it."
        )

    # === Exposed BioEngine App Methods - all methods decorated with @schema_method will be exposed as API endpoints ===
    # Note: Parameter type hints and docstrings will be used to generate the API documentation.

    @schema_method
    async def get_worker_info(self) -> Dict[str, dict]:
        """
        Get information about available datasets, compute resources, and status of
        running orchestrator and running trainer applications on this BioEngine worker.
        """
        worker_status = await self.worker_service.get_status()

        # Worker status contains:
        # "service_start_time": float
        # "service_uptime": float
        # "worker_mode": str
        # "workspace": str
        # "client_id": str
        # "admin_users": list[str]
        # "geo_location": {
        #     "region": str (e.g. "Stockholm County")
        #     "country_name": str (e.g. "Sweden")
        #     "country_code": str (e.g. "SE")
        #     "continent_code": str (e.g. "EU")
        #     "timezone": str (e.g. "Europe/Stockholm")
        #     "latitude": float
        #     "longitude": float
        # }
        # "is_ready": bool

        cluster_status = worker_status.pop("ray_cluster")["cluster"]

        # Cluster status contains:
        # - "total_cpu": float
        # - "used_cpu": float
        # - "total_gpu": float
        # - "used_gpu": float

        available_datasets = await self.bioengine_datasets.list_datasets()

        trainers_status, orchestrators_status = await self._get_apps_status()

        # Each application info contains:
        # - "display_name"
        # - "description"
        # - "artifact_id"
        # - "version"
        # - "status"
        # - "message"
        # - "deployments"
        # - "application_kwargs"
        # - "application_env_vars"
        # - "gpu_enabled"
        # - "application_resources"
        # - "authorized_users"
        # - "available_methods"
        # - "max_ongoing_requests"
        # - "service_ids"
        # - "start_time"
        # - "last_updated_by"
        # - "last_updated_at"
        # - "auto_redeploy"

        # Orchestrator-specific info:
        # - "application_id"

        # Trainer-specific info:
        # - "datasets"

        # Query is_busy() for all running apps in parallel and attach to their status dict.
        # For trainers also query get_registered_orchestrator() to surface in the UI.
        busy_checks: List[Tuple[str, str, str]] = []  # (kind, app_id, ws_id)
        trainer_ws_ids: List[Tuple[str, str]] = []    # (app_id, ws_id) for trainer reg query
        for app_id, app_info in orchestrators_status.items():
            sids = app_info.get("service_ids") or []
            if sids:
                busy_checks.append(("orchestrator", app_id, sids[0]["websocket_service_id"]))
        for app_id, app_info in trainers_status.items():
            sids = app_info.get("service_ids") or []
            if sids:
                ws_id = sids[0]["websocket_service_id"]
                busy_checks.append(("trainer", app_id, ws_id))
                trainer_ws_ids.append((app_id, ws_id))

        if busy_checks:
            busy_results = await asyncio.gather(
                *[self._check_app_busy(ws_id) for _, _, ws_id in busy_checks],
                return_exceptions=True,
            )
            for (kind, app_id, _), result in zip(busy_checks, busy_results):
                is_busy = result if isinstance(result, bool) else False
                if kind == "orchestrator":
                    orchestrators_status[app_id]["is_busy"] = is_busy
                else:
                    trainers_status[app_id]["is_busy"] = is_busy

        if trainer_ws_ids:
            reg_results = await asyncio.gather(
                *[self._get_registered_orchestrator(ws_id) for _, ws_id in trainer_ws_ids],
                return_exceptions=True,
            )
            for (app_id, _), result in zip(trainer_ws_ids, reg_results):
                trainers_status[app_id]["registered_orchestrator_id"] = (
                    result if isinstance(result, str) else None
                )

        worker_info = {
            "worker_info": worker_status,
            "cluster_status": cluster_status,
            "datasets": available_datasets,
            "orchestrators_status": orchestrators_status,
            "trainers_status": trainers_status,
        }
        return worker_info

    @schema_method
    async def create_orchestrator(
        self,
        token: str = Field(
            ...,
            description="Hypha token with access to the trainers, required by the orchestrator.",
        ),
        trainer_artifact_id: str = Field(
            "chiron-platform/tabula-trainer",
            description="Artifact ID of the trainer to be used by the orchestrator.",
        ),
        owner_id: Optional[str] = Field(
            None,
            description="User ID of the caller creating this orchestrator. "
            "Stored for ownership-based deletion control.",
        ),
    ) -> str:
        """Start a new orchestrator application on this BioEngine worker."""
        # Start a new orchestrator application
        logger.info("Starting new orchestrator application...")
        env_vars: dict = {}
        if owner_id:
            env_vars["CHIRON_DEPLOYED_BY"] = owner_id
        application_id = await self.worker_service.deploy_app(
            artifact_id=self.orchestrator_artifact_id,
            application_kwargs={
                "FederatedTrainingOrchestrator": {
                    "trainer_artifact_id": trainer_artifact_id,
                }
            },
            application_env_vars={"FederatedTrainingOrchestrator": env_vars},
            hypha_token=token,  # Orchestrator needs a token to access trainers
        )

        logger.info(f"Deployed orchestrator {application_id} (owner: {owner_id})")
        return application_id

    @schema_method
    async def remove_orchestrator(
        self,
        application_id: str = Field(
            ..., description="Application ID of the orchestrator to be removed."
        ),
        force: bool = Field(
            False,
            description="Force removal even if the orchestrator is currently busy (training is running).",
        ),
        caller_id: Optional[str] = Field(
            None,
            description="User ID of the caller requesting deletion. "
            "Must match the owner who created the orchestrator, or be a worker admin.",
        ),
    ) -> None:
        """Stop a given orchestrator application on this BioEngine worker."""
        app_info, admin_users = await asyncio.gather(
            self._get_running_app_info(application_id),
            self._get_admin_users(),
        )

        if app_info.get("artifact_id") != self.orchestrator_artifact_id:
            raise ValueError(
                f"Application '{application_id}' belongs to artifact '{app_info.get('artifact_id')}', "
                f"which is not the orchestrator artifact '{self.orchestrator_artifact_id}'."
            )

        self._check_delete_permission(
            caller=caller_id,
            deployed_by=self._get_deployed_by(app_info),
            admin_users=admin_users,
        )

        if not force:
            sids = app_info.get("service_ids") or []
            if sids:
                is_busy = await self._check_app_busy(sids[0]["websocket_service_id"])
                if is_busy:
                    raise RuntimeError(
                        f"Orchestrator '{application_id}' is currently busy (training is running). "
                        "Pass force=True to remove it anyway."
                    )

        await self.worker_service.stop_app(application_id)
        logger.info(f"Removed orchestrator with application ID: {application_id}")

    @schema_method
    async def create_trainer(
        self,
        token: str = Field(
            ...,
            description="Hypha token with access to the datasets, required by the trainer client.",
        ),
        datasets: List[str] = Field(
            ..., description="List of dataset names to be used by the trainer client."
        ),
        trainer_artifact_id: str = Field(
            "chiron-platform/tabula-trainer",
            description="Artifact ID of the trainer to be used by the orchestrator.",
        ),
        trainer_id: Optional[str] = Field(
            None, description="Optional unique identifier for the trainer client."
        ),
        trainer_name: Optional[str] = Field(
            None, description="Optional human-readable name for the trainer client."
        ),
        pretrained_weights_path: Optional[str] = Field(
            None,
            description="Absolute path to a local model.pth file on this worker "
            "(from list_local_model_weights). When set, the trainer loads those weights "
            "on startup instead of starting from scratch.",
        ),
        owner_id: Optional[str] = Field(
            None,
            description="User ID of the caller creating this trainer. "
            "Stored for ownership-based deletion control.",
        ),
    ) -> str:
        """Start a new federated trainer application on this BioEngine worker."""
        # Start a new trainer application
        logger.info("Starting new federated trainer application...")
        trainer_env_vars: dict = {"ENABLE_FLASH_ATTENTION": "1"}
        if owner_id:
            trainer_env_vars["CHIRON_DEPLOYED_BY"] = owner_id
        trainer_kwargs: dict = {
            "datasets": datasets,
            "client_id": trainer_id,
            "client_name": trainer_name,
        }
        if pretrained_weights_path:
            trainer_kwargs["pretrained_weights_path"] = pretrained_weights_path
        application_id = await self.worker_service.deploy_app(
            artifact_id=trainer_artifact_id,
            application_kwargs={
                "TabulaTrainer": trainer_kwargs,
            },
            application_env_vars={"TabulaTrainer": trainer_env_vars},
            hypha_token=token,  # Trainer needs a token to access datasets
        )
        logger.info(f"Deployed federated trainer {application_id} (owner: {owner_id})")

        # Register the artifact ID so remove_trainer can validate it
        self.trainer_artifact_ids.add(trainer_artifact_id)

        # Cache dataset manifests for this trainer
        all_datasets = await self.bioengine_datasets.list_datasets()
        self._trainer_datasets[application_id] = {
            name: manifest
            for name, manifest in all_datasets.items()
            if name in datasets
        }

        return application_id

    @schema_method
    async def remove_trainer(
        self,
        application_id: str = Field(
            ..., description="Application ID of the federated trainer to be removed."
        ),
        force: bool = Field(
            False,
            description="Force removal even if the trainer is currently busy (in an active training session).",
        ),
        caller_id: Optional[str] = Field(
            None,
            description="User ID of the caller requesting deletion. "
            "Must match the owner who created the trainer, or be a worker admin.",
        ),
    ) -> None:
        """Stop a given federated trainer application on this BioEngine worker."""
        app_info, admin_users = await asyncio.gather(
            self._get_running_app_info(application_id),
            self._get_admin_users(),
        )

        if app_info.get("artifact_id") not in self.trainer_artifact_ids:
            raise ValueError(
                f"Application '{application_id}' belongs to artifact '{app_info.get('artifact_id')}', "
                f"which is not a known trainer artifact. "
                f"Known trainer artifacts: {self.trainer_artifact_ids}"
            )

        self._check_delete_permission(
            caller=caller_id,
            deployed_by=self._get_deployed_by(app_info),
            admin_users=admin_users,
        )

        if not force:
            sids = app_info.get("service_ids") or []
            if sids:
                is_busy = await self._check_app_busy(sids[0]["websocket_service_id"])
                if is_busy:
                    raise RuntimeError(
                        f"Trainer '{application_id}' is currently busy (in an active training session). "
                        "Pass force=True to remove it anyway."
                    )

        await self.worker_service.stop_app(application_id)
        self._trainer_datasets.pop(application_id, None)
        logger.info(f"Removed federated trainer with application ID: {application_id}")

    async def _get_zarr_files_info(self, dataset_id: str) -> List[dict]:
        """Discover zarr stores in a dataset and read their shape metadata from X/zarr.json."""
        try:
            all_files = await self.bioengine_datasets.list_files(dataset_id)
        except Exception as e:
            logger.warning(f"Could not list files for dataset '{dataset_id}': {e}")
            return []

        zarr_roots: set = set()
        for f in all_files:
            parts = Path(f).parts
            if parts and parts[0].endswith(".zarr"):
                zarr_roots.add(parts[0])

        zarr_infos = []
        for zarr_name in sorted(zarr_roots):
            info: dict = {"name": zarr_name}
            try:
                x_json_bytes = await self.bioengine_datasets.get_file(
                    dataset_id, f"{zarr_name}/X/zarr.json"
                )
                x_meta = json.loads(x_json_bytes)
                # AnnData zarr v3: shape is stored in attributes for sparse matrices
                shape = x_meta.get("attributes", {}).get("shape", [])
                if len(shape) >= 2:
                    info["n_samples"] = shape[0]
                    info["n_vars"] = shape[1]
            except Exception as e:
                logger.warning(
                    f"Could not read zarr metadata for '{zarr_name}' in dataset '{dataset_id}': {e}"
                )
            zarr_infos.append(info)

        return zarr_infos

    @schema_method
    async def get_datasets_info(self) -> Dict[str, dict]:
        """
        Get enriched dataset information including zarr file metadata.

        Returns dataset manifests enriched with a ``zarr_files`` list.
        Each entry in ``zarr_files`` has:
        - ``name``: zarr store filename (e.g. ``filter_129.zarr``)
        - ``n_samples``: number of cells (obs)
        - ``n_vars``: number of genes (var)
        """
        available_datasets = await self.bioengine_datasets.list_datasets()
        result: Dict[str, dict] = {}
        for dataset_id, manifest in available_datasets.items():
            entry = dict(manifest)
            zarr_files = await self._get_zarr_files_info(dataset_id)
            if zarr_files:
                entry["zarr_files"] = zarr_files
            result[dataset_id] = entry
        return result

    @schema_method
    async def list_local_model_weights(self) -> List[dict]:
        """List saved local model weight files available on this worker.

        Scans ~/.bioengine/models/ for checkpoints saved by save_local_model().
        Each entry includes the file path and training metadata (datasets, sample
        counts, timestamp) so the caller can pick which weights to load when
        deploying a new trainer via the pretrained_weights_path parameter.
        """
        app_home = Path(os.environ.get("HOME", os.path.expanduser("~")))
        if app_home.parent.name == "apps" and app_home.parent.parent.name == ".bioengine":
            bioengine_root = app_home.parent.parent
        else:
            bioengine_root = app_home / ".bioengine"
        models_dir = bioengine_root / "models"

        results: List[dict] = []
        if not models_dir.exists():
            return results

        for model_dir in sorted(models_dir.iterdir()):
            if not model_dir.is_dir():
                continue
            model_path = model_dir / "model.pth"
            if not model_path.exists():
                continue

            entry: dict = {
                "path": str(model_path),
                "client_name": model_dir.name,
                "saved_at": None,
                "description": None,
                "datasets": {},
                "train_samples": 0,
                "num_rounds": 0,
                "total_samples_seen": 0,
            }
            meta_path = model_dir / "metadata.json"
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text())
                    entry["client_name"] = meta.get("client_name", model_dir.name)
                    entry["saved_at"] = meta.get("saved_at")
                    entry["description"] = meta.get("description")
                    entry["datasets"] = meta.get("datasets", {})
                    entry["train_samples"] = meta.get("train_samples", 0)
                    history = meta.get("training_history", {})
                    train_loss = history.get("train_loss", [])
                    train_samples_hist = history.get("train_samples", [])
                    entry["num_rounds"] = len(train_loss)
                    entry["total_samples_seen"] = sum(v for _, v in train_samples_hist)
                except Exception:
                    pass
            results.append(entry)

        results.sort(key=lambda x: x.get("saved_at") or "", reverse=True)
        return results
