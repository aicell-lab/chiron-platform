# Explore published Tabula models

This sub-skill covers how an agent can discover, inspect, and load published Tabula checkpoints from the Chiron Model Hub. It does not cover running zero-shot inference itself — for that see the [tabula repository README](https://github.com/aristoteleo/tabula).

Parent skill: [chiron-platform/SKILL.md](../SKILL.md).

## When to use this sub-skill

- You want to list every published checkpoint, or filter by tissue, federated-session id, or `created_by` user.
- You want to download the weights of a checkpoint and load them into a local Tabula model.
- You want to decide whether a published artifact is a transformer-only checkpoint (orchestrator save) or a full Tabula model with embedder and projection heads (trainer save).

## What's in `chiron-platform/chiron-models`

Every Chiron save writes a Hypha artifact into the public collection `chiron-platform/chiron-models`. Permissions are `{"*": "r+"}`, so any authenticated user can read or publish.

There are two kinds of artifacts in the collection, distinguished by `manifest.global_transformer`:

| `global_transformer` | Written by | Contents | Typical use |
|---|---|---|---|
| `true` | Orchestrator `save_global_weights` | `model.pth` (FedAvg-aggregated shared transformer only), `training_history.json`, `documentation.md` | Pretrained weights for a new trainer in another federated session. Use as `transformer_only=True` when loading. |
| `false` | Trainer `save_model_weights` | `model.pth` (full local model: embedder + transformer + projection heads), `training_history.json`, `documentation.md` | Ready-to-run model for one tissue / institution. Use for inference or downstream fine-tuning. |

Both kinds carry the same training-history metadata (per-round losses, dataset list, number of rounds completed) so the catalogue UI can display them uniformly.

## Discovering checkpoints

Connect to Hypha with a `chiron-platform`-scoped token and list the collection.

```python
from hypha_rpc import connect_to_server

server = await connect_to_server({
    "server_url": "https://hypha.aicell.io",
    "token": HYPHA_TOKEN,
    "workspace": "chiron-platform",
})
am = await server.get_service("public/artifact-manager")

children = await am.list(parent_id="chiron-platform/chiron-models")
print(f"{len(children)} published checkpoints")
for c in children[:5]:
    m = c.get("manifest", {})
    print(c["id"], "—", m.get("name"), "global_transformer=", m.get("global_transformer"))
```

Filter by tag or by `created_by`:

```python
# Only transformer-only checkpoints (suitable as pretrained weights for a new run)
transformer_only = [c for c in children if c["manifest"].get("global_transformer") is True]

# Only checkpoints I published
mine = [c for c in children if c.get("created_by") == server.config.user["id"]]

# By tissue tag
blood = [c for c in children if "blood" in c["manifest"].get("tags", [])]
```

## Reading the manifest

The Chiron frontend renders checkpoints by reading these manifest fields. Reuse them in any custom UI.

| Field | Type | Meaning |
|---|---|---|
| `name` | str | Human-readable title shown in the Hub UI. |
| `description` | str | Free-text description supplied by the publisher. |
| `tags` | list[str] | Free-form tags (e.g. tissue names, dataset families). Used by the Hub UI's search/filter. |
| `tissue` | str / null | Single primary tissue if the checkpoint is tissue-specialised. |
| `n_rounds` | int | Number of federated rounds the underlying session completed. |
| `training_history` | dict | Per-round training and validation loss arrays, mirrored from the orchestrator's training history. |
| `datasets` | dict | Map of trainer service id → list of dataset ids the trainer contributed. |
| `global_transformer` | bool | True for orchestrator (FedAvg-aggregated transformer-only) saves; false for trainer (full model) saves. |
| `session_id` | str / null | Identifier of the federated session that produced this checkpoint. Lets you collect all artifacts from one session. |

## Downloading and loading weights into Tabula locally

```python
# 1. Resolve the artifact and get a presigned URL for model.pth
artifact = await am.read(artifact_id="chiron-platform/chiron-models/<alias>")
url = await am.get_file(artifact_id=artifact["id"], path="model.pth")

# 2. Download
import requests
with open("model.pth", "wb") as fh:
    fh.write(requests.get(url).content)

# 3. Load into Tabula
import torch
import yaml
from tabula.model.tabula import Tabula

with open("tabula/framework.yaml") as fh:
    cfg = yaml.safe_load(fh)["Model"]
model = Tabula(**cfg)

state = torch.load("model.pth", map_location="cpu")
if artifact["manifest"].get("global_transformer"):
    # transformer-only checkpoint, load just the shared keys
    transformer_state = {k: v for k, v in state.items() if k.startswith("transformer.")}
    missing, unexpected = model.load_state_dict(transformer_state, strict=False)
    # Expect missing keys for the embedder and projection heads, which stay local.
else:
    # Full model, load everything
    model.load_state_dict(state, strict=True)
```

The trainer's [load_pretrained_weights](tabula-trainer.md) RPC does the same thing remotely, with a `transformer_only` boolean.

## Running zero-shot inference

This skill stops at "you now have a Tabula model loaded in memory." For the actual inference API (cell type annotation, perturbation prediction, gene-regulation inference) see the [tabula README](https://github.com/aristoteleo/tabula) and the Methods section of the manuscript. The tabula package documents the cell-by-gene matrix preprocessing your inference inputs must satisfy (QC threshold, top-1200 HVG selection, 50-bin quantile encoding) — the same pipeline the [chiron-data-prep skill](https://chiron.aicell.io/skills/chiron-data-prep/SKILL.md) covers from the data side.
