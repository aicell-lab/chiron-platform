import asyncio
import datetime
import json
import logging
import os
import threading
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Dict, List, Literal, Optional, Tuple, Union

import httpx
import numpy as np
import pytorch_lightning as pl
import torch
from bioengine.datasets import BioEngineDatasets
from flwr.client import NumPyClient
from hypha_rpc import connect_to_server
from hypha_rpc.rpc import RemoteService
from hypha_rpc.utils import ObjectProxy
from hypha_rpc.utils.schema import schema_method
from pydantic import Field
from ray import serve
from sklearn.model_selection import train_test_split
from torch.utils.data import DataLoader
from zarr.abc.store import Store

from tabula.model.transformer.transformer import TabulaTransformer
from tabula.training import ModelConfig
from tabula.training.data_loader import Collate, MultiClientDataset
from tabula.training.pretrainer import TabulaPretrainer

logger = logging.getLogger("ray.serve")

# Keep this list in sync with repository-level requirements.txt.
pip_requirements = [
    "aiohttp==3.9.0",
    "aiosignal==1.3.1",
    "anyio==3.7.1",
    "attrs==23.1.0",
    "certifi==2023.11.17",
    "charset-normalizer==3.3.2",
    "click==8.1.7",
    "einops==0.7.0",
    "fastapi==0.106.0",
    "filelock==3.13.1",
    "flwr==1.22.0",  # Directly used
    "frozenlist==1.4.0",
    "fsspec==2023.10.0",
    "h11==0.14.0",
    "idna==3.4",
    "Jinja2==3.1.2",
    "joblib==1.3.2",
    "lightning-utilities==0.10.0",
    "MarkupSafe==2.1.3",
    "multidict==6.0.4",
    "networkx==3.2.1",
    "ninja==1.11.1.1",
    "numpy==1.26.4",  # Directly used
    "packaging==22.0",
    "protobuf==4.25.5",
    "psutil==5.9.6",
    "Pygments==2.17.2",
    "pytorch-lightning==2.2.0",  # Directly used
    "pyyaml==6.0.2",  # Directly used
    "requests==2.32.3",  # Directly used
    "scikit-learn==1.3.0",  # Directly used
    "scipy==1.16.3",
    "six==1.16.0",
    "sniffio==1.3.0",
    "threadpoolctl==3.2.0",
    "torch==1.13.1",  # Directly used
    # pip install torch==1.13.1+cu117 --extra-index-url https://download.pytorch.org/whl/cu117
    "torchmetrics==1.2.0",
    "tqdm==4.67.1",
    "typing_extensions==4.12.2",
    "urllib3==1.26.18",
    "wrapt==1.16.0",
    "zarr==3.1.3",  # Directly used
]

if os.getenv("ENABLE_FLASH_ATTENTION") == "1":
    # Optional performance packages
    pip_requirements.extend(["flash-attn==2.3.5 --no-build-isolation"])


# ---------------------------------------------------------------------------
# Federated client (inlined from tabula.distributed.federated_client so that
# FL logic changes only require an app upload, not a Docker image rebuild)
# ---------------------------------------------------------------------------


class TrainingCancelledException(Exception):
    """Custom exception for training cancellation that won't affect Ray Serve."""

    pass


class LossCallback(pl.Callback):
    """Callback to obtain the final training and validation loss."""

    current_train_loss: Optional[Dict[str, torch.Tensor]]
    current_val_loss: Optional[Dict[str, torch.Tensor]]

    def on_train_end(self, trainer, pl_module):
        self.current_train_loss = trainer.logged_metrics["train_loss"]

    def on_validation_end(self, trainer, pl_module):
        self.current_val_loss = trainer.logged_metrics["val_loss"]


class ProgressCallback(pl.Callback):
    """Callback to track training/validation progress."""

    def __init__(self, total_batches: int):
        self.current_batch = 0
        self.total_batches = total_batches
        self._is_sanity_check = False

    def on_train_epoch_start(self, trainer, pl_module):
        """Reset on epoch start."""
        self.current_batch = 0

    def on_validation_epoch_start(self, trainer, pl_module):
        """Reset on epoch start."""
        self.current_batch = 0

    def on_validation_start(self, trainer, pl_module):
        """Called when validation starts."""
        self._is_sanity_check = bool(
            getattr(trainer, "sanity_checking", False)
            or getattr(trainer, "_sanity_checking", False)
            or getattr(trainer, "running_sanity_check", False)
        )

    def on_validation_end(self, trainer, pl_module):
        """Called when validation ends."""
        self._is_sanity_check = False

    def on_train_batch_start(self, trainer, pl_module, batch, batch_idx):
        """Called before each training batch."""
        self.current_batch = batch_idx + 1

    def on_validation_batch_start(
        self, trainer, pl_module, batch, batch_idx, dataloader_idx=0
    ):
        """Called before each validation batch."""
        if not self._is_sanity_check:
            self.current_batch = batch_idx + 1

    def get_progress(self) -> int:
        """Get current batch number."""
        return {
            "current_batch": self.current_batch,
            "total_batches": self.total_batches,
            "progress": (
                self.current_batch / self.total_batches if self.total_batches > 0 else 0
            ),
        }


class CancellationCallback(pl.Callback):
    """Callback to check for cancellation requests and stop training."""

    def __init__(self, should_cancel: Callable[[], bool]):
        super().__init__()
        self.should_cancel = should_cancel

    def on_train_batch_start(self, trainer, pl_module, batch, batch_idx):
        """Check cancellation before each training batch."""
        if self.should_cancel():
            trainer.should_stop = True
            raise TrainingCancelledException("Training cancelled by user")

    def on_validation_batch_start(
        self, trainer, pl_module, batch, batch_idx, dataloader_idx=0
    ):
        """Check cancellation before each validation batch."""
        if self.should_cancel():
            trainer.should_stop = True
            raise TrainingCancelledException("Validation cancelled by user")

    def on_train_epoch_start(self, trainer, pl_module):
        """Check cancellation at the start of each epoch."""
        if self.should_cancel():
            trainer.should_stop = True
            raise TrainingCancelledException("Training cancelled by user")

    def on_validation_start(self, trainer, pl_module):
        """Check cancellation before validation starts."""
        if self.should_cancel():
            trainer.should_stop = True
            raise TrainingCancelledException("Validation cancelled by user")


