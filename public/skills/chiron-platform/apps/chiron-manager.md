# Chiron Manager — RPC reference

The Chiron Manager is the control plane that runs as a BioEngine app on every Chiron worker. Use it to discover the worker's resources and registered datasets, launch and tear down Orchestrator and Trainer apps, and inspect logs.

Parent skill: [chiron-platform/SKILL.md](../SKILL.md). Sibling sub-skills: [chiron-orchestrator.md](chiron-orchestrator.md), [tabula-trainer.md](tabula-trainer.md).

## When to use this sub-skill

- You are scripting a federated session and need to launch an Orchestrator and several Trainer apps from Python or from another agent run.
- You want to list datasets and decide which to expose to which trainer.
- You need to read deployment logs or inspect a trainer's full status.

For browser-driven workflows the Chiron interface at [chiron.aicell.io/#/worker](https://chiron.aicell.io/#/worker) and [/#/training](https://chiron.aicell.io/#/training) wraps the same RPC surface.

## Connect to a manager

Each worker exposes its manager under the service id pattern `chiron-platform/<worker-id>:chiron-manager`. Discover live IDs instead of hard-coding them:

```python
from hypha_rpc import connect_to_server

server = await connect_to_server({
    "server_url": "https://hypha.aicell.io",
    "token": HYPHA_TOKEN,
    "workspace": "chiron-platform",
})

managers = [s for s in await server.list_services() if s["id"].endswith(":chiron-manager")]
manager = await server.get_service(managers[0]["id"])
```

## Discovery

### `get_worker_info() -> Dict[str, dict]`

Cluster-level snapshot: available datasets (id, manifest), compute resources (CPU/GPU/RAM totals and currently used), geographic location, and a `running_apps` map of currently deployed orchestrator and trainer applications with their busy state. Read-only, safe to poll.

### `get_datasets_info() -> Dict[str, dict]`

Per-dataset details enriched with the data server's zarr-level metadata. The return value is a dict keyed by `dataset_id`. Each entry has the manifest fields plus a `zarr_files` list. Every `zarr_files[i]` entry carries:

```python
{
    "name": "<name>.zarr",
    "n_samples": int,                # total cells in X
    "n_vars": int,                   # total genes in X
    # QC pipeline outputs (only present once the data server has scanned the file):
    "qc_n_cells_kept": int,
    "qc_n_genes_kept": int,
    "n_cells_dropped": int,          # n_samples - qc_n_cells_kept
    "n_genes_dropped": int,
    "hvg_in_feature": int,           # 1200 by default
    "hvg_n_selected": int,           # min(in_feature, qc_n_genes_kept)
    "hvg_histogram_counts": list[int],            # 20-bin log-spaced histogram
    "hvg_histogram_edges_log10": list[float],
    "binning_n_cells": int,
    "binning_n_genes": int,
    "umap_n_sampled": int,
    "umap_method": str,
}
```

Use this to decide which datasets to include in `create_trainer(datasets=[...])` and to surface preprocessing diagnostics to the user before training.

### `get_dataset_card_details(dataset_id: str, zarr_name: str) -> Dict`

On-demand fetch of the heavy per-zarr payloads the dataset-card UI uses. Returns `hvg_scores` (length `n_vars` float array), `umap_coords` (`(m, 2)` array), and `umap_indices` (the subsampled cell indices into the binned matrix when subsampling was applied). Call only when the user opens the dataset card; do not preload for every dataset.

## Lifecycle

### `create_orchestrator(token, trainer_artifact_id, owner_id=None) -> str`

Deploy a new Chiron Orchestrator BioEngine app on the worker. Returns the new `application_id` (used as the service id prefix for the orchestrator). The `owner_id` is recorded for ownership-based deletion. Pass the same Hypha token that authenticated the connection.

### `remove_orchestrator(application_id, force=False, caller_id=None) -> None`

Stop and undeploy an orchestrator. Enforces ownership: only the creator or a worker admin can remove it. If the orchestrator is currently running a session it refuses to stop unless `force=True`.

### `create_trainer(token, datasets, trainer_artifact_id, trainer_id=None, trainer_name=None, pretrained_weights_path=None, pretrained_weights_artifact=None, owner_id=None) -> str`

Deploy a new Trainer BioEngine app bound to a fixed list of dataset ids. Returns the new `application_id`. Two key fields:

- `pretrained_weights_path` — absolute path on the worker's filesystem to a local checkpoint to load before round 1. Mutually exclusive with `pretrained_weights_artifact`.
- `pretrained_weights_artifact` — dict `{"artifact_id": "<workspace>/<alias>", "file_path": "model.pth"}` referring to a checkpoint in `chiron-platform/chiron-models` (or any other Hypha artifact). The trainer downloads it before round 1.

The `datasets` list must contain valid ids from `get_datasets_info()`. The trainer is bound to this dataset list for its lifetime; changing the dataset selection requires `remove_trainer` + `create_trainer`.

### `remove_trainer(application_id, force=False, caller_id=None) -> None`

Stop a trainer. Same ownership and busy-state semantics as `remove_orchestrator`.

## Local models on the worker

### `list_local_model_weights() -> List[dict]`

Inspect saved per-trainer checkpoints under `~/.bioengine/models/` on the worker host. Each entry has `path`, `client_name`, `saved_at`, `description`, `datasets`, `train_samples`, `num_rounds`, `total_samples_seen`. Use this to surface "Resume from local checkpoint" options before publishing to the Hub.

### `clear_local_model_weights() -> List[str]`

Delete every local-model directory. Returns the list of deleted paths. Destructive — confirm with the user first.

## Logs

### `get_app_logs(application_id, logs_tail=100) -> dict`

Fetch Ray Serve status + tail of the last `logs_tail` lines of stdout/stderr per replica for the deployment. Use this for debugging stuck trainers or orchestrators.

## Permissions

Methods that modify state require the caller to be either the creator of the affected resource (matched on `owner_id` recorded at creation time vs. the `caller_id` passed at deletion) or a worker admin (configured in the worker's startup config). The pattern is:

```python
await manager.remove_trainer(
    application_id="tabula-trainer-blood",
    caller_id=server.config.user["id"],   # passed from the client
    force=False,                           # set True to override busy-state check
)
```

If the caller is neither owner nor admin the RPC raises `PermissionError`. If the resource is busy (in an active session) and `force=False` the RPC raises `RuntimeError`. Pass `force=True` only when the user has explicitly confirmed they accept the consequence of removing a busy trainer (e.g. the current session will fail and need to be restarted).
