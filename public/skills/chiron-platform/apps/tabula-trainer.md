# Tabula Trainer — RPC reference

The Tabula Trainer is a Flower client BioEngine app that runs on a Chiron worker and trains on a fixed local subset of that worker's datasets. Most of its methods are called by the orchestrator during a federated round and are not meant to be invoked directly by an agent.

Parent skill: [chiron-platform/SKILL.md](../SKILL.md). Sibling sub-skills: [chiron-manager.md](chiron-manager.md), [chiron-orchestrator.md](chiron-orchestrator.md).

## When to use this sub-skill

Rarely. The orchestrator drives the trainer for you during a federated session. Talk to the trainer directly only when you need to:

- Publish a full per-trainer model (embedder + transformer + projection heads) to the Hub at the end of a run.
- Manually load pretrained weights into a trainer outside of a session.
- Inspect a trainer's on-disk checkpoints from a previous session.
- Manually register a trainer to an orchestrator instead of using the auto-registration flow.

## Service ID

Trainers expose their service under `chiron-platform/<trainer-app-id>:tabula-trainer`. Get a handle from the `application_id` returned by [`manager.create_trainer`](chiron-manager.md):

```python
trainer = await server.get_service(f"chiron-platform/{trainer_app_id}:tabula-trainer")
```

## Properties

### `get_properties() -> dict`

Returns training and validation metric summaries plus the model `artifact_id` the trainer was deployed from.

### `get_transformer_keys() -> List[str]`

Returns the ordered list of `state_dict` keys for the shared transformer (what FedAvg averages). Used by the orchestrator to verify every trainer agrees on the shared key set before round 1.

## Manual orchestrator binding

### `register_to_orchestrator(orchestrator_service_id: str) -> None`

Bind the trainer to an orchestrator. Starts a background ping loop (interval 300 s; auto-unregister after 10 consecutive failures). After this call the orchestrator will include the trainer in the next round.

### `unregister_from_orchestrator() -> None`

Tell the orchestrator to remove this trainer and cancel the local ping loop. Safe to call even outside a session.

### `get_registered_orchestrator() -> str | None`

Returns the orchestrator service id the trainer is currently registered to, or `None`.

### `ping() -> bool`

Heartbeat endpoint called by the orchestrator. Not normally called by an agent.

## Pretrained weights

### `load_pretrained_weights(artifact_id, file_path, timeout=120, transformer_only=False) -> dict`

Download a checkpoint from a Hypha artifact and load it into the trainer's model. The result dict reports which keys were loaded and which were skipped.

- Set `transformer_only=True` when loading a `global_transformer=True` checkpoint from the Hub (the orchestrator does this automatically at the start of every round when `start_training(initial_weights=...)` is set).
- Set `transformer_only=False` when restoring a full per-trainer model previously saved by the same trainer (or its tissue-matched sibling).

## Publishing a full model

### `save_model_weights(description=None, upload_timeout=120, checkpoint_round=None, session_id=None) -> str`

Upload the full Tabula model (embedder, local transformer, projection heads) to `chiron-platform/chiron-models` as a new Hypha artifact. The manifest sets `global_transformer=False`. Returns the new artifact id.

Use this when you want to publish a tissue-specialised checkpoint at the end of a federated session, or to snapshot a trainer's local state for re-loading later. To publish only the FedAvg-aggregated shared transformer instead, use the orchestrator's [save_global_weights](chiron-orchestrator.md).

## Inspecting local checkpoints

| Method | Signature | Purpose |
|---|---|---|
| `list_local_model_weights` | `() -> List[dict]` | List saved full-model directories under `~/.bioengine/models/<client_name>/` with metadata. |
| `list_weight_checkpoints` | `() -> List[dict]` | List per-session round checkpoints (in-memory and on-disk). |
| `clear_local_model_weights` | `() -> List[str]` | Delete every saved full-model directory. Destructive. |
| `reset_training_state` | `() -> dict` | Clear training history, fit/evaluate counters, progress. Does not touch weights. |

## Methods an agent should never call directly

These are the Flower client glue methods the orchestrator drives. Calling them outside of an active session leaves the trainer in an inconsistent state. They are listed here so you know to ignore them, not so you can use them.

- `start_fit(parameters, ..., orchestrator_service_id, session_id)`
- `start_evaluate(parameters, ..., orchestrator_service_id, session_id)`
- `get_fit_status()`, `get_evaluate_status()` — useful for monitoring, but the orchestrator already polls them and surfaces the progress through `get_training_status`.
- `cancel_fit(orchestrator_service_id)`, `cancel_evaluate(orchestrator_service_id)`
- `set_session_active(active, orchestrator_service_id, per_round_timeout, aggregation_buffer)`
- `get_parameters()` — returns the current transformer parameters as a list of numpy arrays. The orchestrator uses this during round 1. Calling it manually mid-session can race with `start_fit`.

For monitoring use [`orchestrator.get_training_status`](chiron-orchestrator.md) instead of polling each trainer.

## How a federated session uses these methods

End-to-end, the flow is:

1. The user (or an agent) calls [`manager.create_trainer(...)`](chiron-manager.md) on every participating worker.
2. Each trainer self-registers via `register_to_orchestrator(<orchestrator_service_id>)`.
3. The user calls [`orchestrator.start_training(...)`](chiron-orchestrator.md).
4. If `initial_weights` is set, the orchestrator broadcasts them and each trainer calls its own `load_pretrained_weights(..., transformer_only=True)`.
5. For each round: the orchestrator hands current weights to each trainer's `start_fit`, polls `get_fit_status`, then calls `start_evaluate` and polls `get_evaluate_status`. The orchestrator aggregates with FedAvg.
6. At the end the user calls either [`orchestrator.save_global_weights`](chiron-orchestrator.md) (transformer-only Hub artifact) or `trainer.save_model_weights` on individual trainers (per-tissue full-model artifacts), or both.
