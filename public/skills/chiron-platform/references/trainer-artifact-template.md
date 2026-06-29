# Trainer artifact template

This reference is a working template for adding a new federated trainer for a single-cell foundation model other than Tabula (for example scGPT, Geneformer, your own model). The Chiron Orchestrator and Manager treat any trainer as a black box that satisfies a fixed RPC contract: as long as your new trainer exposes the methods documented below, the rest of Chiron will drive it without any code changes on the orchestrator side.

Parent skill: [chiron-platform/SKILL.md](../SKILL.md). For an end-to-end example of a real trainer that implements this contract, read [/data/nmechtel/tabula/apps/tabula_trainer/](https://github.com/aristoteleo/tabula/tree/main/apps/tabula_trainer/) or the public clone on the chiron-platform workspace.

## When to use this template

Use this template when you want to federate a non-Tabula model across the existing Chiron network without changing the orchestrator. Typical cases:

- You want to fine-tune scGPT or Geneformer with FedAvg on private hospital data.
- You have your own single-cell foundation model and want privacy-preserving training across sites.
- You want a fresh trainer for a downstream task (e.g. cell-type classification head) that uses the same federated infrastructure.

Out of scope: orchestrator-side changes for new aggregation strategies, novel privacy mechanisms (DP-SGD, secure aggregation), or non-FedAvg federation algorithms. The current orchestrator only does FedAvg. Add those when the trainer template is in place.

## Required RPC contract

Every Chiron trainer must expose the following methods through Hypha RPC. Names, signatures, and the meaning of each field are fixed by the orchestrator's expectations.

### Flower client glue (called by the orchestrator)

| Method | Signature | Purpose |
|---|---|---|
| `get_properties` | `() -> Dict[str, str | int]` | Static metadata. Include the model `artifact_id` plus any cached metric summaries. |
| `get_parameters` | `() -> Dict[str, Union[List[np.ndarray], str]]` | Current shared-transformer parameters as a list of numpy arrays plus the ordered key list. The orchestrator broadcasts this in round 1 to seed other trainers. Set `arbitrary_types_allowed=True` on the `@schema_method` decorator. |
| `get_transformer_keys` | `() -> List[str]` | Ordered list of shared transformer `state_dict` keys. Used by the orchestrator to verify federation consistency before round 1. |
| `start_fit` | see signature below | Train one local epoch. Non-blocking; returns `{"status": "started", "message": "..."}`. |
| `get_fit_status` | `() -> dict` | Poll fit progress: status, `current_batch`, `total_batches`, `result` (final loss + updated parameters when status is `completed`). |
| `start_evaluate` | see signature below | Evaluate one local epoch on the validation split. |
| `get_evaluate_status` | `() -> dict` | Same shape as `get_fit_status` but for the eval task. |
| `cancel_fit` | `(timeout: float, orchestrator_service_id: str) -> dict` | Cancel an in-flight fit task. Enforce `orchestrator_service_id` matches the registered orchestrator. |
| `cancel_evaluate` | same shape as `cancel_fit` | |
| `is_busy` | `() -> bool` | True iff a fit or evaluate task is running OR the trainer is in an active session. |
| `set_session_active` | `(active: bool, orchestrator_service_id: str, per_round_timeout: Optional[float], aggregation_buffer: float) -> None` | Mark the trainer as part of an active session; arm or disarm the orchestrator-crash watchdog. |
| `ping` | `() -> bool` | Heartbeat. Return True. |

#### `start_fit` signature

```python
async def start_fit(
    parameters: List[np.ndarray],   # current global parameters from FedAvg
    batch_size: int,
    learning_rate: float,
    server_round: int,
    orchestrator_service_id: str,   # must match self._registered_orch
    session_id: str,                # opaque per-session token
    # ...any model-specific hyperparameters you want exposed to the orchestrator's fit_config...
    limit_train_batches: Optional[int] = None,
) -> Dict[str, Union[bool, str]]:
    ...
```

Returns immediately (non-blocking). The actual training runs in a background `asyncio.Task` or Ray task. The orchestrator polls `get_fit_status` to learn when it is done. When `status == "completed"`, the result dict must contain:

```python
{
    "status": "completed",
    "result": {
        "parameters": List[np.ndarray],   # updated shared transformer params (same order as get_parameters)
        "num_samples": int,                # how many training samples this trainer contributed (FedAvg weight)
        "loss": float,
        "metrics": dict,                   # any extra metrics to surface in training history
    },
}
```

### Orchestrator binding (called by user code or the trainer itself)

| Method | Signature | Purpose |
|---|---|---|
| `register_to_orchestrator` | `(orchestrator_service_id: str) -> None` | Bind to an orchestrator, start a ping background loop. |
| `unregister_from_orchestrator` | `() -> None` | Tell the orchestrator to remove this trainer, cancel the ping loop. |
| `get_registered_orchestrator` | `() -> str | None` | Return the orchestrator service id currently bound to. |

### Model Hub I/O (called by the user)

| Method | Signature | Purpose |
|---|---|---|
| `load_pretrained_weights` | `(artifact_id: str, file_path: str, timeout: int, transformer_only: bool) -> dict` | Download from a Hypha artifact and load into the model. `transformer_only=True` loads only shared keys; `False` loads everything. |
| `save_model_weights` | `(description: Optional[str], upload_timeout: int, checkpoint_round: Optional[int], session_id: Optional[str]) -> str` | Publish the full local model to `chiron-platform/chiron-models` with `manifest.global_transformer=False`. Return the new artifact id. |

### Bookkeeping

| Method | Signature | Purpose |
|---|---|---|
| `list_local_model_weights` | `() -> List[dict]` | Inspect saved local checkpoints under `~/.bioengine/models/<client_name>/`. |
| `list_weight_checkpoints` | `() -> List[dict]` | List per-session round checkpoints grouped by session. |
| `clear_local_model_weights` | `() -> List[str]` | Delete every local checkpoint directory. |
| `reset_training_state` | `() -> dict` | Clear training history, fit/eval counters, progress. Weights untouched. |

## Required manifest fields

Your trainer's `manifest.yaml` follows BioEngine's standard schema. The Chiron-specific bits are:

```yaml
id: my-foundation-model-trainer
type: ray-serve
format_version: 0.5.0
version: 0.1.0
name: My Foundation Model Trainer
description: Federated trainer for <model name> on Chiron.
tags: ["federated learning", "<model name>", "single-cell"]
authorized_users:
  - "*"           # public: any chiron-platform user can deploy this trainer artifact
deployments:
  - trainer:MyFoundationModelTrainer
```

Resource baseline (matches the Tabula trainer):

```python
@serve.deployment(
    ray_actor_options={
        "num_cpus": 1,
        "num_gpus": 1,
        "memory": 16 * 1024 * 1024 * 1024,  # 16 GiB
    },
    max_ongoing_requests=10,
    num_replicas=1,
)
```

Pin `num_replicas=1`. Ray Serve autoscaling will not see in-flight Hypha RPCs as ongoing requests, so an autoscaler will scale a busy trainer down to zero replicas mid-epoch and lose the GPU-resident state.

## Skeleton Python deployment

```python
# trainer.py
import asyncio
import os
from pathlib import Path
from typing import Dict, List, Optional, Union

import numpy as np
import torch
from hypha_rpc.utils.schema import schema_method
from pydantic import Field
from ray import serve


@serve.deployment(
    ray_actor_options={
        "num_cpus": 1,
        "num_gpus": 1,
        "memory": 16 * 1024 * 1024 * 1024,
    },
    max_ongoing_requests=10,
    num_replicas=1,
)
class MyFoundationModelTrainer:
    def __init__(self):
        self.model = self._build_model()           # your model class here
        self._registered_orch: Optional[str] = None
        self._ping_task: Optional[asyncio.Task] = None
        self._session_active = False
        self._session_round_timeout: Optional[float] = None
        self._fit_task: Optional[asyncio.Task] = None
        self._evaluate_task: Optional[asyncio.Task] = None
        self._fit_status = {"status": "idle"}
        self._evaluate_status = {"status": "idle"}

    # --- Flower client glue -----------------------------------------------

    @schema_method
    async def get_properties(self) -> Dict[str, Union[str, int]]:
        return {"artifact_id": os.environ.get("BIOENGINE_APP_ARTIFACT_ID", "")}

    @schema_method
    async def get_transformer_keys(self) -> List[str]:
        return [k for k in self.model.state_dict() if k.startswith("transformer.")]

    @schema_method(arbitrary_types_allowed=True)
    async def get_parameters(self) -> Dict[str, Union[List[np.ndarray], str]]:
        if self._fit_status.get("status") == "running":
            raise RuntimeError("Refuse to read parameters during a running fit task.")
        keys = await self.get_transformer_keys()
        state = self.model.state_dict()
        return {
            "keys": keys,
            "parameters": [state[k].detach().cpu().numpy() for k in keys],
        }

    @schema_method(arbitrary_types_allowed=True)
    async def start_fit(
        self,
        parameters: List[np.ndarray],
        batch_size: int = 32,
        learning_rate: float = 1e-4,
        server_round: int = 0,
        orchestrator_service_id: str = Field(...),
        session_id: str = Field(...),
        limit_train_batches: Optional[int] = None,
    ) -> Dict[str, Union[bool, str]]:
        if self._registered_orch != orchestrator_service_id:
            raise PermissionError("Orchestrator service id mismatch.")
        if self._fit_task and not self._fit_task.done():
            raise RuntimeError("A fit task is already in progress.")
        self._load_transformer_parameters(parameters)
        self._fit_status = {"status": "running", "current_batch": 0, "total_batches": 0}
        self._fit_task = asyncio.create_task(
            self._run_fit(batch_size, learning_rate, limit_train_batches, server_round)
        )
        return {"status": "started", "message": f"Round {server_round} fit started."}

    @schema_method(arbitrary_types_allowed=True)
    async def get_fit_status(self) -> dict:
        return dict(self._fit_status)

    @schema_method
    async def cancel_fit(self, timeout: float, orchestrator_service_id: str) -> dict:
        if self._registered_orch != orchestrator_service_id:
            raise PermissionError("Orchestrator service id mismatch.")
        if self._fit_task and not self._fit_task.done():
            self._fit_task.cancel()
            try:
                await asyncio.wait_for(self._fit_task, timeout)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        self._fit_status = {"status": "cancelled"}
        return {"status": "cancelled"}

    @schema_method
    async def is_busy(self) -> bool:
        running = (
            (self._fit_task and not self._fit_task.done())
            or (self._evaluate_task and not self._evaluate_task.done())
        )
        return bool(running) or self._session_active

    @schema_method
    async def set_session_active(
        self,
        active: bool,
        orchestrator_service_id: str,
        per_round_timeout: Optional[float] = None,
        aggregation_buffer: float = 60.0,
    ) -> None:
        if self._registered_orch != orchestrator_service_id:
            raise PermissionError("Orchestrator service id mismatch.")
        self._session_active = active
        self._session_round_timeout = (
            per_round_timeout + aggregation_buffer if (active and per_round_timeout) else None
        )

    @schema_method
    async def ping(self) -> bool:
        return True

    # --- Orchestrator binding ---------------------------------------------

    @schema_method
    async def register_to_orchestrator(self, orchestrator_service_id: str) -> None:
        orch = await self._server.get_service(orchestrator_service_id)
        await orch.add_trainer(
            trainer_service_id=self._service_id,
            orchestrator_service_id=orchestrator_service_id,
        )
        self._registered_orch = orchestrator_service_id
        if self._ping_task is None or self._ping_task.done():
            self._ping_task = asyncio.create_task(self._ping_loop())

    @schema_method
    async def unregister_from_orchestrator(self) -> None:
        if self._registered_orch is None:
            return
        try:
            orch = await self._server.get_service(self._registered_orch)
            await orch.remove_trainer(trainer_service_id=self._service_id)
        finally:
            self._registered_orch = None
            if self._ping_task is not None:
                self._ping_task.cancel()
                self._ping_task = None

    @schema_method
    async def get_registered_orchestrator(self) -> Optional[str]:
        return self._registered_orch

    # --- Model Hub I/O ----------------------------------------------------

    @schema_method
    async def load_pretrained_weights(
        self,
        artifact_id: str,
        file_path: str = "model.pth",
        timeout: int = 120,
        transformer_only: bool = False,
    ) -> Dict[str, str]:
        am = await self._server.get_service("public/artifact-manager")
        url = await am.get_file(artifact_id=artifact_id, path=file_path)
        local = Path(f"/tmp/{artifact_id.replace('/', '_')}_{file_path}")
        # download to `local`, then:
        state = torch.load(local, map_location="cpu")
        if transformer_only:
            state = {k: v for k, v in state.items() if k.startswith("transformer.")}
        missing, unexpected = self.model.load_state_dict(state, strict=not transformer_only)
        return {"artifact_id": artifact_id, "loaded_keys": str(len(state) - len(missing))}

    @schema_method
    async def save_model_weights(
        self,
        description: Optional[str] = None,
        upload_timeout: int = 120,
        checkpoint_round: Optional[int] = None,
        session_id: Optional[str] = None,
    ) -> str:
        am = await self._server.get_service("public/artifact-manager")
        # write self.model.state_dict() + manifest to chiron-platform/chiron-models,
        # manifest.global_transformer = False
        ...

    # --- Helpers ----------------------------------------------------------

    def _build_model(self):
        # Construct your foundation model here. Must expose a `transformer.*`
        # submodule whose state_dict keys are what FedAvg averages.
        raise NotImplementedError

    def _load_transformer_parameters(self, params: List[np.ndarray]) -> None:
        keys = [k for k in self.model.state_dict() if k.startswith("transformer.")]
        new_state = {
            k: torch.from_numpy(v.copy()).to(self.model.state_dict()[k].device)
            for k, v in zip(keys, params)
        }
        self.model.load_state_dict(new_state, strict=False)

    async def _run_fit(self, batch_size, learning_rate, limit_train_batches, server_round):
        # one epoch of training; update self._fit_status['current_batch'] each step;
        # on completion, set self._fit_status = {"status": "completed", "result": {...}}.
        ...

    async def _ping_loop(self) -> None:
        failures = 0
        while self._registered_orch is not None:
            await asyncio.sleep(300)
            try:
                orch = await self._server.get_service(self._registered_orch)
                await orch.ping()
                failures = 0
            except Exception:
                failures += 1
                if failures >= 10:
                    await self.unregister_from_orchestrator()
                    return
```

This is the minimum surface. Methods like `start_evaluate`, `get_evaluate_status`, `cancel_evaluate`, `list_local_model_weights`, `list_weight_checkpoints`, `clear_local_model_weights`, and `reset_training_state` follow the same pattern; copy them from the Tabula trainer.

## Wiring the new trainer to chiron-manager

No manager changes are needed today. Once your trainer artifact is uploaded to Hypha (typically under `chiron-platform/<your-trainer-alias>`), any user can deploy it on a Chiron worker through:

```python
trainer_app_id = await manager.create_trainer(
    token=HYPHA_TOKEN,
    datasets=["lung_atlas_001", "lung_disease_002"],
    trainer_artifact_id="chiron-platform/my-foundation-model-trainer",
    trainer_name="lung-mfm",
)
```

The manager mounts the trainer container, calls `register_to_orchestrator` (if `orchestrator_service_id` was set at create time), and reports the trainer in `get_worker_info()`.

## Differences from the Tabula trainer

When porting another foundation model, plan for these differences:

- **Dataset-server contract.** Tabula's data server pre-cuts every zarr to `(n_cells, 1200)` and exposes `layers/tabula_binned`. If your model expects a different cell representation (raw counts, log1p, scGPT-style ranked sequences, Geneformer-style ranked tokens), either consume the zarr directly via raw `X` or rerun preprocessing inside your trainer. Avoid both at once.
- **What counts as "shared transformer weights" for FedAvg.** Tabula federates only the `transformer.*` keys, keeping the embedder and projection heads local. Your model must have a clear shared-vs-local key split, expressed through `get_transformer_keys()`. If your model has no local components (single global model), return every key.
- **`in_feature` / sequence length.** Tabula's data server reads `in_feature=1200` from `tabula/framework.yaml`. If your model has a different sequence length, either ship a model-specific data server alongside your trainer or document an alternative dataset-server contract.
- **Federated objectives.** The Tabula objective is `contrastive_scale * L_contrast + reconstruction_scale * L_recon`. Your `fit_config` schema can expose entirely different hyperparameters; the orchestrator passes through whatever you declare.
- **Embedder reuse.** Tabula's federated mode trains tissue-specific embedders locally. If your model has no notion of a per-site embedder, `save_model_weights` and `save_global_weights` collapse to publishing the same set of keys.

## What to test before federating

Run a single-trainer dry run before connecting to multi-site federation.

1. Deploy your trainer locally via `manager.create_trainer(...)` on one worker.
2. Manually call `trainer.register_to_orchestrator(<your-orch-service-id>)`.
3. Call `orchestrator.list_trainers()` and confirm the trainer is listed.
4. Call `orchestrator.start_training(num_rounds=1, fit_config={"batch_size": 8, "learning_rate": 1e-4}, eval_config={"batch_size": 8})` and poll `orchestrator.get_training_status()` until `is_running` is False.
5. Verify `orchestrator.get_training_history()` returns a non-empty entry for round 1.
6. Try `orchestrator.save_global_weights(description="dry-run smoke")` and confirm the artifact appears in `chiron-platform/chiron-models`.

If steps 1–6 pass for one trainer, the multi-site case works by induction: add more trainers via `manager.create_trainer` on additional workers and they will federate without further code changes.
