# Chiron Orchestrator — RPC reference

The Chiron Orchestrator is a Flower server that coordinates one federated training session at a time. It uses the FedAvg aggregation strategy. Use it to configure a session, start training, monitor progress, and publish the aggregated transformer checkpoint to the Hub.

Parent skill: [chiron-platform/SKILL.md](../SKILL.md). Sibling sub-skills: [chiron-manager.md](chiron-manager.md), [tabula-trainer.md](tabula-trainer.md).

## When to use this sub-skill

- You have already used the Chiron Manager to spawn an Orchestrator app and at least one Trainer app.
- You want to start, monitor, or stop the federated training run.
- You want to publish the global transformer checkpoint to the Hub at the end.

## Service ID

Orchestrators expose their service under `chiron-platform/<orch-app-id>:chiron-orchestrator`. Get a handle by resolving the service id you received from the manager's `create_orchestrator`:

```python
orchestrator = await server.get_service(f"chiron-platform/{orch_app_id}:chiron-orchestrator")
```

## Trainer registration

Trainers usually self-register through their own `register_to_orchestrator` method (see [tabula-trainer.md](tabula-trainer.md)). The orchestrator-side methods below are mainly for inspection and emergency cleanup.

| Method | Signature | Purpose |
|---|---|---|
| `add_trainer` | `(trainer_service_id: str, orchestrator_service_id: str) -> None` | Manually register a trainer. Validates the service id and caches the transformer keys. Idempotent. |
| `remove_trainer` | `(trainer_service_id: str) -> None` | Deregister a trainer. Defers removal until the current round finishes if a session is active; otherwise removes immediately. |
| `list_trainers` | `() -> List[str]` | Return every registered trainer service id. Useful for sanity-checking the federation before starting training. |
| `ping` | `() -> bool` | Heartbeat the trainers use to confirm liveness. Not normally called by an agent. |

## Configuring a session

### `get_trainer_params() -> dict`

Returns the fit and evaluate parameter schemas (Flower-style `fit_config` / `eval_config` dictionaries) that every registered trainer expects. Call this before `start_training` to see what knobs you can pass and what their defaults are. The Tabula trainer's `fit_config` includes `batch_size`, `learning_rate`, `corruption_rate`, `contrastive_scale`, `reconstruction_scale`, `temperature`, and `limit_train_batches`. The `eval_config` includes `batch_size` and `limit_val_batches`.

## Starting training

### `start_training(num_rounds, fit_config=None, eval_config=None, initial_weights=None, per_round_timeout=300) -> None`

Begin a federated run. The orchestrator validates the configs against every registered trainer, creates a run-artifact in `chiron-platform/chiron-models`, optionally broadcasts initial weights, and enters the round loop.

Parameters:

- `num_rounds: int` — how many FedAvg rounds to execute.
- `fit_config: dict | None` — per-round fit configuration handed to each trainer. Defaults to the schema's defaults.
- `eval_config: dict | None` — per-round evaluation configuration.
- `initial_weights: dict | None` — optional pretrained weights, schema `{"artifact_id": "<ws>/<alias>", "file_path": "model.pth"}`. If set, every trainer downloads and loads them via `load_pretrained_weights(transformer_only=True)` before round 1.
- `per_round_timeout: int` — seconds; default `300`. A round that exceeds this is aborted and excluded from the training history. The trainer-side watchdog uses this timeout plus an aggregation buffer to clear its session-active flag if the orchestrator crashes mid-round.

The method returns immediately; the actual training loop runs in a background task on the orchestrator. Poll `get_training_status` to track progress.

### `stop_training() -> None`

Halt the current run. Cancels in-flight fit/evaluate tasks on every trainer through their `cancel_fit`/`cancel_evaluate` RPCs. The orchestrator marks the run as stopped and records the last completed round.

### `reset_training_state() -> None`

Clear the orchestrator's in-memory history, parameter cache, round counters, and on-disk per-round checkpoints. Use before starting a brand-new session on the same orchestrator instance to avoid mixing histories. Does not delete published Hub artifacts.

## Monitoring

### `get_training_status() -> Dict[str, Any]`

Live status dictionary. Returned fields:

```python
{
    "is_running": bool,
    "current_round": int,           # 0-indexed; -1 before round 1 starts
    "target_round": int,            # equals num_rounds when running
    "stage": str,                   # "idle" | "broadcasting" | "fit" | "evaluate" | "aggregating"
    "trainers": {
        "<trainer_service_id>": {
            "stage": str,
            "current_batch": int,
            "total_batches": int,
            "latest_metric": float, # most recent train/val loss
        },
        ...
    },
    "pending_removal": List[str],   # trainer service ids queued for removal at round end
    "run_artifact_id": str | None,  # chiron-platform/chiron-models/<alias> for the in-progress run
}
```

### `get_training_history() -> Dict[str, List[float]]`

Per-round training and validation losses plus per-client metric arrays, as `[round_index, value]` pairs. Suitable for plotting.

### `list_global_checkpoints() -> List[dict]`

Inspect the orchestrator's on-disk per-round global parameter checkpoints (the three most recent are kept). Each entry has `path`, `round`, `saved_at`. The most recent checkpoint is also what `save_global_weights` publishes by default.

### `is_busy() -> bool`

True iff a session is currently running. Cheap, safe to poll.

## Publishing to the Hub

### `save_global_weights(description=None, upload_timeout=120, checkpoint_round=None) -> str`

Upload the aggregated transformer-only checkpoint to `chiron-platform/chiron-models` as a new Hypha artifact. The manifest sets `global_transformer=True`. Returns the new artifact id (full path under the chiron-models collection).

Parameters:

- `description: str | None` — free-text description for the artifact manifest.
- `upload_timeout: int` — seconds; default `120`.
- `checkpoint_round: int | None` — which on-disk per-round checkpoint to publish. Defaults to the most recent (typically the final round).

This is the orchestrator's writer. To publish a full per-trainer model (embedder + transformer + projection heads), use the trainer's [save_model_weights](tabula-trainer.md) instead.
