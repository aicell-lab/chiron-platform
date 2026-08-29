---
name: chiron-platform
description: Single entry point for an AI agent working on the Chiron platform. Covers exploring published Tabula models on the Hub, setting up a Chiron worker on your hardware, launching and monitoring federated training, and adding a new foundation-model trainer beyond Tabula. Chiron-specific only. For general BioEngine concerns (worker install, app deployment plumbing, manifest format) follow the bioengine skill.
compatibility: Designed for Claude Code, Gemini CLI, or any agent that can read a URL, call Hypha RPC, and execute Python.
metadata:
  author: chiron-platform
  version: "1.1"
  sub-skills:
    - apps/explore-tabula-models.md
    - apps/chiron-manager.md
    - apps/chiron-orchestrator.md
    - apps/tabula-trainer.md
    - references/data-prep.md
    - references/trainer-artifact-template.md
  related-skills:
    - https://bioimage.io/public/skills/bioengine/SKILL.md
---

# Chiron platform

The Chiron platform ([https://chiron.aicell.io](https://chiron.aicell.io)) is a decentralized training and reuse platform for single-cell foundation models. It is built on top of [BioEngine](https://github.com/aicell-lab/bioengine). The flagship model is Tabula, a privacy-preserving foundation model that combines tabular learning over genes with federated learning across institutions. Trained checkpoints are published to a shared Model Hub. Federated training rounds are coordinated by a central orchestrator. Each participating institution runs a BioEngine Worker pair (data server + trainer) on its own hardware so raw single-cell data never leaves the site.

This skill is the dispatcher. Pick a task below.

## Pick your task

| # | Task | Sub-skill |
|---|------|-----------|
| 1 | Explore published Tabula checkpoints, load weights, run inference locally | [apps/explore-tabula-models.md](apps/explore-tabula-models.md) |
| 2 | Set up a BioEngine Worker for Chiron, register your datasets | [§ 2 below](#2-set-up-a-chiron-worker) + [references/data-prep.md](references/data-prep.md) + [bioengine skill](https://bioimage.io/public/skills/bioengine/SKILL.md) |
| 3 | Launch and monitor a federated training session | [apps/chiron-manager.md](apps/chiron-manager.md) → [apps/chiron-orchestrator.md](apps/chiron-orchestrator.md) → [apps/tabula-trainer.md](apps/tabula-trainer.md) |
| 4 | Contribute a trainer for another single cell foundation model | [references/trainer-artifact-template.md](references/trainer-artifact-template.md) |

## The Chiron platform in one paragraph

Chiron's Hypha workspace is `chiron-platform`. Published model checkpoints live in the Hypha artifact collection `chiron-platform/chiron-models`. Each participating institution runs a BioEngine Worker (registered under `chiron-platform/<worker-id>`) that hosts up to three Chiron BioEngine apps as separate Ray Serve deployments:

- **Chiron Manager** (`<worker>:chiron-manager`) — control plane: discovers datasets, launches and tears down orchestrator and trainer apps, surfaces logs, reports cluster state.
- **Chiron Orchestrator** (`<orch-app>:chiron-orchestrator`) — Flower-based FedAvg server that coordinates one federated training session at a time.
- **Trainer** (`<trainer-app>:<model>-trainer`, for example `:tabula-trainer`) — local Flower client that trains on the institution's private datasets. There can be many trainer apps registered to one orchestrator, all training the same model.

The manager and the orchestrator are model-agnostic. The trainer is not: each worker image carries exactly one model's dependencies and hosts that model's trainer only (see [§ 2](#2-set-up-a-chiron-worker)). For Tabula, `in_feature` (the gene-sequence length the model consumes) is hard-coded to 1,200 in `tabula/framework.yaml` and the data server pre-cuts every dataset to this width before exposing it to the trainer. The other models read the counts themselves and do their own encoding. Chiron runs on BioEngine v0.11.19, the same major line the bioengine skill at [bioimage.io/public/skills/bioengine/SKILL.md](https://bioimage.io/public/skills/bioengine/SKILL.md) targets. **Use this skill for everything Chiron-specific. Delegate to the bioengine skill for everything BioEngine-general.**

## 1. Explore published Tabula models

See [apps/explore-tabula-models.md](apps/explore-tabula-models.md).

## 2. Set up a Chiron worker

Before generating any launch command, gather the environment yourself rather than asking the user to guess.

**Pick the model first.** A worker's container image decides which model it can train: it carries that model's dependencies and hosts that model's trainer, and no other. Ask the user which model they want to train and launch the matching image.

| Model | Image | Trainer artifact |
|-------|-------|------------------|
| Tabula | `ghcr.io/aicell-lab/chiron-tabula:<version>` | `chiron-platform/tabula-trainer` |
| scGPT | `ghcr.io/aicell-lab/chiron-scgpt:<version>` | `chiron-platform/scgpt-trainer` |
| Geneformer | `ghcr.io/aicell-lab/chiron-geneformer:<version>` | `chiron-platform/geneformer-trainer` |
| scFoundation | `ghcr.io/aicell-lab/chiron-scfoundation:<version>` | `chiron-platform/scfoundation-trainer` |

A site that wants to train two models runs two workers, one per image. Every image declares its identity in `CHIRON_MODEL_FAMILY`, `CHIRON_MODEL_NAME`, `CHIRON_TRAINER_ARTIFACT` and `CHIRON_IMAGE_REF`, which the manager reports as `worker_info.chiron_image` and the Chiron UI shows as the worker's model badge. `create_trainer` defaults to `CHIRON_TRAINER_ARTIFACT` and refuses any trainer artifact declaring a different `model_family`. A worker on an image that predates this contract reports no `chiron_image` and cannot deploy a trainer at all, so the fix is to pull a current image. The setup wizard at [chiron.aicell.io/#/worker](https://chiron.aicell.io/#/worker) has a model selector that fills the right image in for you.

**Detect the host environment.** Run these checks and only ask the user when a check fails or is ambiguous:

- **Operating system**: `uname -srm` (Linux/macOS) or `systeminfo` (Windows). Linux is the supported target; macOS and Windows work through Docker Desktop but cannot pass `--gpus all`.
- **Container runtime**: probe `docker --version`, `podman --version`, `singularity --version`, `apptainer --version` in that order and pick the first that responds. If more than one is installed, ask the user which to use. Docker is the default in the browser wizard.
- **GPU and CUDA**: `nvidia-smi --query-gpu=name,memory.total --format=csv` lists the GPUs and their memory. No NVIDIA driver means CPU-only mode (training will be unusably slow but the worker still boots).
- **Compute headroom**: `nproc` for CPU cores and `free -h` (Linux) or equivalent for RAM. The wizard defaults to 4 CPU and 1 GPU. RAM depends on the model, because Ray admits an application only if its declared memory fits the head node's budget and a worker holds the manager (1 GB), the orchestrator (8 GB) and the trainer at once: **30 GB for Tabula and scGPT, 40 GB for Geneformer, 48 GB for scFoundation**. A worker started with less comes up healthy and then refuses its trainer with `Insufficient resources`. The wizard fills the right figure in when you pick the model.

**Ask the user for what you cannot detect:**

- **Training data location**: either a directory of `.h5ad` files or a list of specific files. If the user has no data ready yet, the worker can still be launched in orchestrator-only mode (skip the data-server, omit the data volume mount).
- **Worker name** (optional): displayed in the Chiron UI; defaults to `Chiron Worker` if not provided.
- **Hypha admin token**: only needed if the user has not pasted one into the prompt themselves. Direct them to log in at [chiron.aicell.io](https://chiron.aicell.io) and use the "AI Agent" tab of the worker setup wizard to inject the token, or generate one manually at [hypha.aicell.io](https://hypha.aicell.io).

**Prepare and register datasets.** Follow the data-prep sub-skill at [references/data-prep.md](references/data-prep.md). It explains the per-dataset folder layout, the `manifest.yaml` schema, the expected AnnData keys (`adata.X` raw counts, `adata.var["gene_id"]` gene tokens), and the per-dataset HVG ranking, value binning, and UMAP the data server computes on first read. Inspect each `.h5ad` against this contract, fix anything that needs adjustment, and gather the prepared datasets into a new data directory laid out as one subfolder per dataset with a `manifest.yaml` each.

**Launch the worker.** Follow the bioengine skill at [bioimage.io/public/skills/bioengine/SKILL.md](https://bioimage.io/public/skills/bioengine/SKILL.md) §1 (Set up a BioEngine worker) for the per-runtime command. For Chiron specifically: launch with `--startup-applications '{"artifact_id":"chiron-platform/chiron-manager","application_id":"chiron-manager"}'` so the Chiron Manager comes up on startup. Easiest is the browser wizard at [chiron.aicell.io/#/worker](https://chiron.aicell.io/#/worker), which writes a one-line launch command for Docker, Podman, Singularity or Apptainer based on the form values.

**Confirm the worker is online.** Once the worker is up, the Chiron interface at [chiron.aicell.io/#/worker](https://chiron.aicell.io/#/worker) will show its name, its registered datasets, and its hardware. The data server rescans the data directory every 30 seconds. You can also query [apps/chiron-manager.md](apps/chiron-manager.md) `get_worker_info()` and `get_datasets_info()` directly via Hypha RPC.

## 3. Run federated training

A federated training run involves three apps cooperating: the manager spawns the orchestrator and trainer apps, the trainers register to the orchestrator, the orchestrator runs FedAvg rounds, and at the end either the orchestrator or a trainer publishes a checkpoint to the Hub. Read the three sub-skills in order:

- [apps/chiron-manager.md](apps/chiron-manager.md) — how to discover workers, datasets, and trainer artifacts; how to launch and tear down orchestrator and trainer applications.
- [apps/chiron-orchestrator.md](apps/chiron-orchestrator.md) — how to start a training session, configure fit and eval parameters, monitor progress, and publish the aggregated transformer checkpoint to the Hub.
- [apps/tabula-trainer.md](apps/tabula-trainer.md) — what the trainer exposes; mostly internal but covers manual orchestrator binding, loading pretrained weights, and publishing a full per-trainer model.

The Chiron web interface at [chiron.aicell.io/#/training](https://chiron.aicell.io/#/training) wraps the same RPC surface in a browser-based form. Driving it via RPC and via the UI are equivalent.

One run-level choice is worth knowing before you start: **Weight Transport**, in the training configuration panel next to Number of Rounds. `WebSocket` relays model weights through the Hypha gateway and works from any network that can reach the platform. `WebRTC` sends them peer to peer so they never reach the gateway, at the cost of needing an ICE handshake that some networks block. Both modes run on the same orchestrator and trainer apps, so switching costs a restart of the run and nothing else. There is no automatic fallback between them, by design: a run that quietly relayed weights through the server after you asked for peer to peer would defeat the point. If the handshake fails, switch to `WebSocket` and start again. Raw data never crosses the network in either mode.

## 4. Contribute a trainer for another single cell foundation model

Chiron's manager and orchestrator do not require code changes to host a new foundation model. The trainer template at [references/trainer-artifact-template.md](references/trainer-artifact-template.md) documents the per-model engineering: extend the Chiron base image with the model's Python dependencies, implement the `trainer.py` against the same Flower client + Hypha RPC contract that `tabula-trainer` uses, and register the result as a new trainer artifact. Each worker image bundles a single foundation model's trainer at build time, so a site that wants to participate in federations for multiple foundation models deploys one worker per model. External contributions for additional foundation models are welcome.

A new model is wired in through three matching declarations, all carrying the same family slug:

- The **adapter** sets `model_family` as a `ClassVar`, plus the display name and the shared-weight scope it reports through `get_properties()`. The orchestrator reads those to label the run, name the parameters in the UI, and describe what FedAvg actually averages.
- The **trainer artifact manifest** sets `model_family: <slug>`. The manager compares it against the image before deploying, so a mismatched pair fails at the button rather than inside Ray.
- The **image** sets `CHIRON_MODEL_FAMILY=<slug>`, `CHIRON_MODEL_NAME`, `CHIRON_TRAINER_ARTIFACT` pointing at that artifact, and `CHIRON_IMAGE_REF`. Nothing else in the platform needs to know the model exists.

## Conventions (read once)

**Workspace.** Everything Chiron-related lives in the Hypha workspace `chiron-platform` on the server `https://hypha.aicell.io`.

**Service IDs.** Chiron service IDs follow the BioEngine pattern `<workspace>/<application_id>:<service_name>`, for example `chiron-platform/europa:chiron-manager`. Discover live service IDs at runtime instead of hard-coding them:

```python
from hypha_rpc import connect_to_server

server = await connect_to_server({
    "server_url": "https://hypha.aicell.io",
    "token": HYPHA_TOKEN,
    "workspace": "chiron-platform",
})

services = await server.list_services()
managers = [s for s in services if s["id"].endswith(":chiron-manager")]
manager = await server.get_service(managers[0]["id"])
```

**Authentication.** Set the `HYPHA_TOKEN` environment variable from a token issued for the `chiron-platform` workspace. The browser flow at [hypha.aicell.io](https://hypha.aicell.io) issues tokens. Read-only methods (`get_worker_info`, `get_datasets_info`, `list_trainers`, etc.) are accessible to any authenticated user. Write methods (`create_orchestrator`, `create_trainer`, `start_training`, `save_*_weights`) enforce ownership via the `caller_id` and `owner_id` parameters; see [apps/chiron-manager.md § Permissions](apps/chiron-manager.md).

**Model Hub collection.** Every published checkpoint, whether shared-weights-only (orchestrator save) or full (trainer save), lives in `chiron-platform/chiron-models`. The artifact manifest carries a `global_transformer` boolean flag that distinguishes the two, and a `model_family` slug saying which model it belongs to. A checkpoint only loads into its own model, so the UI offers each worker the checkpoints of its family alone. Checkpoints published before `model_family` existed are all Tabula. See [apps/explore-tabula-models.md](apps/explore-tabula-models.md).

## Reporting a problem

The **Report Issue** button in the footer of every page on the platform sends us a problem report. No account is needed and there is nothing to fill in: the platform attaches its own log buffer, so you do not have to reconstruct what happened or reproduce it first.

The dialog has one optional field, "What were you trying to do?". That is the part the logs cannot show. Everything that would be sent is viewable before you send it, under "What gets sent", including the log buffer itself. Access tokens and file paths are stripped out in the browser before anything leaves it.

On success the dialog shows a report id. Quote it if you follow up.

Reports go into a collection that only maintainers can read, so one reporter cannot read another's report and neither can we read it back through the website.

## Common pitfalls

- **Stale BioEngine pin.** Chiron expects v0.10.13 (commit `375dadf` on `aicell-lab/bioengine`). A worker on a much older or newer BioEngine version may speak a different RPC dialect.
- **Mixing workspaces.** A `HYPHA_TOKEN` issued for a personal workspace will not see Chiron services. Make sure the token is for `chiron-platform` and that `connect_to_server` passes `workspace="chiron-platform"`.
- **Orphan trainer registrations.** A trainer that registered to an orchestrator and then crashed without unregistering will leave a stale entry. Call `orchestrator.list_trainers()` and `orchestrator.remove_trainer(trainer_service_id)` to clean up, or restart the orchestrator app.
- **Wrong artifact ID format for pretrained weights.** `load_pretrained_weights` and `create_trainer(pretrained_weights_artifact=...)` expect `{"artifact_id": "<ws>/<alias>", "file_path": "model.pth"}`. Passing only `artifact_id` (no `file_path`) silently does nothing.
- **Forgetting `manifest.yaml`.** The data server discovers a dataset folder only if it contains a `manifest.yaml`. See [references/data-prep.md](references/data-prep.md).