class FederatedClient(NumPyClient):
    def __init__(
        self,
        client_id: str,
        client_name: str,
        config: ModelConfig,
        dataset_info: Dict[str, dict],
        zarr_sources: List[Union[str, Path, Store]],
        device: Union[str, torch.device] = "cpu",
        should_cancel_fit: Optional[Callable[[], bool]] = None,
        should_cancel_evaluate: Optional[Callable[[], bool]] = None,
        executor_idle: Optional[threading.Event] = None,
    ):
        # Set model and dataset config
        self.config = config
        self.device = torch.device(device)

        # Load model
        self.model = self._get_model()

        # Load dataset
        self.train_data, self.test_data = self._load_data(zarr_sources)

        # Initialize properties
        self._properties = {
            "client_id": client_id,
            "client_name": client_name,
            "dataset_info": dataset_info,
            "train_samples": len(self.train_data),
            "val_samples": len(self.test_data),
            "device": str(self.device),
        }

        # Store cancellation callbacks
        self.should_cancel_fit = should_cancel_fit or (lambda: False)
        self.should_cancel_evaluate = should_cancel_evaluate or (lambda: False)

        # Store executor idle event for thread completion tracking
        self.executor_idle = executor_idle

        # Progress tracking callbacks
        self.fit_progress_callback = ProgressCallback(total_batches=0)
        self.evaluate_progress_callback = ProgressCallback(total_batches=0)

        # Initialize training history
        self.training_history: Dict[str, List[tuple[int, int | float]]] = {}

    def _count_batches(self, dataloader) -> int:
        """Compute total batches from dataloaders."""
        dataset = dataloader.dataset
        batch_size = dataloader.batch_size
        return int(np.ceil(len(dataset) / batch_size))

    def _get_model(self) -> TabulaTransformer:
        """Get the Tabula model."""
        backbone = self.config.get_model_param("backbone").lower()
        if backbone == "ftt":
            additive_attention = False
            flash_attention = False
        elif backbone == "fastformer":
            additive_attention = True
            flash_attention = False
        elif backbone == "flashattention":
            additive_attention = False
            if self.device.type == "cuda":
                flash_attention = True
            else:
                logger.info(
                    f"Flash Attention requires GPU but device is {self.device}. Falling back to FTT."
                )
                flash_attention = False
        else:
            raise ValueError(f"Backbone {backbone} not supported.")

        model = TabulaTransformer(
            in_feature=self.config.get_model_param("in_feature"),
            embedding_in_feature=self.config.get_model_param("embedding_in_feature"),
            contrastive_out_feature=self.config.get_model_param(
                "contrastive_out_feature"
            ),
            d_token=self.config.get_model_param("d_token"),
            n_blocks=self.config.get_model_param("n_blocks"),
            residual_dropout=self.config.get_model_param("residual_dropout"),
            additive_attention=additive_attention,
            flash_attention=flash_attention,
            attention_n_heads=self.config.get_model_param("attention_n_heads"),
            attention_dropout=self.config.get_model_param("attention_dropout"),
            ffn_d_hidden=self.config.get_model_param("ffn_d_hidden"),
            ffn_dropout=self.config.get_model_param("ffn_dropout"),
            cls=self.config.get_model_param("cls"),
            pre_normalization=self.config.get_model_param("pre_normalization"),
            global_token=self.config.get_model_param("global_token"),
            pretrain_objective=self.config.get_pretrain_param("objective"),
        )
        return model

    def _get_pretrainer(self) -> TabulaPretrainer:
        """Get the pytorch-lightning pretrainer of Tabula model."""
        return TabulaPretrainer(
            model=self.model,
            augmentation_mode=self.config.get_pretrain_param("augmentation_type"),
            corruption_rate=self.config.get_pretrain_param("corruption_rate"),
            pretrain_objective=self.config.get_pretrain_param("objective"),
            contrastive_scale=self.config.get_pretrain_param("contrastive_scale"),
            reconstruction_scale=self.config.get_pretrain_param("reconstruction_scale"),
            learning_rate=self.config.get_pretrain_param("learning_rate"),
            temperature=self.config.get_pretrain_param("temperature"),
            seed=self.config.get_model_param("seed"),
        )

    def _load_data(
        self, zarr_sources: List[Union[str, Path, Store]]
    ) -> Tuple[MultiClientDataset, MultiClientDataset]:
        """Get the dataloader corresponding to data directory."""
        in_feature = self.config.get_model_param("in_feature")
        padding_id = self.config.get_model_param("padding_id")
        padding_value = self.config.get_model_param("padding_value")

        multi_client_dataset = MultiClientDataset(
            zarr_sources=zarr_sources,
            in_feature=in_feature,
            padding_id=padding_id,
            padding_value=padding_value,
        )

        train_indices, test_indices = train_test_split(
            range(len(multi_client_dataset)), test_size=0.1, random_state=0
        )
        train_data = torch.utils.data.Subset(multi_client_dataset, train_indices)
        test_data = torch.utils.data.Subset(multi_client_dataset, test_indices)
        return train_data, test_data

    def _create_data_loader(
        self, batch_size: int, stage: Literal["train", "val"]
    ) -> DataLoader:
        """Create train or val data loader with given batch size.

        Set num_workers=0 when using async zarr stores (HttpZarrStore).
        This ensures the DataLoader runs in the main thread where the event
        loop is available for async HTTP requests.
        """
        if stage == "train":
            return DataLoader(
                dataset=self.train_data,
                batch_size=batch_size,
                shuffle=True,
                num_workers=0,
                collate_fn=Collate(),
            )
        return DataLoader(
            dataset=self.test_data,
            batch_size=batch_size,
            shuffle=False,
            num_workers=0,
            collate_fn=Collate(),
        )

    def _get_weights(self) -> List[np.ndarray]:
        return [
            val.cpu().numpy() for _, val in self.model.transformer.state_dict().items()
        ]

    def _set_weights(self, parameters: List[np.ndarray]) -> None:
        params_dict = zip(self.model.transformer.state_dict().keys(), parameters)
        state_dict = OrderedDict({k: torch.tensor(v) for k, v in params_dict})
        self.model.transformer.load_state_dict(state_dict, strict=True)

    def _save_weights(self, server_round: int) -> None:
        """Save model weights after training."""
        weights_folder = Path("./trained_weights")
        weights_folder.mkdir(parents=True, exist_ok=True)
        previous_weights = next(weights_folder.glob(f"*.pth"), None)
        weights_name = f"model_weights-round={server_round}.pth"
        new_weights = weights_folder / weights_name
        logger.info(f"Saving model weights to {new_weights}")
        torch.save(self.model.state_dict(), new_weights)
        if previous_weights is not None and previous_weights != new_weights:
            previous_weights.unlink()

    def _add_metrics_to_train_history(
        self, server_round: int, loss: float, num_examples: int
    ) -> None:
        """Add training metrics to the training history."""
        self.training_history.setdefault("train_loss", [])
        self.training_history.setdefault("train_samples", [])
        self.training_history["train_loss"].append((server_round, loss))
        self.training_history["train_samples"].append((server_round, num_examples))

    def _add_metrics_to_eval_history(
        self, server_round: int, loss: float, num_examples: int
    ) -> None:
        """Add evaluation metrics to the evaluation history."""
        self.training_history.setdefault("val_loss", [])
        self.training_history.setdefault("val_samples", [])
        self.training_history["val_loss"].append((server_round, loss))
        self.training_history["val_samples"].append((server_round, num_examples))

    def _fit(
        self,
        batch_size: int,
        limit_train_batches: Union[int, None],
        server_round: int,
    ) -> Tuple[float, int, Dict[str, float]]:
        train_loader = self._create_data_loader(batch_size=batch_size, stage="train")

        total_batches = min(
            self._count_batches(train_loader),
            limit_train_batches if limit_train_batches is not None else float("inf"),
        )
        self.fit_progress_callback.total_batches = total_batches

        total_samples = self._properties["train_samples"]
        if limit_train_batches is None:
            num_examples = total_samples
        else:
            num_examples = min(limit_train_batches * batch_size, total_samples)

        loss_callback = LossCallback()
        cancel_callback = CancellationCallback(self.should_cancel_fit)
        callbacks = [loss_callback, cancel_callback, self.fit_progress_callback]
        trainer = pl.Trainer(
            logger=False,
            max_epochs=1,
            limit_train_batches=limit_train_batches,
            num_sanity_val_steps=0,
            callbacks=callbacks,
            accelerator="gpu" if self.device.type == "cuda" else "cpu",
            devices=[self.device.index] if self.device.type == "cuda" else 1,
            enable_checkpointing=False,
        )

        pretrainer = self._get_pretrainer()
        try:
            trainer.fit(pretrainer, train_dataloaders=train_loader)
        except TrainingCancelledException as e:
            logger.info(f"==> Training interrupted by cancellation: {e}")
            raise RuntimeError("Training was cancelled")

        loss = loss_callback.current_train_loss.item()
        metrics = {"loss": loss}
        self._save_weights(server_round=server_round)

        if server_round <= 1:
            self.training_history = {}
        self._add_metrics_to_train_history(server_round, loss, num_examples)
        return loss, num_examples, metrics

    def _evaluate(
        self,
        batch_size: int,
        limit_val_batches: Union[int, None],
        server_round: int,
    ) -> Tuple[float, int, Dict[str, float]]:
        val_loader = self._create_data_loader(batch_size=batch_size, stage="val")

        total_batches = min(
            self._count_batches(val_loader),
            limit_val_batches if limit_val_batches is not None else float("inf"),
        )
        self.evaluate_progress_callback.total_batches = total_batches

        total_samples = self._properties["val_samples"]
        if limit_val_batches is None:
            num_examples = total_samples
        else:
            num_examples = min(limit_val_batches * batch_size, total_samples)

        loss_callback = LossCallback()
        cancel_callback = CancellationCallback(self.should_cancel_evaluate)
        callbacks = [loss_callback, cancel_callback, self.evaluate_progress_callback]
        trainer = pl.Trainer(
            logger=False,
            max_epochs=1,
            limit_val_batches=limit_val_batches,
            num_sanity_val_steps=0,
            callbacks=callbacks,
            accelerator="gpu" if self.device.type == "cuda" else "cpu",
            devices=[self.device.index] if self.device.type == "cuda" else 1,
            enable_checkpointing=False,
        )

        pretrainer = self._get_pretrainer()
        try:
            trainer.validate(pretrainer, dataloaders=val_loader)
        except TrainingCancelledException as e:
            logger.info(f"==> Evaluation interrupted by cancellation: {e}")
            raise RuntimeError("Evaluation was cancelled")

        loss = loss_callback.current_val_loss.item()
        metrics = {"loss": loss}
        self._add_metrics_to_eval_history(server_round, loss, num_examples)
        return loss, num_examples, metrics

    def get_properties(self) -> Dict[str, Union[str, int]]:
        return self._properties

    def get_parameters(self) -> List[np.ndarray]:
        return self._get_weights()

    def get_fit_progress(self) -> Dict[str, Union[int, float]]:
        """Get current fit progress status."""
        return self.fit_progress_callback.get_progress()

    def get_evaluate_progress(self) -> Dict[str, Union[int, float]]:
        """Get current evaluate progress status."""
        return self.evaluate_progress_callback.get_progress()

    def reset_fit_progress(self) -> None:
        self.fit_progress_callback.current_batch = 0
        self.fit_progress_callback.total_batches = 0

    def reset_evaluate_progress(self) -> None:
        self.evaluate_progress_callback.current_batch = 0
        self.evaluate_progress_callback.total_batches = 0

    def fit(
        self,
        parameters: List[np.ndarray],
        batch_size: int,
        limit_train_batches: Union[int, None],
        server_round: int,
    ) -> Tuple[List[np.ndarray], int, Dict[str, float]]:
        """Train the model with data of this client."""
        try:
            logger.info(f"==> Running fit")
            self._set_weights(parameters)
            train_loss, num_examples, metrics = self._fit(
                batch_size=batch_size,
                limit_train_batches=limit_train_batches,
                server_round=server_round,
            )
            updated_parameters = self._get_weights()
            logger.info(f"==> fit successfully: {metrics}")
            return updated_parameters, num_examples, metrics
        finally:
            if self.executor_idle is not None:
                self.executor_idle.set()

    def evaluate(
        self,
        parameters: List[np.ndarray],
        batch_size: int,
        limit_val_batches: Union[int, None],
        server_round: int,
    ) -> Tuple[float, int, Dict[str, float]]:
        """Evaluate the model on the data this client has."""
        try:
            logger.info(f"==> running evaluate")
            self._set_weights(parameters)
            val_loss, num_examples, metrics = self._evaluate(
                batch_size=batch_size,
                limit_val_batches=limit_val_batches,
                server_round=server_round,
            )
            logger.info(f"==> evaluate successfully: {metrics}")
            return val_loss, num_examples, metrics
        finally:
            if self.executor_idle is not None:
                self.executor_idle.set()

    def load_weights(self, weights_path: Union[str, Path]) -> None:
        """Load model weights from a checkpoint file."""
        state_dict = torch.load(weights_path, map_location="cpu")
        missing_keys, unexpected_keys = self.model.load_state_dict(
            state_dict, strict=False
        )
        if missing_keys:
            logger.warning(f"Missing keys when loading weights: {missing_keys}")
        if unexpected_keys:
            logger.warning(f"Unexpected keys when loading weights: {unexpected_keys}")


