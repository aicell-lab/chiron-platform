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

Returns the fit and evaluate parameter schemas (Flower-style `fit_config` / `eval_config` dictionaries) that every registered trainer expects, plus a `model` block naming which model they belong to. Call this before `start_training` to see what knobs you can pass and what their defaults are.

The schemas are read live from the registered trainer's own `start_fit` / `start_evaluate` signature, so each model reports its own knobs. The Tabula trainer's `fit_config` includes `batch_size`, `learning_rate`, `corruption_rate`, `contrastive_scale`, `reconstruction_scale`, `temperature`, and `limit_train_batches`, and its `eval_config` includes `batch_size` and `limit_val_batches`. Do not assume those names for another model.

```python
{
    "fit": {...},
    "evaluate": {...},
    "model": {
        "family": "scgpt",
        "display_name": "scGPT",
        "shared_weight_scope": "encoder.+value_encoder.+transformer_encoder.",
    },
}
```

`shared_weight_scope` is the trainer's own weight-scope label, a `+`-joined list of the `state_dict` key prefixes that get averaged each round (Tabula reports `transformer.`). Everything outside it stays site-local. The `model` block requires at least one registered trainer, the same precondition as the schemas. Orchestrators older than 0.3.17 omit it.

## Starting training

### `start_training(num_rounds, fit_config=None, fit_config_per_trainer=None, eval_config=None, eval_config_per_trainer=None, initial_weights=None, per_round_timeout=300, transport="websocket") -> None`

Begin a federated run. The orchestrator validates the configs against every registered trainer, creates a run-artifact in `chiron-platform/chiron-models`, optionally broadcasts initial weights, and enters the round loop.

Parameters:

- `num_rounds: int` — how many FedAvg rounds to execute.
- `fit_config: dict | None` — per-round fit configuration handed to each trainer. Defaults to the schema's defaults.
- `fit_config_per_trainer: dict | None` — per-trainer overrides keyed by trainer service id, merged on top of `fit_config` for that trainer only. Use it to give heterogeneous hardware different batch sizes.
- `eval_config: dict | None` — per-round evaluation configuration.
- `eval_config_per_trainer: dict | None` — same merge semantics, for the evaluation phase.
- `initial_weights: dict | None` — optional pretrained weights, schema `{"artifact_id": "<ws>/<alias>", "file_path": "model.pth"}`. If set, every trainer downloads and loads them via `load_pretrained_weights(transformer_only=True)` before round 1.
- `per_round_timeout: int` — seconds; default `300`. A round that exceeds this is aborted and excluded from the training history. The trainer-side watchdog uses this timeout plus an aggregation buffer to clear its session-active flag if the orchestrator crashes mid-round.
- `transport: "websocket" | "webrtc"` — which transport carries the weight-blob RPCs (`start_fit`, `get_fit_status`, `start_evaluate`, `get_evaluate_status`, `get_parameters`). Default `websocket`. Control-plane calls always use the WebSocket regardless, because they are small and rely on Hypha's routing.

`websocket` relays weights through the Hypha gateway, so it needs nothing but an outbound HTTPS path and works from any site that can reach the platform. `webrtc` opens a peer-to-peer data channel per trainer and the weights never reach the gateway, which is the stronger privacy position, but it needs the two peers to complete an ICE handshake. Peers behind restrictive NATs only manage that through a TURN relay: the orchestrator and the trainer each fetch credentials from the `turn-server/coturn` service, which hands out `turns:turn.hypha.aicell.io:443` over TCP. Port 443 gets through egress filters that block the classic TURN ports (UDP 3478, TCP 5349).

There is deliberately no automatic fallback from `webrtc` to `websocket`. Degrading silently would push weights through the gateway precisely when the caller asked for them not to, so a failed handshake surfaces as an error and the operator decides. In the web interface that decision is the Weight Transport picker in the training configuration panel.

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
