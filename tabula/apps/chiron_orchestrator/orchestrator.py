import asyncio
import io
import logging
import os
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple, Union

import flwr as fl
import numpy as np
from flwr.common import (
    Code,
    EvaluateIns,
    EvaluateRes,
    FitIns,
    FitRes,
    Parameters,
    Status,
    ndarrays_to_parameters,
    parameters_to_ndarrays,
)
from flwr.common.typing import Scalar
from flwr.server.client_manager import SimpleClientManager
from flwr.server.history import History as _FlwrHistory
from flwr.server.strategy import FedAvg
from hypha_rpc import connect_to_server
from hypha_rpc.rpc import RemoteService
from hypha_rpc.utils import ObjectProxy
from hypha_rpc.utils.schema import schema_method
from pydantic import Field
from ray import serve

logger = logging.getLogger("ray.serve")


# ---------------------------------------------------------------------------
# Client proxy helpers (inlined from tabula.distributed.federated_client_proxy
# and tabula.distributed.federated_client so that FL coordination logic
# changes only require an app upload, not a Docker image rebuild)
# ---------------------------------------------------------------------------


def weighted_average(metrics: List[Tuple[int, dict]]) -> Dict[str, float]:
    """Compute a weighted average of loss across clients by number of examples."""
    losses = [num_examples * m["loss"] for num_examples, m in metrics if "loss" in m]
    examples = [num_examples for num_examples, _ in metrics]
    return {"loss": sum(losses) / sum(examples)}


class FlowerClientProxy(fl.client.NumPyClient):
    """A Flower NumPyClient that communicates via Hypha RPC with async start/get result methods."""

    cid: str
    service: ObjectProxy
    artifact_id: str
    check_interval: float

    def __init__(
        self,
        service: ObjectProxy,
        artifact_id: str,
        check_interval: float = 10.0,
    ):
        self.service = service
        self.cid = self.service.id
        self.artifact_id = artifact_id
        self.check_interval = check_interval

    async def verify_artifact(self) -> None:
        """Verify that the remote service is of the correct trainer type."""
        client_properties = await self.service.get_properties()
        if client_properties["artifact_id"] != self.artifact_id:
            raise ValueError(
                f"Service '{self.service.id}' is not the correct trainer type. Expected artifact "
                f"ID '{self.artifact_id}', got '{client_properties['artifact_id']}'"
            )

    async def fit(
        self, parameters: List[Any], server_round: int, config: Dict[str, Any]
    ) -> Tuple[List[np.ndarray], int, Dict[str, float]]:
        """Send fit instructions to the remote client via Hypha RPC."""
        await self.service.start_fit(
            parameters=parameters, server_round=server_round, **config
        )
        while True:
            await asyncio.sleep(self.check_interval)
            fit_status = await self.service.get_fit_status()
            status = fit_status["status"]
            if status == "RUNNING":
                continue
            elif status == "COMPLETED":
                parameters, num_examples, metrics = fit_status["result"]
                return parameters, num_examples, metrics
            elif status == "FAILED":
                raise RuntimeError(f"Fit failed with error: {fit_status['message']}")
            elif status == "CANCELLED":
                raise RuntimeError("Fit was cancelled.")
            else:
                raise RuntimeError(f"Unexpected status: {status}")

    async def evaluate(
        self, parameters: List[Any], server_round: int, config: Dict[str, Any]
    ) -> Tuple[float, int, Dict[str, float]]:
        """Send evaluate instructions to the remote client via Hypha RPC polling."""
        await self.service.start_evaluate(
            parameters=parameters, server_round=server_round, **config
        )
        while True:
            await asyncio.sleep(self.check_interval)
            eval_status = await self.service.get_evaluate_status()
            status = eval_status["status"]
            if status in ("NOT_STARTED", "RUNNING"):
                continue
            elif status == "COMPLETED":
                loss, num_examples, metrics = eval_status["result"]
                return loss, num_examples, metrics
            elif status == "FAILED":
                raise RuntimeError(f"Evaluate failed: {eval_status['message']}")
            elif status == "CANCELLED":
                raise RuntimeError("Evaluate was cancelled.")
            else:
                raise RuntimeError(f"Unexpected status: {status}")

    async def cancel_fit(self, orchestrator_service_id: str) -> Dict[str, str]:
        """Cancel the ongoing fit task on the remote client."""
        return await self.service.cancel_fit(orchestrator_service_id=orchestrator_service_id)

    async def cancel_evaluate(self, orchestrator_service_id: str) -> Dict[str, str]:
        """Cancel the ongoing evaluate task on the remote client."""
        return await self.service.cancel_evaluate(orchestrator_service_id=orchestrator_service_id)

    async def get_status(self, stage: Literal["fit", "evaluate"]) -> Dict[str, Any]:
        """Get the current progress of the fit or evaluate task."""
        if stage == "fit":
            status = await self.service.get_fit_status()
        elif stage == "evaluate":
            status = await self.service.get_evaluate_status()
        else:
            raise ValueError(f"Unknown stage '{stage}'. Must be 'fit' or 'evaluate'.")
        return {
            "status": status["status"],
            "message": status["message"],
            "current_batch": status["current_batch"],
            "total_batches": status["total_batches"],
            "progress": status["progress"],
        }

    async def get_parameters(self, config: Dict[str, Any]) -> List[np.ndarray]:
        """Return the current local model parameters."""
        return await self.service.get_parameters()

    async def load_pretrained_weights(
        self, artifact_id: str, file_path: str, timeout: int = 300
    ) -> None:
        """Load pretrained weights from a specified artifact and file path."""
        await self.service.load_pretrained_weights(
            artifact_id=artifact_id, file_path=file_path, timeout=timeout
        )

    async def save_model_weights(
        self,
        description: Optional[str] = None,
        upload_timeout: int = 300,
    ) -> str:
        """Save the last model checkpoint as a Hypha artifact and return the artifact ID."""
        return await self.service.save_model_weights(
            description=description, upload_timeout=upload_timeout
        )

    async def get_transformer_keys(self) -> List[str]:
        """Return the ordered list of transformer state_dict keys from the trainer."""
        return await self.service.get_transformer_keys()