@serve.deployment(
    ray_actor_options={
        "num_cpus": 1,
        "num_gpus": 1,
        "memory": 16 * 1024 * 1024 * 1024,  # 16GB RAM limit
        "runtime_env": {"pip": pip_requirements},
    },
    max_ongoing_requests=1,  # Important to guarantee thread-safety
    max_queued_requests=5,
    autoscaling_config={
        "min_replicas": 0,
        "initial_replicas": 1,
        "max_replicas": 1,
        "target_num_ongoing_requests_per_replica": 0.8,
        "metrics_interval_s": 2.0,
        "look_back_period_s": 10.0,
        "downscale_delay_s": 300,
        "upscale_delay_s": 0.0,
    },
    health_check_period_s=30.0,
    health_check_timeout_s=30.0,
    graceful_shutdown_timeout_s=120.0,
    graceful_shutdown_wait_loop_s=2.0,
)
class TabulaTrainer:
    bioengine_datasets: BioEngineDatasets  # Injected BioEngine Datasets Service

    def __init__(
        self,
        datasets: List[str],
        client_id: Optional[str] = None,
        client_name: Optional[str] = None,
        pretrained_weights_path: Optional[str] = None,
    ):
        """
        Flower Client for Federated Learning
        """
        # Store dataset names
        self.datasets = datasets

        # Set client_id and client_name
        self.client_id = client_id or str(uuid.uuid4())
        self.client_name = client_name or self.client_id
        self.pretrained_weights_path = pretrained_weights_path

        # Device and model config
        self.device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")

        # Model configuration will be loaded during async_init
        self.config: ModelConfig
        self.local_client: FederatedClient

        # Status tracking
        self.fit_status: Literal[
            "NOT_STARTED", "RUNNING", "COMPLETED", "CANCELLED", "FAILED"
        ] = "NOT_STARTED"
        self.fit_message: str = ""
        self.fit_result: Optional[Tuple[List[np.ndarray], int, Dict[str, float]]] = None

        self.evaluate_status: Literal[
            "NOT_STARTED", "RUNNING", "COMPLETED", "CANCELLED", "FAILED"
        ] = "NOT_STARTED"
        self.evaluate_message: str = ""
        self.evaluate_result: Optional[Tuple[float, int, Dict[str, float]]] = None

        # Task tracking
        self.fit_task: Optional[asyncio.Task] = None
        self.evaluate_task: Optional[asyncio.Task] = None

        # Cancellation flags for cooperative cancellation
        self.fit_cancelled: bool = False
        self.evaluate_cancelled: bool = False

        # Initialize executor for running blocking operations
        self.executor = ThreadPoolExecutor(max_workers=1)

        # Threading event to track when executor thread completes
        self.executor_idle = threading.Event()
        self.executor_idle.set()  # Initially idle

        # Event to track test completion
        self.test_completed = asyncio.Event()

        # Hypha server connection info
        self._server_url = os.getenv("HYPHA_SERVER_URL")
        if not self._server_url:
            raise ValueError("HYPHA_SERVER_URL environment variable is not set.")
        self._hypha_token = os.getenv("HYPHA_TOKEN")
        if not self._hypha_token:
            raise ValueError("HYPHA_TOKEN environment variable is not set.")
        self.hypha_client: RemoteService = None
        self.artifact_manager: ObjectProxy = None

        # Model upload tracking
        self.model_upload_artifact_id: Optional[str] = None

        # Session tracking — set True by orchestrator when a training session starts
        self.session_active: bool = False
        self._session_watchdog: Optional[asyncio.Task] = None
        self._session_round_timeout: Optional[float] = None  # per-round timeout + buffer

        # Orchestrator registration — set when an orchestrator registers this trainer
        self._registered_orchestrator_id: Optional[str] = None
        self._ping_task: Optional[asyncio.Task] = None
        self._ping_fail_count: int = 0

    # === BioEngine App Method - will be called when the deployment is started ===

    async def async_init(self):
        # Connect to Hypha server and get Artifact Manager service
        self.hypha_client = await connect_to_server(
            {
                "server_url": self._server_url,
                "token": self._hypha_token,
            }
        )
        logger.info(f"Connected to Hypha Server at {self._server_url}")
        self.artifact_manager = await self.hypha_client.get_service(
            "public/artifact-manager"
        )
        logger.info("Connected to Artifact Manager")

        # Load model configuration
        config_path = await self._download_from_artifact(
            artifact_id=os.environ["HYPHA_ARTIFACT_ID"],
            file_path="framework.yaml",
            timeout=20,
        )
        self.config = ModelConfig(config_path)
        logger.info("Loaded model configuration")

        # Initialize FederatedClient for the first time
        await self._init_federated_client()

        # Load pretrained weights if a path was specified at deployment time.
        if self.pretrained_weights_path:
            weights_path = Path(self.pretrained_weights_path)
            try:
                self.local_client.load_weights(weights_path)
                logger.info(f"Loaded pretrained weights from {weights_path}")
            except Exception as e:
                logger.warning(f"Could not load pretrained weights from {weights_path}: {e}")

    async def test_deployment(self):

        def get_default_param(parameter_name: str):
            return self.start_fit.__schema__["parameters"]["properties"][
                parameter_name
            ]["default"]

        try:
            logger.info("Testing TabulaTrainer deployment with a single fit batch")

            self.config.pretrain_config["learning_rate"] = get_default_param(
                "learning_rate"
            )
            self.config.pretrain_config["corruption_rate"] = get_default_param(
                "corruption_rate"
            )
            self.config.pretrain_config["contrastive_scale"] = get_default_param(
                "contrastive_scale"
            )
            self.config.pretrain_config["reconstruction_scale"] = get_default_param(
                "reconstruction_scale"
            )
            self.config.pretrain_config["temperature"] = get_default_param(
                "temperature"
            )

            # Test for a single fit batch without saving the checkpoint
            _, _, _ = self.local_client._fit(
                batch_size=1, limit_train_batches=1, server_round=0
            )
            logger.info("Test fit completed successfully")
        finally:
            self.test_completed.set()

    # === Ray Serve Health Check Method - will be called periodically to check the health of the deployment ===

    async def check_health(self) -> None:
        # Test connection to the Hypha server
        await self.hypha_client.echo("ping")

        # Don't mark as ready until test is complete
        await self.test_completed.wait()

    # === Internal Methods ===

    async def _download_from_artifact(
        self, artifact_id: str, file_path: str, timeout: int
    ) -> Path:
        """Download a file from a Hypha artifact"""
        local_artifact_path = os.environ.get("BIOENGINE_LOCAL_ARTIFACT_PATH")

        # If downloading from the current artifact and running locally, use local path
        if local_artifact_path and artifact_id == os.environ.get("HYPHA_ARTIFACT_ID"):
            logger.info(
                f"Running locally, using local artifact path to access {file_path}"
            )
            local_file_path = (
                Path(local_artifact_path).resolve() / "tabula_trainer" / file_path
            )
            return local_file_path

        workspace, alias = artifact_id.split("/")
        local_file_path = (
            Path("downloads").resolve()
            / workspace.replace("|", "_")
            / alias
            / file_path
        )
        local_file_path.parent.mkdir(parents=True, exist_ok=True)

        # Return file path if it already exists
        if local_file_path.exists():
            logger.info(f"File already exists locally: {local_file_path}")
            return local_file_path

        # Download file from remote artifact
        logger.info(f"Downloading {file_path} from artifact {artifact_id}")
        url = await self.artifact_manager.get_file(artifact_id, file_path)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url)
            response.raise_for_status()

        # Save content to local file
        local_file_path.write_bytes(response.content)

        return local_file_path

    async def _fit_background(
        self,
        parameters: List[np.ndarray],
        batch_size: int,
        limit_train_batches: Union[None, int],
        server_round: int,
    ):
        """Background task for fit operation."""
        # Reset per-round watchdog — orchestrator just contacted us
        self._reset_session_watchdog()

        # Mark executor as busy
        self.executor_idle.clear()

        # Set status to running
        self.fit_status = "RUNNING"

        loop = asyncio.get_running_loop()
        try:
            # Run fit in executor to avoid blocking the event loop
            updated_parameters, num_examples, metrics = await loop.run_in_executor(
                self.executor,
                self.local_client.fit,
                parameters,
                batch_size,
                limit_train_batches,
                server_round,
            )

            self.fit_result = (updated_parameters, num_examples, metrics)
            self.fit_status = "COMPLETED"

        except asyncio.CancelledError:
            self.fit_status = "CANCELLED"
            self.fit_message = "Task was cancelled by user"

        except Exception as e:
            self.fit_status = "FAILED"
            self.fit_message = str(e)

        finally:
            # Wait for executor thread to complete (in case task was cancelled)
            if not self.executor_idle.is_set():
                await loop.run_in_executor(None, self.executor_idle.wait)

            # Clear fit task
            self.fit_task = None

    async def _evaluate_background(
        self,
        parameters: List[np.ndarray],
        batch_size: int,
        limit_val_batches: Union[None, int],
        server_round: int,
    ):
        """Background task for evaluate operation."""
        # Reset per-round watchdog — orchestrator just contacted us
        self._reset_session_watchdog()

        # Mark executor as busy
        self.executor_idle.clear()

        loop = asyncio.get_running_loop()
        try:
            # Reset flags
            self.evaluate_status = "RUNNING"

            # Run evaluate in executor to avoid blocking the event loop
            val_loss, num_examples, metrics = await loop.run_in_executor(
                self.executor,
                self.local_client.evaluate,
                parameters,
                batch_size,
                limit_val_batches,
                server_round,
            )

            self.evaluate_result = (val_loss, num_examples, metrics)
            self.evaluate_status = "COMPLETED"

        except asyncio.CancelledError:
            self.evaluate_status = "CANCELLED"
            self.evaluate_message = "Task was cancelled by user"

        except Exception as e:
            self.evaluate_status = "FAILED"
            self.evaluate_message = str(e)

        finally:
            # Wait for executor thread to complete (in case task was cancelled)
            if not self.executor_idle.is_set():
                await loop.run_in_executor(None, self.executor_idle.wait)

            # Clear evaluate task
            self.evaluate_task = None

    async def _create_collection(self) -> str:
        """Return the chiron-models collection ID, creating it if it does not yet exist."""
        workspace = self.hypha_client.config.workspace
        collection_alias = "chiron-models"
        collection_id = f"{workspace}/{collection_alias}"

        try:
            await self.artifact_manager.read(collection_id)
            return collection_id
        except Exception:
            pass  # collection does not exist yet — create it below

        try:
            await self.artifact_manager.create(
                type="collection",
                alias=collection_alias,
                manifest={"name": "Chiron Models", "description": "A collection of trained models."},
            )
        except Exception as e:
            # Another trainer may have created the collection concurrently — that is fine.
            if "already exists" in str(e) or "duplicate key" in str(e) or "UniqueViolation" in str(e):
                logger.debug(f"Collection '{collection_id}' was created concurrently, reusing it.")
            else:
                logger.error(f"Failed to create Chiron Models collection: {e}")
                raise

        return collection_id

    async def _init_federated_client(self) -> None:
        """Create a new FederatedClient by loading datasets and zarr sources. Called once on startup."""
        # Get information about the training datasets
        available_datasets = await self.bioengine_datasets.list_datasets()
        training_datasets = {
            dataset_id: dataset_info
            for dataset_id, dataset_info in available_datasets.items()
            if dataset_id in self.datasets
        }

        # Get available zarr files from BioEngine datasets.
        # The new data server returns individual file paths (e.g. filter_129.zarr/.zattrs)
        # so we extract unique top-level .zarr store directories from the listing.
        zarr_sources = []
        for dataset_id in training_datasets.keys():
            files = await self.bioengine_datasets.list_files(dataset_id, dir_path=None)
            zarr_dirs = set()
            for file_name in files:
                parts = file_name.replace("\\", "/").split("/")
                for part in parts:
                    if part.endswith(".zarr"):
                        zarr_dirs.add(parts[0] if parts[0].endswith(".zarr") else part)
                        break
            # Also handle flat listing where the entry itself ends in .zarr
            zarr_dirs.update(f for f in files if f.endswith(".zarr"))
            for zarr_dir in sorted(zarr_dirs):
                zarr_store = await self.bioengine_datasets.get_file(
                    dataset_id=dataset_id, file_path=zarr_dir
                )
                zarr_sources.append(zarr_store)

        logger.info("Initializing new Tabula model...")
        self.local_client = FederatedClient(
            client_id=self.client_id,
            client_name=self.client_name,
            config=self.config,
            dataset_info=training_datasets,
            zarr_sources=zarr_sources,
            device=self.device,
            should_cancel_fit=lambda: self.fit_cancelled,
            should_cancel_evaluate=lambda: self.evaluate_cancelled,
            executor_idle=self.executor_idle,
        )

    # === Exposed BioEngine App Methods - all methods decorated with @schema_method will be exposed as API endpoints ===

    @property
    def _local_model_dir(self) -> Path:
        """Stable per-trainer directory inside the BioEngine workspace models folder.

        Inside BioEngine Docker containers HOME is set to the app-specific directory
        /home/.bioengine/apps/<app_id>/.  Going two levels up reaches /home/.bioengine/,
        the persistent workspace root that survives app redeployments.
        """
        app_home = Path(os.environ.get("HOME", os.path.expanduser("~")))
        # Navigate up to the .bioengine root if we're inside an apps/<id>/ directory
        if app_home.parent.name == "apps" and app_home.parent.parent.name == ".bioengine":
            bioengine_root = app_home.parent.parent
        else:
            bioengine_root = app_home / ".bioengine"
        return bioengine_root / "models" / self.client_name

    @schema_method
    async def save_local_model(
        self,
        description: Optional[str] = Field(
            None, description="Optional note stored in the metadata file."
        ),
    ) -> str:
        """Save the full local model (embedder + transformer + projection heads) to the
        BioEngine workspace models directory (~/.bioengine/models/<client_name>/).

        Writes two files:
        - model.pth       — full model state_dict (all components)
        - metadata.json   — dataset info, training history, timestamp

        Use list_local_model_weights() to discover saved checkpoints and pass the
        desired path via the pretrained_weights_path parameter when deploying a new
        trainer to restore the embedder and projection heads from a prior run.

        Returns the path of the saved model file as a string.
        """
        model_dir = self._local_model_dir
        model_dir.mkdir(parents=True, exist_ok=True)

        model_path = model_dir / "model.pth"
        meta_path  = model_dir / "metadata.json"

        # Save full model state dict (all components)
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            self.executor,
            lambda: torch.save(self.local_client.model.state_dict(), model_path),
        )

        # Build metadata
        props = self.local_client.get_properties()
        metadata = {
            "client_name": self.client_name,
            "client_id": self.client_id,
            "saved_at": datetime.datetime.utcnow().isoformat() + "Z",
            "description": description,
            "datasets": props.get("dataset_info", {}),
            "train_samples": props.get("train_samples", 0),
            "val_samples": props.get("val_samples", 0),
            "training_history": self.local_client.training_history,
        }
        meta_path.write_text(json.dumps(metadata, indent=2))

        logger.info(f"Saved local model to {model_path}")
        return str(model_path)

    @schema_method
    async def list_local_model_weights(self) -> List[dict]:
        """List available local model weight files on this worker.

        Scans ~/.bioengine/models/ for saved model checkpoints and returns
        metadata for each, including the datasets they were trained on.
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

    @schema_method
    async def clear_local_model_weights(self) -> List[str]:
        """Delete all locally saved model weight directories on this worker.

        Removes every subdirectory under ~/.bioengine/models/ and returns a
        list of the deleted paths.
        """
        import shutil
        app_home = Path(os.environ.get("HOME", os.path.expanduser("~")))
        if app_home.parent.name == "apps" and app_home.parent.parent.name == ".bioengine":
            bioengine_root = app_home.parent.parent
        else:
            bioengine_root = app_home / ".bioengine"
        models_dir = bioengine_root / "models"

        deleted: List[str] = []
        if not models_dir.exists():
            return deleted

        for entry in sorted(models_dir.iterdir()):
            if entry.is_dir():
                shutil.rmtree(entry)
                deleted.append(str(entry))

        logger.info(f"Cleared {len(deleted)} local model weight directory(ies)")
        return deleted

    @schema_method
    async def reset_training_state(self) -> Dict[str, Union[bool, str]]:
        """Reset per-session bookkeeping (training history, artifact tracking, status flags).

        The orchestrator no longer calls this — start_fit resets all per-round state
        automatically, and load_pretrained_weights handles the initial-weights path.
        This method remains available for manual cleanup if needed.
        Model weights (embedder, transformer, projection heads) are never touched.
        """

        # Reset fit state
        self.fit_status = "NOT_STARTED"
        self.fit_message = ""
        self.fit_result = None
        self.fit_cancelled = False

        # Reset evaluate state
        self.evaluate_status = "NOT_STARTED"
        self.evaluate_message = ""
        self.evaluate_result = None
        self.evaluate_cancelled = False

        # Reset progress counters on the existing client
        self.local_client.reset_fit_progress()
        self.local_client.reset_evaluate_progress()

        # Clear local training history so save_model_weights creates a fresh artifact
        self.local_client.training_history = {}

        # Next save_model_weights call will create a new artifact
        self.model_upload_artifact_id = None

        logger.info("Training state reset successfully")
        return {
            "success": True,
            "message": "Training state reset successfully",
        }

    @schema_method
    async def get_properties(self) -> Dict[str, str | int]:
        """Get training and validation metrics."""
        client_properties = self.local_client.get_properties()
        client_properties["artifact_id"] = os.environ["HYPHA_ARTIFACT_ID"]
        return client_properties

    @schema_method
    async def get_transformer_keys(self) -> List[str]:
        """Return the ordered list of transformer state_dict keys.

        Used by the orchestrator to reconstruct a portable transformer-only
        checkpoint from the aggregated global parameters.
        """
        return list(self.local_client.model.transformer.state_dict().keys())

    # TODO: check why arbitrary_types_allowed is needed for numpy arrays
    @schema_method(arbitrary_types_allowed=True)
    async def get_parameters(self) -> Dict[str, Union[List[np.ndarray], str]]:
        """Get the current model parameters. Disabled during fit operations."""
        # Check if fit is running (parameters shouldn't be read during training)
        if self.fit_task is not None and not self.fit_task.done():
            raise RuntimeError("Cannot get parameters while fit task is running")

        # Evaluate doesn't modify parameters, so it's safe to get them during evaluation
        return self.local_client.get_parameters()

    @schema_method(arbitrary_types_allowed=True)
    async def start_fit(
        self,
        parameters: List[np.ndarray] = Field(
            ..., description="A list of NumPy arrays containing the model weights"
        ),
        batch_size: int = Field(
            32,
            description="Batch size to use for training",
        ),
        learning_rate: float = Field(
            0.0001,
            description="Learning rate to use for training",
        ),
        corruption_rate: float = Field(
            0.6, description="ADVANCED: The rate of corruption in each cell"
        ),
        contrastive_scale: float = Field(
            1.0, description="ADVANCED: The scale of contrastive loss"
        ),
        reconstruction_scale: float = Field(
            0.03, description="ADVANCED: The scale of reconstruction loss"
        ),
        temperature: float = Field(
            0.07, description="ADVANCED: The temperature parameter for contrastive loss"
        ),
        limit_train_batches: int = Field(
            None,
            description="ADVANCED: Optional limit on number of training batches to process to control epoch size across clients",
        ),
        server_round: int = Field(
            1,
            description="INTERNAL: The current federated learning server round",
        ),
        orchestrator_service_id: str = Field(
            ...,
            description="INTERNAL: Service ID of the calling orchestrator for validation.",
        ),
    ) -> Dict[str, Union[bool, str]]:
        """Start fitting the model to the training data with the given parameters."""

        self._validate_orchestrator(orchestrator_service_id)

        # Check if any task is already running
        if self.fit_task and not self.fit_task.done():
            raise RuntimeError("A fit task is already running")

        if self.evaluate_task and not self.evaluate_task.done():
            raise RuntimeError(
                "An evaluate task is already running. Only one task (fit or evaluate) can run at a time."
            )

        # Check for valid server round
        if not isinstance(server_round, int) or server_round < 1:
            raise ValueError("server_round must be a positive integer")

        # Reset status and progress for both fit and evaluate
        self.fit_status = "NOT_STARTED"
        self.fit_message = ""
        self.fit_result = None
        self.local_client.reset_fit_progress()

        self.evaluate_status = "NOT_STARTED"
        self.evaluate_message = ""
        self.evaluate_result = None
        self.local_client.reset_evaluate_progress()

        # Set training parameters
        self.config.pretrain_config["learning_rate"] = learning_rate
        self.config.pretrain_config["corruption_rate"] = corruption_rate
        self.config.pretrain_config["contrastive_scale"] = contrastive_scale
        self.config.pretrain_config["reconstruction_scale"] = reconstruction_scale
        self.config.pretrain_config["temperature"] = temperature

        # Start background task
        self.fit_cancelled = False
        self.fit_task = asyncio.create_task(
            self._fit_background(
                parameters=parameters,
                batch_size=batch_size,
                limit_train_batches=limit_train_batches,
                server_round=server_round,
            )
        )

        for _ in range(10):
            if self.fit_status == "RUNNING":
                return {
                    "success": True,
                    "message": "Fit task started successfully",
                }
            await asyncio.sleep(1.0)

        raise RuntimeError("Failed to start fit task")

    @schema_method(arbitrary_types_allowed=True)
    async def start_evaluate(
        self,
        parameters: List[np.ndarray] = Field(
            ..., description="A list of NumPy arrays containing the model weights"
        ),
        batch_size: int = Field(
            32,
            description="Batch size to use for evaluation",
        ),
        limit_val_batches: int = Field(
            None,
            description="ADVANCED: Optional limit on number of validation batches to process to control evaluation size across clients",
        ),
        server_round: int = Field(
            1,
            description="INTERNAL: The current federated learning server round",
        ),
        orchestrator_service_id: str = Field(
            ...,
            description="INTERNAL: Service ID of the calling orchestrator for validation.",
        ),
    ) -> Dict[str, Union[bool, str]]:
        """Start evaluating the model on the test data with the given parameters."""

        self._validate_orchestrator(orchestrator_service_id)

        # Ensure that a fit has been completed before evaluation (training params need to be set)
        if self.fit_status != "COMPLETED":
            raise RuntimeError("Cannot start evaluate before a fit has been completed")

        # Check if any task is already running
        if self.evaluate_task is not None and not self.evaluate_task.done():
            raise RuntimeError("An evaluate task is already running")

        if self.fit_task is not None and not self.fit_task.done():
            raise RuntimeError(
                "A fit task is already running. Only one task (fit or evaluate) can run at a time."
            )

        # Check for valid server round
        if not isinstance(server_round, int) or server_round < 1:
            raise ValueError("server_round must be a positive integer")

        # Reset status and progress for evaluate
        self.evaluate_status = "NOT_STARTED"
        self.evaluate_result = None
        self.local_client.reset_evaluate_progress()

        # Start background task
        self.evaluate_cancelled = False
        self.evaluate_task = asyncio.create_task(
            self._evaluate_background(
                parameters=parameters,
                batch_size=batch_size,
                limit_val_batches=limit_val_batches,
                server_round=server_round,
            )
        )

        for _ in range(5):
            if self.evaluate_status == "RUNNING":
                return {
                    "success": True,
                    "message": "Evaluate task started successfully",
                }
            await asyncio.sleep(1.0)

        raise RuntimeError("Failed to start evaluate task")

    @schema_method(arbitrary_types_allowed=True)
    async def get_fit_status(
        self,
    ) -> Dict[str, Union[List[np.ndarray], dict, str, int, float]]:
        """Get the fit status and progress."""

        status_info = {
            "status": self.fit_status,
            "message": self.fit_message,
            "result": self.fit_result,
        }

        if self.fit_status == "NOT_STARTED":
            status_info["current_batch"] = 0
            status_info["total_batches"] = 0
            status_info["progress"] = 0.0
        else:
            progress_info = self.local_client.get_fit_progress()
            status_info["current_batch"] = progress_info["current_batch"]
            status_info["total_batches"] = progress_info["total_batches"]
            status_info["progress"] = progress_info["progress"]

        return status_info

    @schema_method
    async def get_evaluate_status(self) -> Dict[str, Union[dict, str, int, float]]:
        """Get the evaluate status and progress."""
        progress_info = self.local_client.get_evaluate_progress()

        status_info = {
            "status": self.evaluate_status,
            "message": self.evaluate_message,
            "result": self.evaluate_result,
        }

        if self.evaluate_status == "NOT_STARTED":
            status_info["current_batch"] = 0
            status_info["total_batches"] = 0
            status_info["progress"] = 0.0
        else:
            progress_info = self.local_client.get_evaluate_progress()
            status_info["current_batch"] = progress_info["current_batch"]
            status_info["total_batches"] = progress_info["total_batches"]
            status_info["progress"] = progress_info["progress"]

        return status_info

    @schema_method
    async def cancel_fit(
        self,
        timeout: float = Field(
            30.0,
            description="Time in seconds to wait for fit task to cancel before returning",
        ),
        orchestrator_service_id: str = Field(
            ...,
            description="INTERNAL: Service ID of the calling orchestrator for validation.",
        ),
    ) -> Dict[str, str]:
        """Cancel the ongoing fit task."""
        self._validate_orchestrator(orchestrator_service_id)
        if self.fit_task is None:
            return {"success": False, "message": "No fit task is running"}

        if self.fit_task.done():
            return {
                "success": False,
                "message": "Fit task already completed",
            }

        # Set cancellation flag - this is a cooperative cancellation signal
        self.fit_cancelled = True

        # Cancel the asyncio task
        self.fit_task.cancel()

        # Wait for the task to actually finish (with timeout)
        try:
            await asyncio.wait_for(self.fit_task, timeout=timeout)
        except asyncio.TimeoutError:
            return {
                "success": False,
                "message": f"Fit task was cancelled but did not complete within the timeout period of {timeout} seconds. "
                "Note: PyTorch Lightning training continues the current batch before stopping.",
            }

        return {
            "success": True,
            "message": "Fit task cancelled successfully.",
        }

    @schema_method
    async def cancel_evaluate(
        self,
        timeout: float = Field(
            30.0,
            description="Time in seconds to wait for evaluate task to cancel before returning",
        ),
        orchestrator_service_id: str = Field(
            ...,
            description="INTERNAL: Service ID of the calling orchestrator for validation.",
        ),
    ) -> Dict[str, str]:
        """Cancel the ongoing evaluate task."""
        self._validate_orchestrator(orchestrator_service_id)
        if self.evaluate_task is None:
            return {"success": False, "message": "No evaluate task is running"}

        if self.evaluate_task.done():
            return {
                "success": False,
                "message": "Evaluate task already completed",
            }

        # Set cancellation flag - this is a cooperative cancellation signal
        self.evaluate_cancelled = True

        # Cancel the asyncio task
        self.evaluate_task.cancel()

        # Wait for the task to actually finish (with timeout)
        try:
            await asyncio.wait_for(self.evaluate_task, timeout=timeout)
        except asyncio.TimeoutError:
            return {
                "success": False,
                "message": f"Evaluate task was cancelled but did not complete within the timeout period of {timeout} seconds. "
                "Note: PyTorch Lightning training continues the current batch before stopping.",
            }

        return {
            "success": True,
            "message": "Evaluate task cancelled successfully.",
        }

    @schema_method
    async def is_busy(self) -> bool:
        """Check if the trainer is busy (registered to an orchestrator, or in active fit/evaluate)."""
        fit_busy = self.fit_task is not None and not self.fit_task.done()
        evaluate_busy = self.evaluate_task is not None and not self.evaluate_task.done()
        return self._registered_orchestrator_id is not None or self.session_active or fit_busy or evaluate_busy

    @schema_method
    async def get_registered_orchestrator(self) -> Optional[str]:
        """Return the service ID of the orchestrator this trainer is registered to, or None."""
        return self._registered_orchestrator_id

    @schema_method
    async def ping(self) -> bool:
        """Heartbeat endpoint called by the orchestrator to confirm trainer liveness."""
        return True

    @schema_method
    async def register_to_orchestrator(
        self,
        orchestrator_service_id: str = Field(
            ...,
            description="Hypha service ID of the orchestrator registering this trainer.",
        ),
    ) -> None:
        """Register this trainer to an orchestrator, marking it as busy.

        Once registered, all training API calls require a matching orchestrator_service_id.
        A background ping loop checks orchestrator liveness every 60 s; after 3 consecutive
        failures the registration is automatically cleared.
        """
        if (
            self._registered_orchestrator_id is not None
            and self._registered_orchestrator_id != orchestrator_service_id
        ):
            raise RuntimeError(
                f"Trainer is already registered to orchestrator '{self._registered_orchestrator_id}'. "
                "Unregister first before registering to a different orchestrator."
            )
        self._registered_orchestrator_id = orchestrator_service_id
        self._ping_fail_count = 0
        self._start_orchestrator_ping_loop()
        logger.info(f"Trainer registered to orchestrator '{orchestrator_service_id}'")

    @schema_method
    async def unregister_from_orchestrator(self) -> None:
        """Unregister this trainer from its orchestrator, clearing the busy state."""
        if self._registered_orchestrator_id is None:
            return
        logger.info(f"Trainer unregistered from orchestrator '{self._registered_orchestrator_id}'")
        self._registered_orchestrator_id = None
        self._ping_fail_count = 0
        self.session_active = False
        if self._ping_task is not None and not self._ping_task.done():
            self._ping_task.cancel()
        self._ping_task = None

    def _start_orchestrator_ping_loop(self) -> None:
        """Start background task that pings the registered orchestrator every 120 s.

        Auto-unregisters after 5 consecutive failures (~10 minutes of silence).
        The generous threshold avoids spurious unregistration from transient
        network blips or brief Hypha server hiccups between training rounds.
        """
        if self._ping_task is not None and not self._ping_task.done():
            self._ping_task.cancel()

        async def _ping_loop() -> None:
            while True:
                await asyncio.sleep(120)
                orch_id = self._registered_orchestrator_id
                if orch_id is None:
                    break
                try:
                    svc = await self.hypha_client.get_service(orch_id)
                    await svc.ping()
                    self._ping_fail_count = 0
                except Exception as e:
                    self._ping_fail_count += 1
                    logger.warning(
                        f"Orchestrator ping failed ({self._ping_fail_count}/5): {e}"
                    )
                    if self._ping_fail_count >= 5:
                        logger.warning(
                            "Orchestrator unreachable after 5 consecutive pings — auto-unregistering."
                        )
                        await self.unregister_from_orchestrator()
                        break

        self._ping_task = asyncio.create_task(_ping_loop())

    def _validate_orchestrator(
        self, orchestrator_service_id: str, allow_not_registered: bool = False
    ) -> None:
        """Raise if caller is not the registered orchestrator or trainer is not registered.

        Pass allow_not_registered=True for cleanup calls (e.g. deactivation after auto-unregister)
        so that a trainer that was auto-unregistered by the ping loop can still be cleanly
        notified that the session ended.
        """
        if self._registered_orchestrator_id is None:
            if allow_not_registered:
                return
            raise RuntimeError(
                "Trainer is not registered to any orchestrator. "
                "Call register_to_orchestrator() before issuing training commands."
            )
        if orchestrator_service_id != self._registered_orchestrator_id:
            raise PermissionError(
                f"Orchestrator ID mismatch: this trainer is registered to "
                f"'{self._registered_orchestrator_id}', but got '{orchestrator_service_id}'."
            )

    def _reset_session_watchdog(self) -> None:
        """Restart the per-round watchdog using the stored round timeout.

        Called at the start of every fit and evaluate background task so that
        a crash between rounds (during aggregation or before the next call)
        does not leave the trainer permanently busy.
        """
        if not self.session_active or self._session_round_timeout is None:
            return
        if self._session_watchdog is not None:
            self._session_watchdog.cancel()

        timeout = self._session_round_timeout

        async def _watchdog(t: float) -> None:
            await asyncio.sleep(t)
            if self.session_active:
                logger.warning(
                    f"Session watchdog fired after {t}s without hearing from orchestrator — "
                    "clearing session_active. The orchestrator may have crashed."
                )
                self.session_active = False

        self._session_watchdog = asyncio.create_task(_watchdog(timeout))

    @schema_method
    async def set_session_active(
        self,
        active: bool = Field(
            ...,
            description="True when joining a training session, False when the session ends.",
        ),
        orchestrator_service_id: str = Field(
            ...,
            description="INTERNAL: Service ID of the calling orchestrator for validation.",
        ),
        per_round_timeout: Optional[float] = Field(
            None,
            description=(
                "When active=True, the per-round timeout in seconds. The trainer resets a "
                "watchdog to this value plus an aggregation buffer at the start of every "
                "fit/evaluate call. If the orchestrator does not call back within that window "
                "(e.g. because it crashed), session_active is cleared automatically."
            ),
        ),
        aggregation_buffer: float = Field(
            300.0,
            description="Extra seconds added to per_round_timeout to allow for aggregation and scheduling overhead.",
        ),
    ) -> None:
        """Mark this trainer as part of an active federated training session.

        Called by the orchestrator at the start and end of each training run so that
        the trainer stays marked busy for the full duration of the session — not just
        while its own fit/evaluate step is executing.
        """
        # Allow deactivation even if trainer was auto-unregistered by the ping loop
        self._validate_orchestrator(orchestrator_service_id, allow_not_registered=not active)

        # Cancel any existing watchdog
        if self._session_watchdog is not None:
            self._session_watchdog.cancel()
            self._session_watchdog = None

        self.session_active = active
        logger.info(f"Trainer session_active set to {active}")

        if active and per_round_timeout is not None:
            self._session_round_timeout = per_round_timeout + aggregation_buffer
            self._reset_session_watchdog()
        else:
            self._session_round_timeout = None

    @schema_method
    async def load_pretrained_weights(
        self,
        artifact_id: str = Field(
            description="Artifact ID in format 'workspace/alias'.",
        ),
        file_path: str = Field(
            ..., description="Path to the weights file within the artifact"
        ),
        timeout: int = Field(
            300, description="Timeout in seconds for downloading the weights file"
        ),
    ) -> Dict[str, str]:
        """
        Load pretrained model weights from a Hypha artifact.

        Note: This method runs blocking operations. This should not be a problem
        since the deployment is configured to handle only one request at a time.
        """
        # Check if any task is running
        if (self.fit_task and not self.fit_task.done()) or (
            self.evaluate_task and not self.evaluate_task.done()
        ):
            raise RuntimeError(
                "Cannot load weights while a fit or evaluate task is running"
            )

        # Download weights from artifact
        weights_path = await self._download_from_artifact(
            artifact_id=artifact_id, file_path=file_path, timeout=timeout
        )

        # Load weights into the model
        self.local_client.load_weights(weights_path)
        logger.info(f"Loaded pretrained weights from {weights_path}")

        # Reset fit and evaluate progress
        self.local_client.reset_fit_progress()
        self.local_client.reset_evaluate_progress()

        # Reset training history
        self.local_client.training_history = {}

        # Upload to a new model artifact next time save_model_weights is called
        self.model_upload_artifact_id = None

        return {
            "artifact_id": artifact_id,
            "weights_path": str(weights_path),
        }

    @schema_method
    async def save_model_weights(
        self,
        description: Optional[str] = Field(
            None, description="Optional description for the saved model artifact"
        ),
        upload_timeout: int = Field(
            300, description="Timeout in seconds for uploading the model checkpoint"
        ),
    ) -> str:
        """Save the last model checkpoint as a Hypha artifact and return the artifact ID."""
        weights_folder = Path("./trained_weights")
        if not weights_folder.exists():
            checkpoint = None
        else:
            checkpoint = next(weights_folder.glob(f"*.pth"), None)

        if checkpoint is None:
            raise RuntimeError(
                "No checkpoint found. Please call `start_fit` at least once before saving a model."
            )

        # Build metadata
        dataset_info = self.local_client._properties["dataset_info"]
        dataset_names = [v.get("name", k) for k, v in dataset_info.items()]
        num_rounds = len(self.local_client.training_history.get("train_loss", []))
        total_samples_seen = sum(
            v for _, v in self.local_client.training_history.get("train_samples", [])
        )
        auto_description = (
            f"{num_rounds} federated round{'s' if num_rounds != 1 else ''} · "
            + ", ".join(dataset_names)
            + (f" · {total_samples_seen:,} samples" if total_samples_seen > 0 else "")
        )

        model_manifest = {
            "name": f"Tabula model — {', '.join(dataset_names)}",
            "description": description or auto_description,
            "model_type": "whole_tabula",
            "client_name": self.client_name,
            "client_id": self.client_id,
            "num_rounds": num_rounds,
            "total_samples_seen": total_samples_seen,
            "dataset_info": dataset_info,
        }

        # Read checkpoint file into memory
        checkpoint_content = checkpoint.read_bytes()

        # Ensure collection exists — always create a new artifact per save
        collection_id = await self._create_collection()
        artifact = await self.artifact_manager.create(
            type="model",
            parent_id=collection_id,
            manifest=model_manifest,
            stage=True,
        )

        # Upload model.pth and training_history.json
        weights_upload_url = await self.artifact_manager.put_file(
            artifact.id, file_path="model.pth"
        )
        history_upload_url = await self.artifact_manager.put_file(
            artifact.id, file_path="training_history.json"
        )

        timeout = httpx.Timeout(upload_timeout)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.put(weights_upload_url, content=checkpoint_content)
                response.raise_for_status()
                response = await client.put(
                    history_upload_url,
                    content=json.dumps(self.local_client.training_history, indent=2).encode(),
                )
                response.raise_for_status()
        except Exception as e:
            raise RuntimeError(f"Failed to upload model to artifact '{artifact.id}': {e}")

        await self.artifact_manager.commit(artifact.id)
        logger.info(f"Published whole Tabula model to artifact {artifact.id}")
        return artifact.id


if __name__ == "__main__":
    from pathlib import Path

    import numpy as np
    from bioengine.datasets import BioEngineDatasets

    print("=== Testing TabulaTrainer ===")

    # Set working directory
    app_workdir = Path.home() / ".bioengine" / "apps" / "tabula-trainer"
    app_workdir.mkdir(parents=True, exist_ok=True)
    os.chdir(app_workdir)
    print(f"Current working directory: {os.getcwd()}")

    # Set app directory
    local_artifact_dir = Path(__file__).parent.parent
    os.environ["BIOENGINE_LOCAL_ARTIFACT_PATH"] = str(local_artifact_dir.resolve())
    print(f"Local artifact path: {os.environ['BIOENGINE_LOCAL_ARTIFACT_PATH']}")

    # Set required environment variables
    os.environ["HYPHA_SERVER_URL"] = "https://hypha.aicell.io"
    os.environ["HYPHA_ARTIFACT_ID"] = "chiron-platform/tabula-trainer"

    async def test_trainer():
        # Initialize a BioEngineDatasets instance
        bioengine_datasets = BioEngineDatasets(
            data_server_url="auto",
            hypha_token=None,  # os.getenv("HYPHA_TOKEN"),
        )

        available_datasets = await bioengine_datasets.list_datasets()
        print(f"Available datasets: {available_datasets}")

        # Create TabulaTrainer instance
        trainer = TabulaTrainer.func_or_class(
            datasets=["liver"],  # list(available_datasets.keys()),
            client_id="test_client",
            client_name="Test Client",
        )
        trainer.bioengine_datasets = bioengine_datasets
        await trainer.async_init()

        # Load pretrained weights
        print("Loading pretrained weights:")
        weights_result = await trainer.load_pretrained_weights(
            artifact_id="chiron-platform/tabula-pretrained-weights",
            file_path="avg.pth",
        )
        print(weights_result)

        print("Testing deployment with a single fit batch:")
        await trainer.test_deployment()

        print("Getting properties:")
        properties = await trainer.get_properties()
        print(properties)

        print("Getting parameters:")
        parameters = await trainer.get_parameters()
        print(type(parameters))

        print("Starting fit with 100 batches:")
        await trainer.start_fit(parameters, limit_train_batches=100)

        await asyncio.sleep(10.0)
        print("Cancelling fit:")
        cancel_result = await trainer.cancel_fit()
        print(cancel_result)

        print("Polling fit status after cancellation:")
        fit_status = await trainer.get_fit_status()
        print(fit_status)

        print("Starting fit with limited batches:")
        await trainer.start_fit(parameters, limit_train_batches=3, server_round=1)

        while True:
            await asyncio.sleep(5.0)
            print("Polling fit result:")
            fit_status = await trainer.get_fit_status()
            if fit_status["status"] != "RUNNING":
                fit_result = fit_status.pop("result", None)
                print(fit_status)
                break
            print(fit_status)

        print("Saving model:")
        model_artifact_id = await trainer.save_model_weights()
        print(f"Model artifact ID: {model_artifact_id}")

        print("Starting evaluate:")
        await trainer.start_evaluate(parameters, limit_val_batches=3, server_round=1)

        while True:
            await asyncio.sleep(5.0)
            print("Polling evaluate result:")
            eval_status = await trainer.get_evaluate_status()
            print(eval_status)
            if eval_status["status"] != "RUNNING":
                break

        print("Starting evaluate with all batches:")
        await trainer.start_evaluate(parameters)

        await asyncio.sleep(1.0)
        print("Cancelling evaluate:")
        cancel_eval = await trainer.cancel_evaluate()
        print(cancel_eval)

        print("Polling evaluate status after cancellation:")
        eval_status = await trainer.get_evaluate_status()
        print(eval_status)

        print("Saving model:")
        model_artifact_id = await trainer.save_model_weights()
        print(f"Model artifact ID: {model_artifact_id}")

        await asyncio.sleep(30.0)

    asyncio.run(test_trainer())