class History(_FlwrHistory):
    """Extended History class for per-client metrics collection."""

    def __init__(self) -> None:
        super().__init__()
        self.client_metrics_fit: dict[str, dict[str, list[tuple[int, Scalar]]]] = {}
        self.client_metrics_evaluate: dict[str, dict[str, list[tuple[int, Scalar]]]] = {}

    def add_client_metrics_fit(
        self,
        server_round: int,
        results: List[Tuple[FlowerClientProxy, FitRes]],
    ) -> None:
        """Add one loss entry (from distributed fit)."""
        for client, fit_res in results:
            if client.cid not in self.client_metrics_fit:
                self.client_metrics_fit[client.cid] = {}
            for key, value in fit_res.metrics.items():
                if key not in self.client_metrics_fit[client.cid]:
                    self.client_metrics_fit[client.cid][key] = []
                self.client_metrics_fit[client.cid][key].append((server_round, value))

    def add_client_metrics_evaluate(
        self,
        server_round: int,
        results: List[Tuple[FlowerClientProxy, EvaluateRes]],
    ) -> None:
        """Add one loss entry (from distributed evaluation)."""
        for client, eval_res in results:
            if client.cid not in self.client_metrics_evaluate:
                self.client_metrics_evaluate[client.cid] = {}
            for key, value in eval_res.metrics.items():
                if key not in self.client_metrics_evaluate[client.cid]:
                    self.client_metrics_evaluate[client.cid][key] = []
                self.client_metrics_evaluate[client.cid][key].append(
                    (server_round, value)
                )

    def clean_incomplete_round(self, incompleted_round: int) -> None:
        """Remove all entries from an incompleted round."""

        def _clean_list(data: List[Tuple[int, float]]):
            return [entry for entry in data if entry[0] < incompleted_round]

        def _clean_dict(data: Dict[str, List[Tuple[int, float]]]):
            return {
                key: [entry for entry in values if entry[0] < incompleted_round]
                for key, values in data.items()
            }

        self.losses_distributed = _clean_list(self.losses_distributed)
        self.losses_centralized = _clean_list(self.losses_centralized)
        self.metrics_distributed_fit = _clean_dict(self.metrics_distributed_fit)
        self.metrics_distributed = _clean_dict(self.metrics_distributed)
        self.metrics_centralized = _clean_dict(self.metrics_centralized)

        for client_id in self.client_metrics_fit:
            self.client_metrics_fit[client_id] = _clean_dict(
                self.client_metrics_fit[client_id]
            )
        for client_id in self.client_metrics_evaluate:
            self.client_metrics_evaluate[client_id] = _clean_dict(
                self.client_metrics_evaluate[client_id]
            )


async def fit_clients(
    sampled_clients: List[Tuple[FlowerClientProxy, FitIns]],
    global_parameters: Parameters,
    server_round: int,
    timeout: int,
    orchestrator_service_id: str = "",
) -> Tuple[
    List[Tuple[FlowerClientProxy, FitRes]],
    List[BaseException],
]:
    """Send fit instructions to sampled clients concurrently and collect FitRes.

    All clients run in parallel. After ``timeout`` seconds any client that has
    not yet returned is considered timed-out: its local asyncio Task is
    cancelled and ``cancel_fit()`` is sent to the remote trainer so it stops
    consuming GPU resources. The round then continues with whatever results
    arrived in time.
    """
    current_parameters = parameters_to_ndarrays(global_parameters)

    async def run_fit(client: FlowerClientProxy, fit_ins: FitIns):
        try:
            logger.info(f"Starting fit for client {client.cid}")
            tensors, num_examples, metrics = await client.fit(
                current_parameters, server_round, fit_ins.config
            )
            logger.info(
                f"Completed fit for client {client.cid}: {num_examples} examples, metrics={metrics}"
            )
            return (
                client,
                FitRes(
                    status=Status(code=Code.OK, message="Success"),
                    parameters=ndarrays_to_parameters(tensors),
                    num_examples=num_examples,
                    metrics=metrics,
                ),
            )
        except Exception as e:
            logger.error(f"Error during fit with client {client.cid}: {e}")
            return e

    task_to_client: Dict[asyncio.Task, FlowerClientProxy] = {
        asyncio.create_task(run_fit(client, fit_ins)): client
        for client, fit_ins in sampled_clients
    }
    logger.info(f"Running fit on {len(task_to_client)} clients concurrently (timeout={timeout}s)")

    done, pending = await asyncio.wait(task_to_client.keys(), timeout=timeout)

    results: List[Tuple[FlowerClientProxy, FitRes]] = []
    failures: List[BaseException] = []

    for task in done:
        rox = task.result()
        if isinstance(rox, tuple):
            results.append(rox)
        elif isinstance(rox, Exception):
            failures.append(rox)
        else:
            failures.append(ValueError(f"Unexpected result type: {type(rox)}"))

    if pending:
        logger.warning(
            f"{len(pending)} client(s) did not complete fit within {timeout}s — "
            "cancelling and continuing with clients that finished."
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(
            *[task_to_client[task].cancel_fit(orchestrator_service_id) for task in pending],
            return_exceptions=True,
        )
        for task in pending:
            client = task_to_client[task]
            failures.append(
                TimeoutError(f"Client {client.cid} did not complete fit within {timeout}s")
            )

    logger.info(f"Fit completed: {len(results)} successes, {len(failures)} failures")
    return results, failures


async def evaluate_clients(
    eval_clients: List[Tuple[FlowerClientProxy, EvaluateIns]],
    global_parameters: Parameters,
    server_round: int,
    timeout: int,
    orchestrator_service_id: str = "",
) -> Tuple[
    List[Tuple[FlowerClientProxy, EvaluateRes]],
    List[BaseException],
]:
    """Send evaluate instructions to clients concurrently and collect EvaluateRes.

    Same timeout semantics as ``fit_clients``: clients that do not finish
    within ``timeout`` seconds are cancelled and ``cancel_evaluate()`` is sent
    to the remote trainer.
    """
    current_parameters = parameters_to_ndarrays(global_parameters)

    async def run_evaluate(client: FlowerClientProxy, eval_ins: EvaluateIns):
        if client is None:
            return ValueError("Client is None")
        try:
            logger.info(f"Starting evaluate for client {client.cid}")
            loss, num_examples, metrics = await client.evaluate(
                current_parameters, server_round, eval_ins.config
            )
            logger.info(
                f"Completed evaluate for client {client.cid}: loss={loss}, {num_examples} examples, metrics={metrics}"
            )
            return (
                client,
                EvaluateRes(
                    status=Status(code=Code.OK, message="Success"),
                    loss=loss,
                    num_examples=num_examples,
                    metrics=metrics,
                ),
            )
        except Exception as e:
            logger.error(f"Error during evaluate with client {client.cid}: {e}")
            return e

    task_to_client: Dict[asyncio.Task, FlowerClientProxy] = {
        asyncio.create_task(run_evaluate(client, eval_ins)): client
        for client, eval_ins in eval_clients
    }
    logger.info(f"Running evaluate on {len(task_to_client)} clients concurrently (timeout={timeout}s)")

    done, pending = await asyncio.wait(task_to_client.keys(), timeout=timeout)

    results: List[Tuple[FlowerClientProxy, EvaluateRes]] = []
    failures: List[BaseException] = []

    for task in done:
        rox = task.result()
        if isinstance(rox, tuple):
            results.append(rox)
        elif isinstance(rox, Exception):
            failures.append(rox)
        else:
            failures.append(ValueError(f"Unexpected result type: {type(rox)}"))

    if pending:
        logger.warning(
            f"{len(pending)} client(s) did not complete evaluate within {timeout}s — "
            "cancelling and continuing with clients that finished."
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(
            *[task_to_client[task].cancel_evaluate(orchestrator_service_id) for task in pending],
            return_exceptions=True,
        )
        for task in pending:
            client = task_to_client[task]
            failures.append(
                TimeoutError(f"Client {client.cid} did not complete evaluate within {timeout}s")
            )

    logger.info(f"Evaluate completed: {len(results)} successes, {len(failures)} failures")
    return results, failures


@serve.deployment(
    ray_actor_options={
        "num_cpus": 1,
        "num_gpus": 0,
        "memory": 8 * 1024 * 1024 * 1024,  # 8GB RAM limit
        "runtime_env": {
            "pip": ["flwr==1.22.0", "httpx==0.27.0", "torch==1.13.1"],
        },
    },
    max_ongoing_requests=5,
    max_queued_requests=10,
    health_check_period_s=30.0,
    health_check_timeout_s=30.0,
    graceful_shutdown_timeout_s=300.0,
    graceful_shutdown_wait_loop_s=2.0,
)
class FederatedTrainingOrchestrator:
    def __init__(
        self,
        trainer_artifact_id: str = "chiron-platform/tabula-trainer",  # Decides the type of model used
    ) -> None:
        """Orchestrator for Federated Learning"""
        # Set artifact ID for trainer application; only allows trainers with this artifact ID to join
        self.trainer_artifact_id: str = trainer_artifact_id

        # Initialize flwr server and strategy
        self.client_manager = SimpleClientManager()
        self.strategy: FedAvg = None

        # Training progress tracking
        self.history = History()
        self.global_parameters: Parameters = None
        self.training_task: asyncio.Task = None
        self.current_round: int = 0  # Set to 0 initially, first round will be 1
        self.target_round: int = 0  # The highest round number we're aiming to reach
        self.current_stage: Literal["fit", "evaluate", None] = None
        self.selected_fit_clients: List[FlowerClientProxy] = (
            []
        )  # List of clients currently in fit stage
        self.selected_evaluate_clients: List[FlowerClientProxy] = (
            []
        )  # List of clients currently in evaluate stage

        # Hypha server connection info
        self._server_url: str = os.getenv("HYPHA_SERVER_URL")
        if not self._server_url:
            raise ValueError("HYPHA_SERVER_URL environment variable is not set.")
        self._hypha_token: str = os.getenv("HYPHA_TOKEN")
        if not self._hypha_token:
            raise ValueError("HYPHA_TOKEN environment variable is not set.")
        self.hypha_client: RemoteService = None

        # Own service ID — set when first trainer is added; used for trainer validation
        self._service_id: Optional[str] = None

        # Transformer key names — fetched once from any registered client and cached.
        # The keys are fixed for a given model architecture and never change at runtime.
        self._transformer_keys: Optional[List[str]] = None

        # Trainer properties keyed by service ID — fetched on add_trainer and used in
        # save_global_weights to build the dataset summary and training history artifact.
        self._trainer_properties: Dict[str, dict] = {}

        # Trainer liveness tracking — ping each registered trainer every 60 s when idle.
        self._trainer_ping_fails: Dict[str, int] = {}
        self._trainer_ping_task: Optional[asyncio.Task] = None

    # === BioEngine App Method - will be called when the deployment is started ===

    async def async_init(self):
        self.hypha_client = await connect_to_server(
            {
                "server_url": self._server_url,
                "token": self._hypha_token,
            }
        )
        logger.info(f"Connected to Hypha Server at {self._server_url}")
        self._start_trainer_ping_loop()

    async def test_deployment(self):
        pass

    # === Ray Serve Health Check Method - will be called periodically to check the health of the deployment ===

    def _start_trainer_ping_loop(self) -> None:
        """Start a background task that pings each registered trainer every 60 s.

        Trainers that fail to respond 3 times in a row are silently removed from the
        client_manager. The loop pauses during active training — the FL loop already
        handles unreachable trainers via fit/evaluate timeouts.
        """
        if self._trainer_ping_task is not None and not self._trainer_ping_task.done():
            return

        async def _ping_loop() -> None:
            _ping_interval = 120
            _max_fails = 5
            while True:
                await asyncio.sleep(_ping_interval)
                # Skip while training is active — the FL loop handles failures itself.
                if self.training_task is not None and not self.training_task.done():
                    continue

                client_ids = list(self.client_manager.clients.keys())
                for cid in client_ids:
                    try:
                        svc = await asyncio.wait_for(
                            self.hypha_client.get_service(cid), timeout=10.0
                        )
                        await asyncio.wait_for(svc.ping(), timeout=10.0)
                        self._trainer_ping_fails[cid] = 0
                    except Exception as e:
                        fails = self._trainer_ping_fails.get(cid, 0) + 1
                        self._trainer_ping_fails[cid] = fails
                        logger.warning(
                            f"Trainer ping failed for '{cid}' ({fails}/{_max_fails}): {e}"
                        )
                        if fails >= _max_fails:
                            logger.warning(
                                f"Trainer '{cid}' unreachable after {_max_fails} consecutive "
                                f"pings (~{_max_fails * _ping_interval // 60} min) — removing from registered trainers."
                            )
                            client = self.client_manager.clients.get(cid)
                            if client is not None:
                                self.client_manager.unregister(client)
                            self._trainer_ping_fails.pop(cid, None)
                            self._trainer_properties.pop(cid, None)

        self._trainer_ping_task = asyncio.create_task(_ping_loop())

    async def check_health(self) -> None:
        # Test connection to the Hypha server
        await self.hypha_client.echo("ping")

    # === Internal Helper Methods ===

    def _read_schema(
        self, schema: dict, exclude: List[str] = ["parameters"]
    ) -> Dict[str, Any]:
        parameters = {
            "standard": {},
            "advanced": {},
        }
        properties = schema["parameters"]["properties"]
        for param_name, param in properties.items():
            if param_name in exclude:
                continue
            param_type = param.get("type", "str")
            default = param.get("default", "")
            description = param.get("description", "")

            if description.lower().startswith("advanced:"):
                parameters["advanced"][param_name] = {
                    "type": param_type,
                    "default": default,
                    "description": description[9:].strip(),
                }
            elif description.lower().startswith("internal:"):
                # Do not show internal parameters
                pass
            else:
                parameters["standard"][param_name] = {
                    "type": param_type,
                    "default": default,
                    "description": description.strip(),
                }
        return parameters

    async def _get_initial_parameters(
        self, initial_weights: Dict[str, str] | None
    ) -> Parameters:
        """
        Get initial parameters from one of the available clients.

        Returns:
            Parameters: The initial global parameters for the federated learning process.
        """
        # Server-side parameter initialization (not used in this case)
        parameters: Optional[Parameters] = self.strategy.initialize_parameters(
            client_manager=self.client_manager
        )
        if parameters is not None:
            logger.info("Using initial global parameters provided by strategy")
            return parameters

        # Set initial parameters, either randomly or from specified pretrained weights
        if initial_weights is not None:
            logger.info(
                f"Setting pretrained weights on all trainers: {initial_weights}"
            )
            # This sets the weights for embedder, tabular transformer and project head on all clients
            tasks = [
                client.load_pretrained_weights(**initial_weights)
                for client in self.client_manager.clients.values()
            ]
            await asyncio.gather(*tasks)

        # Get transformer weights from a random client
        logger.info("Requesting initial parameters from a random client")
        random_client = self.client_manager.sample(1)[0]

        parameters = await random_client.get_parameters({})
        parameters_proto = ndarrays_to_parameters(parameters)
        return parameters_proto

    async def _training_round(
        self, server_round: int, timeout: int
    ) -> Parameters:
        """Run a single training round."""
        # 1) Configure Fit: sample clients
        sampled_clients = self.strategy.configure_fit(
            server_round=server_round,
            parameters=self.global_parameters,
            client_manager=self.client_manager,
        )
        if not sampled_clients:
            logger.info(
                f"Stopping training after round {server_round} due to no clients selected."
            )
            raise RuntimeError("No clients selected for training.")

        logger.info(f"\n[ROUND {server_round}]")

        self.selected_fit_clients = [client for client, _ in sampled_clients]
        self.current_stage = "fit"
        logger.info(
            f"Selected {len(sampled_clients)} clients for training round #{server_round}."
        )

        # 2) Send FitIns and collect FitRes
        fit_results, fit_failures = await fit_clients(
            sampled_clients=sampled_clients,
            global_parameters=self.global_parameters,
            server_round=server_round,
            timeout=timeout,
            orchestrator_service_id=self._service_id or "",
        )

        # 3) Collect per client metrics and add to history
        self.history.add_client_metrics_fit(
            server_round=server_round,
            results=fit_results,
        )

        # 4) Aggregate FitRes to update global parameters
        self.current_stage = "aggregation"
        new_parameters, fit_metrics = self.strategy.aggregate_fit(
            server_round, fit_results, fit_failures
        )

        if new_parameters is not None:
            # At least `min_fit_clients=1` client completed training successfully
            logger.info(
                f"Aggregated new global parameters for round {server_round}, {fit_metrics}."
            )
            self.history.add_metrics_distributed_fit(
                server_round=server_round, metrics=fit_metrics
            )
        else:
            # Less than `min_fit_clients` clients completed training successfully
            # This happens if all clients failed or were cancelled
            raise RuntimeError(
                "No clients completed training successfully. "
                f"Global parameters remain unchanged after round {server_round}."
            )

        # 5) Configure Evaluate: sample clients (can be same or different)
        self.current_stage = "distribution"
        eval_clients = self.strategy.configure_evaluate(
            server_round=server_round,
            parameters=self.global_parameters,
            client_manager=self.client_manager,
        )
        if not eval_clients:
            logger.warning("No clients selected for evaluation.")

            return new_parameters

        self.selected_evaluate_clients = [client for client, _ in eval_clients]
        self.current_stage = "evaluate"
        logger.info(f"Selected {len(eval_clients)} clients for evaluation.")

        # 6) Send EvaluateIns and collect EvaluateRes
        eval_results, eval_failures = await evaluate_clients(
            eval_clients=eval_clients,
            global_parameters=self.global_parameters,
            server_round=server_round,
            timeout=timeout,
            orchestrator_service_id=self._service_id or "",
        )

        # 7) Collect per client metrics and add to history
        self.history.add_client_metrics_evaluate(
            server_round=server_round,
            results=eval_results,
        )

        # 8) Aggregate EvaluateRes
        eval_loss, eval_metrics = self.strategy.aggregate_evaluate(
            server_round, eval_results, eval_failures
        )

        if eval_loss is not None:
            logger.info(
                f"Round {server_round} evaluation - Validation Loss: {eval_loss}, Metrics: {eval_metrics}"
            )
            self.history.add_loss_distributed(
                server_round=server_round, loss=eval_loss
            )  # Same as in metrics
            self.history.add_metrics_distributed(
                server_round=server_round, metrics=eval_metrics
            )

        return new_parameters

    async def _run_federated_training(
        self, num_rounds: int, initial_weights: Dict[str, str] | None, timeout: int
    ):
        """Run federated training for a specified number of rounds."""

        start_time = time.time()
        try:
            if self.global_parameters is None:
                logger.info("Initializing global parameters")
                self.global_parameters = await self._get_initial_parameters(
                    initial_weights=initial_weights
                )

            # Main federated learning loop - continue from where we left off
            start_round = self.current_round + 1
            self.target_round = self.current_round + num_rounds

            logger.info(
                f"Starting federated training from round {start_round} to {self.target_round}"
            )
            for _ in range(num_rounds):
                self.current_round += 1

                new_parameters = await self._training_round(
                    server_round=self.current_round, timeout=timeout
                )
                logger.info(
                    f"Round {self.current_round} completed successfully. "
                    f"Progress: {self.current_round}/{self.target_round}"
                )
                self.global_parameters = new_parameters

        # Do not update the global parameters if the round did not complete

        except asyncio.CancelledError:
            logger.info(
                f"Federated training was cancelled at round {self.current_round}."
            )
            logger.info("Cleaning up incomplete training round data.")
            # Clean up history for the incomplete round
            self.history.clean_incomplete_round(incompleted_round=self.current_round)
            # Roll back to last completed round
            self.current_round -= 1
            raise

        except Exception as e:
            logger.error(
                f"Ending training due to error in round {self.current_round}: {e}"
            )
            logger.info("Cleaning up incomplete training round data.")
            # Clean up history for the incomplete round
            self.history.clean_incomplete_round(incompleted_round=self.current_round)
            # Roll back to last completed round
            self.current_round -= 1
            raise

        finally:
            elapsed_time = time.time() - start_time
            logger.info(
                f"\nFederated training run ended after {elapsed_time:.2f} seconds."
            )

            self.current_stage = None
            self.training_task = None

            # Notify all registered trainers that the session has ended.
            # Schedule in a new task so CancelledError from stop_training() cannot
            # interrupt these notifications.
            _client_ids = [c.cid for c in self.client_manager.clients.values()]
            _orch_id = self._service_id or ""
            if _client_ids:
                async def _clear_session(service_ids=_client_ids, orch_id=_orch_id):
                    async def _set_inactive(service_id: str) -> None:
                        try:
                            svc = await self.hypha_client.get_service(service_id)
                            await svc.set_session_active(False, orch_id)
                        except Exception as e:
                            logger.warning(f"Could not clear session_active on {service_id}: {e}")
                    await asyncio.gather(
                        *[_set_inactive(sid) for sid in service_ids],
                        return_exceptions=True,
                    )
                asyncio.create_task(_clear_session())

    # === Exposed BioEngine App Methods - all methods decorated with @schema_method will be exposed as API endpoints ===
    # Note: Parameter type hints and docstrings will be used to generate the API documentation.

    @schema_method
    async def ping(self) -> bool:
        """Heartbeat endpoint polled by registered trainers to confirm orchestrator liveness."""
        return True

    @schema_method
    async def add_trainer(
        self,
        service_id: str = Field(
            ..., description="Full service ID of the Federated Trainer"
        ),
        orchestrator_service_id: str = Field(
            ...,
            description="Service ID of this orchestrator, passed to the trainer so it can validate future calls.",
        ),
    ) -> None:
        """Add a Trainer to the federated training using its Hypha service ID."""
        if "/" not in service_id:
            raise ValueError("Service ID must be in the format 'workspace/service'")

        # Store own service ID so it can be passed in all subsequent trainer calls
        self._service_id = orchestrator_service_id

        already_registered = any(
            client_id == service_id for client_id in self.client_manager.clients.keys()
        )

        # Get Trainer service
        # TODO: later change to web_rtc
        trainer_service = await self.hypha_client.get_service(service_id)

        if not already_registered:
            # Create and register Flower client proxy
            client_proxy = FlowerClientProxy(
                service=trainer_service,
                artifact_id=self.trainer_artifact_id,
                check_interval=10.0,
            )
            await client_proxy.verify_artifact()
            self.client_manager.register(client_proxy)

            # Cache transformer key names from the first registered client.
            # Keys are architecture-fixed and identical across all trainers of the same type.
            if self._transformer_keys is None:
                try:
                    self._transformer_keys = await trainer_service.get_transformer_keys()
                    logger.info(f"Cached {len(self._transformer_keys)} transformer key names from '{service_id}'")
                except Exception as e:
                    logger.warning(f"Could not fetch transformer keys from '{service_id}': {e}")

        # Always refresh cached properties and re-register to handle post-training re-add.
        try:
            self._trainer_properties[service_id] = await trainer_service.get_properties()
        except Exception as e:
            logger.warning(f"Could not fetch properties from '{service_id}': {e}")

        # Reset ping-fail counter so a freshly added trainer starts with a clean slate.
        self._trainer_ping_fails[service_id] = 0

        # Mark the trainer as registered to this orchestrator (always, even on re-add)
        await trainer_service.register_to_orchestrator(orchestrator_service_id)

    @schema_method
    async def remove_trainer(
        self,
        service_id: str = Field(
            ..., description="Full service ID of the Federated Trainer"
        ),
    ):
        """Remove a Trainer from the federated training using its Hypha service ID."""
        # Find the client with matching service_id and unregister it
        client = self.client_manager.clients.get(service_id)
        if client is None:
            raise ValueError(f"Client with service ID '{service_id}' not found")

        self.client_manager.unregister(client)
        self._trainer_ping_fails.pop(service_id, None)
        self._trainer_properties.pop(service_id, None)

        # Clear trainer registration
        try:
            svc = await self.hypha_client.get_service(service_id)
            await svc.unregister_from_orchestrator()
        except Exception as e:
            logger.warning(f"Could not unregister trainer '{service_id}': {e}")

    @schema_method
    async def list_trainers(self) -> List[str]:
        """Get a list of all registered client service IDs."""
        return [client.cid for client in self.client_manager.clients.values()]

    @schema_method
    async def get_trainer_params(self):
        """Get training and evaluation parameters for the federated training."""
        if len(self.client_manager) == 0:
            raise RuntimeError("No clients registered for federated training.")

        sample_client = next(iter(self.client_manager.clients.values()))
        service = sample_client.service

        return {
            "fit": self._read_schema(service["start_fit"].__schema__),
            "evaluate": self._read_schema(service["start_evaluate"].__schema__),
        }

    @schema_method
    async def reset_training_state(self) -> None:
        """Reset the orchestrator's training state (history, global parameters, round counters).

        Trainers do not need to be reset here — start_fit resets all per-round state
        (fit/evaluate status, progress counters) at the start of every call. The only
        trainer-side bookkeeping not auto-reset (training_history, model_upload_artifact_id)
        is handled by load_pretrained_weights when initial_weights are provided.
        """
        await self.stop_training()

        self.history = History()
        self.global_parameters = None
        self.current_stage = None
        self.current_round = 0
        self.target_round = 0
        self.selected_fit_clients = []
        self.selected_evaluate_clients = []

    @schema_method
    async def start_training(
        self,
        num_rounds: int = Field(
            ...,
            description="Number of federated learning rounds to perform.",
        ),
        fit_config: Optional[Dict[str, Any]] = Field(
            None,
            description="Configuration parameters for the training (fit) phase.",
        ),
        eval_config: Optional[Dict[str, Any]] = Field(
            None,
            description="Configuration parameters for the evaluation phase.",
        ),
        initial_weights: Optional[Dict[str, str]] = Field(
            None,
            description="Initial weights for the global model, specified as a mapping from client IDs to weight URLs.",
            examples=[
                {
                    "artifact_id": "chiron-platform/tabula-pretrained-weights",
                    "file_path": "avg.pth",
                },
                {
                    "artifact_id": "chiron-platform/previous-training-artifact",
                    "file_path": "round_25/model_weights-round=25.pth",
                },
            ],
        ),
        per_round_timeout: int = Field(
            300,
            description="Timeout in seconds for each training round. If a round exceeds this time, it will be aborted.",
        ),
    ) -> None:
        """Start the federated training with all registered clients."""
        if len(self.client_manager) == 0:
            raise RuntimeError(
                "No clients available for federated training. Please add clients first."
            )

        if self.training_task is not None and not self.training_task.done():
            raise RuntimeError(
                "Federated training is already in progress. Call stop_training() "
                "first before starting a new training session."
            )

        if self._service_id is None:
            raise RuntimeError(
                "Orchestrator service ID is not set. Add at least one trainer via add_trainer() before starting training."
            )

        _orch_id = self._service_id

        self.strategy = FedAvg(
            fraction_fit=1.0,  # Use all available clients for training
            fraction_evaluate=1.0,  # Use all available clients for evaluation
            min_fit_clients=1,  # Minimum number of clients to train
            min_evaluate_clients=1,  # Minimum number of clients to evaluate
            min_available_clients=1,  # Minimum number of available clients
            on_fit_config_fn=lambda server_round: {**(fit_config or {}), "orchestrator_service_id": _orch_id},
            on_evaluate_config_fn=lambda server_round: {**(eval_config or {}), "orchestrator_service_id": _orch_id},
            initial_parameters=None,  # Will be set at start of training
            evaluate_metrics_aggregation_fn=weighted_average,
            fit_metrics_aggregation_fn=weighted_average,
        )

        if initial_weights is not None:
            # Reset training state if initial weights are provided
            await self.reset_training_state()

        # Notify all registered trainers that a session is starting.
        # Pass per_round_timeout so trainers can auto-clear session_active if
        # the orchestrator crashes before sending set_session_active(False).
        async def _set_active(service_id: str, active: bool) -> None:
            try:
                svc = await self.hypha_client.get_service(service_id)
                await svc.set_session_active(
                    active,
                    _orch_id,
                    per_round_timeout if active else None,
                )
            except Exception as e:
                logger.warning(f"Could not set session_active={active} on {service_id}: {e}")

        await asyncio.gather(
            *[_set_active(client.cid, True) for client in self.client_manager.clients.values()],
            return_exceptions=True,
        )

        self.training_task = asyncio.create_task(
            self._run_federated_training(
                num_rounds, initial_weights, per_round_timeout
            ),
            name="FederatedTraining",
        )

    @schema_method
    async def stop_training(self) -> None:
        """Stop the current federated training process and cancel all ongoing trainer tasks."""
        # Cancel ongoing fit/evaluate tasks on all active trainers
        cancellation_tasks = []

        _orch_id = self._service_id or ""

        # Cancel fit tasks
        if self.current_stage == "fit":
            for client in self.selected_fit_clients:
                try:
                    cancellation_tasks.append(client.cancel_fit(_orch_id))
                except Exception as e:
                    logger.info(f"Error cancelling fit for client {client.cid}: {e}")

        # Cancel evaluate tasks
        if self.current_stage == "evaluate":
            for client in self.selected_evaluate_clients:
                try:
                    cancellation_tasks.append(client.cancel_evaluate(_orch_id))
                except Exception as e:
                    logger.info(
                        f"Error cancelling evaluate for client {client.cid}: {e}"
                    )

        # Wait for all cancellation requests to complete
        if cancellation_tasks:
            await asyncio.gather(*cancellation_tasks, return_exceptions=True)

        # Cancel the training task
        if self.training_task:
            self.training_task.cancel()
            try:
                await self.training_task
            except asyncio.CancelledError:
                pass
            except Exception:
                raise
            finally:
                self.training_task = None

    @schema_method
    async def get_training_status(self) -> Dict[str, Any]:
        """Check if federated training is currently running and get progress from all trainers."""
        is_running = self.training_task is not None and not self.training_task.done()

        trainers_progress = {}

        if self.current_stage:
            if self.current_stage in ("fit", "evaluate"):
                # Get live progress from active trainers
                selected_clients = (
                    self.selected_fit_clients
                    if self.current_stage == "fit"
                    else self.selected_evaluate_clients
                )
                if selected_clients:
                    progress_tasks = [
                        client.get_status(stage=self.current_stage)
                        for client in selected_clients
                    ]
                    progress_results = await asyncio.gather(
                        *progress_tasks, return_exceptions=True
                    )
                    for client, progress in zip(selected_clients, progress_results):
                        if isinstance(progress, Exception):
                            trainers_progress[client.cid] = {
                                "error": str(progress),
                                "progress": 0.0,
                                "current_batch": 0,
                                "total_batches": 0,
                            }
                        else:
                            trainers_progress[client.cid] = progress
            else:
                # aggregation / distribution: orchestrator is working, no trainer progress to poll.
                # Still include client IDs so the UI can draw connection lines.
                for client in self.selected_fit_clients:
                    trainers_progress[client.cid] = {
                        "progress": 1.0,
                        "current_batch": 0,
                        "total_batches": 0,
                    }

        return {
            "is_running": is_running,
            "current_training_round": self.current_round,
            "target_round": self.target_round,
            "stage": self.current_stage,  # "fit" or "evaluate" or None
            "trainers_progress": trainers_progress,
        }

    @schema_method
    async def get_training_history(self) -> Dict[str, List[float]]:
        """Get the history of training losses and metrics."""
        if self.history is None:
            return {
                "training_losses": [],
                "validation_losses": [],
                "client_training_losses": {},
                "client_validation_losses": {},
            }
        return {
            "training_losses": self.history.metrics_distributed_fit.get("loss", []),
            "validation_losses": self.history.metrics_distributed.get("loss", []),
            "client_training_losses": {
                client_id: metrics.get("loss", [])
                for client_id, metrics in self.history.client_metrics_fit.items()
            },
            "client_validation_losses": {
                client_id: metrics.get("loss", [])
                for client_id, metrics in self.history.client_metrics_evaluate.items()
            },
        }

    @schema_method
    async def is_busy(self) -> bool:
        """Check if federated training is currently running."""
        return self.training_task is not None and not self.training_task.done()

    @schema_method
    async def save_model_weights(
        self,
        client_ids: Optional[Union[str, List[str]]] = Field(
            None,
            description="'all' (or None) to save all registered trainers, or a list of specific service IDs.",
        ),
        description: Optional[str] = Field(
            None,
            description="Optional description for the saved model artifacts.",
        ),
    ) -> Dict[str, str]:
        """Save the full local model (embedder + transformer + projection heads) for each trainer.

        Uses the registered clients in client_manager, so it works correctly even after
        reset_training_state (which only clears the orchestrator's history, not the client list).
        """
        all_clients = list(self.client_manager.clients.values())

        if client_ids is None or (isinstance(client_ids, str) and client_ids.lower() == "all"):
            clients = all_clients
        elif isinstance(client_ids, list):
            id_set = set(client_ids)
            clients = [c for c in all_clients if c.cid in id_set]
        else:
            raise ValueError("client_ids must be None, 'all', or a list of service IDs.")

        if not clients:
            raise RuntimeError(
                "No matching registered trainers found. Register trainers before saving."
            )

        results = await asyncio.gather(
            *[client.save_model_weights(description=description, upload_timeout=300)
              for client in clients],
            return_exceptions=True,
        )
        artifact_ids = {}
        for client, result in zip(clients, results):
            if isinstance(result, Exception):
                logger.error(f"Error saving model weights for client {client.cid}: {result}")
                artifact_ids[client.cid] = f"ERROR: {str(result)}"
            else:
                artifact_ids[client.cid] = result
        return artifact_ids

    @schema_method
    async def save_global_weights(
        self,
        description: Optional[str] = Field(
            None,
            description="Optional description for the saved global model artifact.",
        ),
        upload_timeout: int = Field(
            300,
            description="Timeout in seconds for uploading the checkpoint file.",
        ),
    ) -> str:
        """Save the aggregated transformer weights plus training history as a new artifact.

        Creates one artifact per call in the pretrained-weights collection. Each artifact
        contains the transformer state_dict and a training_history.json with per-round
        average losses and per-trainer dataset/loss information.

        The artifact can be used as initial_weights for any future training run.
        Returns the artifact ID.
        """
        import datetime
        import httpx
        import json as json_module
        import torch

        if self.global_parameters is None:
            raise RuntimeError(
                "No global parameters available. Run at least one training round first."
            )

        # ── transformer weights ──────────────────────────────────────────────────
        ndarrays = parameters_to_ndarrays(self.global_parameters)

        keys = self._transformer_keys
        if keys is None:
            if not self.client_manager.clients:
                raise RuntimeError(
                    "Transformer key names are not cached and no clients are registered. "
                    "Re-register at least one trainer."
                )
            random_client = next(iter(self.client_manager.clients.values()))
            keys = await random_client.get_transformer_keys()
            self._transformer_keys = keys

        if len(keys) != len(ndarrays):
            raise RuntimeError(
                f"Key count ({len(keys)}) does not match parameter count ({len(ndarrays)})."
            )

        state_dict = OrderedDict({k: torch.tensor(v) for k, v in zip(keys, ndarrays)})
        weights_buf = io.BytesIO()
        torch.save(state_dict, weights_buf)
        checkpoint_bytes = weights_buf.getvalue()

        # ── build training history ────────────────────────────────────────────────
        round_num = self.current_round
        history = self._build_training_history_dict()

        # ── build dataset summary from cached trainer properties ─────────────────
        datasets_in_manifest: List[dict] = []
        total_train_samples = 0
        trainer_sections: List[dict] = []
        for svc_id, props in self._trainer_properties.items():
            dataset_info: dict = props.get("dataset_info", {})
            train_samples: int = props.get("train_samples", 0)
            total_train_samples += train_samples
            client_name = props.get("client_name") or svc_id.split(":")[-1]
            for ds_id, ds_manifest in dataset_info.items():
                datasets_in_manifest.append({
                    "id": ds_id,
                    "name": ds_manifest.get("name", ds_id),
                    "train_samples": train_samples,
                })
            trainer_sections.append({
                "client_name": client_name,
                "service_id": svc_id,
                "datasets": list(dataset_info.keys()),
                "train_samples": train_samples,
                "val_samples": props.get("val_samples", 0),
                "fit_losses": history["client_training_losses"].get(svc_id, []),
                "eval_losses": history["client_validation_losses"].get(svc_id, []),
            })

        history_doc = {
            "created_at": datetime.datetime.utcnow().isoformat() + "Z",
            "num_rounds": round_num,
            "average_fit_losses": history["training_losses"],
            "average_eval_losses": history["validation_losses"],
            "participating_trainers": trainer_sections,
        }

        # ── ensure chiron-models collection exists ────────────────────────────────
        artifact_manager = await self.hypha_client.get_service("public/artifact-manager")
        workspace = self.hypha_client.config.workspace
        collection_id = f"{workspace}/chiron-models"
        try:
            await artifact_manager.read(collection_id)
        except Exception as e:
            if "does not exist" in str(e):
                await artifact_manager.create(
                    type="collection",
                    alias="chiron-models",
                    manifest={"name": "Chiron Models",
                               "description": "Trained model artifacts from federated learning runs."},
                )
            else:
                raise

        # ── auto-generate description ─────────────────────────────────────────────
        dataset_names = [ds["name"] for ds in datasets_in_manifest]
        num_sites = len(trainer_sections)
        auto_description = (
            f"{round_num} federated round{'s' if round_num != 1 else ''} · "
            f"{num_sites} site{'s' if num_sites != 1 else ''}: "
            + ", ".join(dataset_names)
        )

        # ── create artifact with enriched manifest ────────────────────────────────
        manifest = {
            "name": f"Global transformer weights — round {round_num}",
            "description": description or auto_description,
            "model_type": "global_transformer",
            "round": round_num,
            "num_rounds": round_num,
            "num_sites": num_sites,
            "total_train_samples": total_train_samples,
            "datasets": datasets_in_manifest,
        }
        artifact = await artifact_manager.create(
            type="model", parent_id=collection_id, manifest=manifest, stage=True
        )

        # ── upload weights (model.pth) + history ─────────────────────────────────
        weights_url = await artifact_manager.put_file(artifact.id, file_path="model.pth")
        history_url = await artifact_manager.put_file(artifact.id, file_path="training_history.json")

        timeout = httpx.Timeout(upload_timeout)
        async with httpx.AsyncClient(timeout=timeout) as http:
            r = await http.put(weights_url, content=checkpoint_bytes)
            r.raise_for_status()
            r = await http.put(history_url,
                               content=json_module.dumps(history_doc, indent=2).encode())
            r.raise_for_status()

        await artifact_manager.commit(artifact.id)
        logger.info(f"Saved global transformer weights to artifact {artifact.id} (model.pth)")
        return artifact.id

    def _build_training_history_dict(self) -> dict:
        """Return the same structure as get_training_history() for internal use."""
        return {
            "training_losses": [[r, l] for r, l in self.history.losses_distributed],
            "validation_losses": [[r, l] for r, l in self.history.losses_centralized],
            "client_training_losses": {
                cid: m.get("loss", [])
                for cid, m in self.history.client_metrics_fit.items()
            },
            "client_validation_losses": {
                cid: m.get("loss", [])
                for cid, m in self.history.client_metrics_evaluate.items()
            },
        }
