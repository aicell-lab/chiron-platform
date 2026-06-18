# Chiron Platform — CLAUDE.md

## What This Repository Is

**Chiron Platform** is the web frontend and federated orchestration layer described in the Ding et al. preprint:

> *"Toward a privacy-preserving predictive foundation model of single-cell transcriptomics with federated learning and tabular modeling"* — bioRxiv: https://www.biorxiv.org/content/10.1101/2025.01.06.631427v1

The manuscript is under active revision beyond the bioRxiv v1; the local draft in `resources/` may diverge in title, wording, and figures.

The paper introduces **Tabula**, a single-cell foundation model that combines:
1. **Tabular learning** — treats each cell as a permutation-invariant row of genes (not an ordered sequence), with gene-wise reconstruction loss and cell-wise contrastive loss.
2. **Federated learning (FL)** — clients train locally on private data; only shared transformer weights are sent to the central server (FedAvg). Raw data never leaves the institution.

Chiron is the platform that makes this deployable. It coordinates BioEngine Workers across institutions so they can participate in collaborative training sessions without sharing raw single-cell data.

> **Current scope:** Tabula is the only model supported. A future version of Chiron will generalize to any single-cell foundation model, so keep the platform layer model-agnostic wherever possible.

### Work performed in this repo

Work in this repo spans three connected tracks. Treat any of them as in scope:

1. **Platform code** — the React frontend (`src/`) and the BioEngine worker assets (`worker/`) that together form `chiron.aicell.io`.
2. **Manuscript writing** — drafting and revising the manuscript that builds on the bioRxiv preprint. The current local draft lives at `resources/tabula_submission_NBT (official).md` (see *Manuscript & Figures* below). The whole `resources/` directory is gitignored — do not commit manuscript text or unpublished figures to this repo.
3. **Figure design** — building the manuscript's main and supplementary figures. The active piece of work is **Figure 2** (Chiron platform), under `resources/figure-2/`. Figures 1, 3 and 4 are checked in as flat PNGs at `resources/Figure-{1,3,4}.png` for reference.

Code edits go in `src/` / `worker/`. Manuscript edits go in `resources/tabula_submission_NBT (official).md`. Figure edits go in `resources/figure-2/` (or a sibling figure dir once one exists). Don't conflate the three.

### Companion Repositories

| Repo | Location | Purpose |
|------|----------|---------|
| `chiron-platform` | this repo | React UI + federated orchestration apps |
| `tabula` | `../tabula/` (sibling directory; separate git repo) | Tabula model, training code, FL client/server apps |
| `bioengine` | `../bioengine/` (sibling directory; separate git repo) | Underlying worker/runtime framework that Tabula builds on |

The `tabula` repo is a **separate git repository** checked out alongside this one at `../tabula/`. If it is not available locally, clone it from https://github.com/aicell-lab/tabula. Do not commit platform changes into it or vice versa.

**BioEngine** is the underlying framework that Tabula (and the BioEngine Workers) are built on. The repo lives at `../bioengine/`; if it isn't present locally, it's at https://github.com/aicell-lab/bioengine.

- **You may read files in `../bioengine/` for context**, but **do not make changes there yourself** — leave bioengine edits to the user.
- **Do not patch BioEngine bugs inside `tabula/`** as a workaround. If you find a bug that originates in BioEngine, surface it to the user so it can be fixed in the bioengine repo directly. Workarounds in Tabula mask the real problem and accumulate technical debt.

---

## Repository Structure

```
chiron-platform/
├── src/                        # Frontend — React 18 + TypeScript
│   ├── pages/AgentLab.tsx      # Main notebook-style agent workspace entry point
│   ├── store/hyphaStore.ts     # Hypha connection, auth, artifact state (Zustand)
│   ├── components/
│   │   └── BioEngine/          # Worker dashboard, deployment controls, cluster views
│   ├── hooks/                  # Custom React hooks
│   ├── providers/              # Context providers
│   ├── types/                  # TypeScript type definitions
│   └── utils/                  # Utility functions
├── public/                     # Static assets (logos, icons, manifest)
├── scripts/                    # Deployment and collection setup utilities
├── worker/                     # BioEngine worker assets (Python)
│   ├── file_manager.py         # Dataset file operations
│   ├── ray_deployment_manager.py # Ray job orchestration
│   └── start_worker.py         # Worker initialization
├── deployment.yaml             # Kubernetes deployment spec
└── resources/                  # Manuscript draft, figures, design docs (see "Manuscript & Figures")
    ├── tabula_submission_NBT (official).md  # Full local manuscript draft (results + online methods + captions + supplementary)
    ├── Figure-{1,3,4}.png      # Current main figures (PNG snapshots)
    ├── figure-2/               # Active build dir for Figure 2 (Chiron platform)
    ├── NBT_new_Figure 2_platform_v1.{pdf,svg}  # Latest user reference for the Figure 2 redesign
    ├── new-figure-2-design.md  # Design brief / palette / panel breakdown for Figure 2
    ├── tabula_losses.tsv       # Per-tissue federated training/validation losses (drives Fig 2 loss panel)
    └── {bad,good}-alignment-and.spacing*.png  # Visual standards for chip/container spacing

../tabula/                      # Sibling repo — Tabula model + FL apps (separate git repo)
├── tabula/
│   ├── model/                  # Tabula transformer architecture
│   ├── training/               # Training loop and utilities
│   ├── datasets/               # AnnData/.h5ad dataset handling
│   └── distributed/            # FL client implementation (federated_client.py)
├── apps/
│   ├── chiron_manager/         # Control plane — worker lifecycle management
│   ├── chiron_orchestrator/    # Flower-based federated server (FedAvg aggregation)
│   └── tabula_trainer/         # Local FL client — trains on local datasets, shares only weights
└── docker-compose.yaml         # Local development orchestration
```

---

## Federated Training Architecture (from the manuscript)

Understanding this is essential before editing anything in the training or worker pipeline.

### Model architecture
- **Embedder** (client-specific): converts the cell-by-gene matrix to token embeddings. Each client (tissue/institution) has its own embedder and projection heads — these stay local.
- **Tabular Transformer** (shared): self-attention over gene tokens; uses FlashAttention-2. Weights are averaged across clients via FedAvg.
- **Pretraining objectives**: (1) gene-wise reconstruction loss (MSE, restores corrupted gene expression), (2) cell-wise contrastive loss (SimCLR, distinguishes cell identities).

### Federated workflow
1. Each institution runs a **BioEngine Worker** with two isolated containers: a local data server and a training container.
2. The **Tabula Trainer** (local FL client) trains on local `.h5ad` data. Only transformer weights are uploaded — never raw data.
3. The **Chiron Orchestrator** (Flower-based, any worker) aggregates weights (FedAvg) and broadcasts the global model.
4. The **Chiron Manager** (control plane) tracks worker state and app lifecycle.
5. The **Chiron UI** (this repo's frontend) lets users configure sessions, monitor progress, and publish to a model hub.

### Privacy boundary (hard constraint)
- Raw single-cell data **never leaves** the worker that owns it.
- The orchestrator sees only model parameters and scalar metrics — never training data.
- Dataset access is mediated by authenticated local Hypha services.

---

## Tech Stack

### Frontend (`src/`)
- **React 18** + **TypeScript** — pnpm, react-scripts
- **TailwindCSS 3.4** + **MUI 6** + **styled-components** + **framer-motion**
- **Zustand 5** for state management
- **React Router DOM 6** for navigation
- **Monaco Editor** for in-browser code editing
- **Recharts** for charts
- **hypha-core** + **hypha-rpc** for backend communication

### Backend (`../tabula/`)
- **Python 3.11**
- **PyTorch 1.13.1** (CUDA 11.7) + **PyTorch Lightning 2.2**
- **Flower (flwr 1.22.0)** for FL coordination (FedAvg)
- **Hypha RPC** — primary cross-service communication; do not introduce alternatives
- **Ray 2.33** for distributed computing
- **AnnData** + **Zarr** for single-cell data serialization

### Infrastructure
- **Docker** (conda/miniforge3, CUDA 11.7) — `ghcr.io/aicell-lab/tabula:0.3.3`
- **Kubernetes** for production deployment
- **Docker Compose** for local development

---

## Common Commands

### Frontend
```bash
pnpm install        # Install dependencies
pnpm start          # Dev server → http://localhost:3000
pnpm build          # Production build
pnpm test           # Run tests
```

### Tabula backend
All commands below assume the `tabula` repo is checked out at `../tabula/` (sibling of this repo).
If not present locally, clone it first: `git clone https://github.com/aicell-lab/tabula ../tabula`.

```bash
# Conda setup
conda create -n tabula python=3.11 -y && conda activate tabula
pip install torch==1.13.1+cu117 --extra-index-url https://download.pytorch.org/whl/cu117
MAX_JOBS=4 pip install flash-attn==2.3.5 --no-build-isolation
pip install anndata==0.12.6
pip install "git+https://github.com/aicell-lab/bioengine.git@375dadf#egg=bioengine[datasets,worker]"  # bioengine 0.10.13
pip install -r ../tabula/requirements.txt && pip install -e ../tabula/

# Start dataset server
python -m tabula.datasets --data-dir /path/to/data

# Start BioEngine Worker (loads chiron-manager on startup)
python -m bioengine.worker \
  --mode single-machine \
  --head-num-cpus 3 --head-num-gpus 1 --head-memory-in-gb 30 \
  --startup-applications '{"artifact_id":"chiron-platform/chiron-manager","application_id":"chiron-manager"}'

# Docker — preferred way to run the worker locally
# The .env file in ../tabula/ must contain HYPHA_TOKEN, DATA_DIR, BIOENGINE_HOME, UID, GID
# IMPORTANT: unset HYPHA_TOKEN from the shell before running docker compose, otherwise
# the shell variable overrides the .env file value.
cd ../tabula/
unset HYPHA_TOKEN && docker compose up -d worker-tabula

# To restart the worker with an updated token:
cd ../tabula/
unset HYPHA_TOKEN && docker compose down worker-tabula && docker compose up -d worker-tabula
```

### Uploading and deploying BioEngine apps

**Always use the local BioEngine worker to upload apps** — do not use `npx hypha-cli art cp` directly, as it bypasses the worker's upload pipeline and may not stage/commit correctly.

The token in `../tabula/.env` must be valid for the `chiron-platform` workspace. Check expiry before running:

```python
import base64, json, time
payload = HYPHA_TOKEN.split('.')[1] + '=='
data = json.loads(base64.urlsafe_b64decode(payload))
remaining = data['exp'] - time.time()
print(f"Token valid for {remaining/3600:.1f}h, expires {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(data['exp']))}")
```

Upload and deploy via the worker (Python):

```python
import asyncio
from hypha_rpc import connect_to_server

HYPHA_TOKEN = "<chiron-platform token from ../tabula/.env>"
WORKER_ID   = "chiron-platform/<worker-id>:bioengine-worker"  # discover via list_services()
APP_DIR     = "../tabula/apps/chiron_manager"   # or whichever app

async def main():
    server = await connect_to_server({'server_url': 'https://hypha.aicell.io', 'token': HYPHA_TOKEN})

    # Discover the current worker service ID
    svcs = await server.list_services()
    worker_svc = next(s for s in svcs if 'bioengine-worker' in s['id'] and 'rtc' not in s['id'])
    worker = await server.get_service(worker_svc['id'])

    # Upload all app files (manifest.yaml + Python files)
    files = []
    for fname in ['manifest.yaml', 'manager.py']:   # adjust per app
        with open(f"{APP_DIR}/{fname}") as f:
            files.append({'name': fname, 'content': f.read(), 'type': 'text'})
    artifact_id = await worker.upload_app(files=files)
    print("Uploaded:", artifact_id)

    # Deploy (use the same application_id as before to replace in-place)
    result = await worker.deploy_app(artifact_id=artifact_id, application_id='chiron-manager')
    print("Deployed:", result)

asyncio.run(main())
```

Key notes:
- `worker.upload_app(files=)` uploads to the artifact store and returns the artifact ID.
- `worker.deploy_app(artifact_id=, application_id=)` deploys or redeploys the app on Ray Serve.
- Pass only `manifest.yaml` and the Python source files; skip tutorial/docs files.
- The worker must be in the `chiron-platform` workspace (verify with `server.list_services()`).
- Do **not** pass `_rkwargs=True` to `worker.upload_app` or `worker.deploy_app` — the BioEngine worker's schema validator rejects it.

### Federated training session
After workers are running, manage via the Chiron UI at https://chiron.aicell.io/#/training:
1. Create an Orchestrator application
2. Create one or more Tabula Trainer applications
3. Register trainers to the orchestrator
4. Start federated training rounds
5. Monitor and publish trained weights to the artifact hub

Resource baseline per site:

| Application | CPU | GPU |
|-------------|-----|-----|
| Tabula Trainer | 1 | 1 |
| Orchestrator | 1 | 0 |
| Manager | 0 | 0 |

---

## Manuscript & Figures

The manuscript is drafted and revised alongside the code under `resources/`, which is gitignored — manuscript text never lands in git history. The public version of the work is the bioRxiv preprint linked at the top of this file.

### Manuscript draft

- **Path:** `resources/tabula_submission_NBT (official).md` (~2.7 MB, 1500+ lines).
- **Sections:** Abstract → Introduction → Results (4 subsections) → Discussion → Acknowledgements → Code/Data availability → References → Online Methods → Figure captions (Figs 1–4, Supplementary Figs 1–15) → Supplementary Notes (S1–S4).
- **Results subsections:**
  1. *Tabula redefines single cell foundation models through tabular and federated learning* — model + Chiron platform overview (Fig. 1).
  2. *Tabular learning ... outperforms MLM and AR in both federated and centralized learning settings* — benchmarking story (currently Fig. 2 in the draft caption; see *Figure restructuring* below).
  3. *Tabula accurately recovers pairwise and high-order combinatorial regulation across diverse biological systems with zero-shot prediction* (Fig. 3).
  4. *Tabula predicts skin rejuvenation factors through age- and identity score-guided in silico prioritization* (Fig. 4).
- **Online Methods** covers: pretraining data, model architecture, downstream fine-tuning, rejuvenation discovery, **Chiron federated training platform** (Manager/Orchestrator/Trainer apps), human fibroblast culturing, implementation, and downstream task datasets.

When editing the manuscript, preserve Paperpile reference markers (e.g. `[28](https://paperpile.com/c/mjNULd/lU1N)`) — they are live citation links and renumber automatically; do not flatten them to plain numbers.

### Figure inventory and restructuring

| Figure | Subject | State |
|---|---|---|
| Fig. 1 | Tabula schematic (tabular learning, FL, Chiron platform overview incl. former panel d) | Checked in as `resources/Figure-1.png` |
| Fig. 2 | **Being replaced.** Old: benchmarking. New: Chiron platform — open ecosystem, training modes, learning dynamics, privacy architecture. | Active build at `resources/figure-2/` |
| Fig. 3 | Pairwise + combinatorial regulation prediction | `resources/Figure-3.png` |
| Fig. 4 | Skin rejuvenation factor nomination | `resources/Figure-4.png` |

**Figure 2 is mid-restructure.** The previous Figure 2 (benchmarking) is being moved to the supplement, and the new Figure 2 absorbs and expands the previous Figure 1 panel d (the decentralized training platform schematic). The current draft's `## Figure 2:` caption (line ~618) still describes the old benchmarking content — it will need to be rewritten once the new Figure 2 is settled. References to "panel d" inside the Figure 1 caption should also be re-pointed at the new Figure 2 panels at that time.

### Figure 2 working directory

```
resources/figure-2/
├── STYLE.md                 # Authoritative palette, type scale, components, icons (read before editing any panel)
├── panel-{a,b,c,d,e,motivation}/  # Per-panel SVGs, versioned panel-X-vN.svg + matching PNG
├── grid/                    # Composition pipeline
│   ├── build_manifest.py    # Pick latest panel version, copy in, write manifest.json, chain to build_figure.py
│   ├── build_figure.py      # Compose PNG panels into figure-2-composed.png
│   ├── build_figure_svg.py  # Compose SVG panels into figure-2-composed.svg (vector, print-ready)
│   ├── figure-2-composed.{png,svg}  # Latest composed output
│   └── index.html           # Live preview, polls manifest.json every 5 s
└── render.py                # Render any panel SVG to PNG via cairosvg
```

Typical loop: edit panel SVG → `python3 render.py panel-X/panel-X-vN.svg ...` → `python3 build_manifest.py` → `python3 build_figure_svg.py`.

### Design references and standards

- **`resources/new-figure-2-design.md`** — original written brief for Figure 2 (palette, typography, panel-by-panel intent). Useful background but partly superseded by `figure-2/STYLE.md`.
- **`resources/figure-2/STYLE.md`** — the authoritative current style spec (palette, type scale, components). Read this before editing any Figure 2 panel.
- **`resources/NBT_new_Figure 2_platform_v1.{pdf,svg}`** — most recent user-supplied reference design for Figure 2 (partial sketch).
- **`resources/{bad,good}-alignment-and.spacing*.png`** — visual standards: chips must have ≥ ~18 px padding inside containers. Match `good-alignment-and.spacing.png`, avoid the failure modes in the `bad-*` shots.
- **`resources/previous-fig1-panel-d.png`** — aesthetic reference for the soft, rounded, purple-dominant direction of the new Figure 2.
- **`resources/tabula_losses.tsv`** — per-epoch federated training and validation losses across eight tissues; drives the learning-dynamics panel.

### Hard constraints for figure work

- **32 MB max for any image passed to `Read`.** SVGs with embedded raster look small on disk but balloon as base64. Never `Read` a panel SVG that has embedded raster; render it to a downscaled PNG (≤ 8 MB, long edge ≤ ~2000 px) and read that instead. See `~/.claude/projects/-data-nmechtel-chiron-platform/memory/image_size_limit.md`.
- **Privacy claim is non-negotiable** in every panel: raw single-cell data never leaves the worker; only model weights cross the network. Any privacy/architecture panel must reflect this.
- **Chips never touch container borders.** Maintain ≥ ~18 px padding on all sides — the bad-alignment screenshots show exactly the failure mode to avoid.
- **Print size**: target ≤ 183 mm wide (double-column) and ≤ ~247 mm tall (single page), vector (SVG) output.
- **Don't rename the panel directories.** `panel-a/`, `panel-b/`, etc. are legacy from before a restructure; `grid/manifest.json` handles the panel-letter → directory mapping.

---

## Git Conventions

- Always commit as `nilsmechtel` unless the user specifies otherwise.
- Set git identity before committing:
  ```bash
  git -c user.name="nilsmechtel" -c user.email="nils.mechtel@gmail.com" commit ...
  ```
- **Never push without explicit user confirmation.** Commit locally, show the diff/summary, then ask before running `git push`.

---

## Coding Standards

### TypeScript / React
- Functional components and hooks only.
- Shared/cross-page state lives in Zustand stores.
- Explicit TypeScript types for all RPC responses and structured data.
- Wrap every async call in `try/catch`; surface errors in the UI — do not swallow them.
- Follow the styling language already in the file being edited; do not introduce a new design system.
- Preserve existing component boundaries; no speculative abstractions.

### Python
- PEP 8 compliance; type hints on all public functions.
- Docstrings on significant classes and functions.
- Wrap I/O, network, and filesystem operations in `try/except` with meaningful messages.

### Naming
| Context | Convention |
|---------|------------|
| Python variables/functions | `snake_case` |
| Python classes | `PascalCase` |
| TS/JS variables/functions | `camelCase` |
| TS/JS classes | `PascalCase` |
| Files/folders | `snake_case` or `kebab-case` (consistent within each area) |

---

## Architecture Rules

- **Data privacy is non-negotiable**: raw single-cell data never leaves the worker. Only transformer weights and scalar metrics cross the network.
- **Hypha RPC is the integration layer**: all cross-service calls go through Hypha. Do not add alternative transports.
- **Separation of concerns**: orchestration logic stays out of React components. Worker, dataset, and UI code must not bleed into each other.
- **Platform vs. model**: Chiron platform code should be kept model-agnostic where possible, anticipating future models beyond Tabula.
- When a change touches deployment, service registration, or dataset access, read the relevant worker-side code before editing the UI.
- Prefer the smallest change that addresses the request. No speculative features or design-for-future additions beyond what the task requires.

---

## Key Files to Read Before Editing

| Area | File |
|------|------|
| Agent workspace + Hypha Core setup | `src/pages/AgentLab.tsx` |
| Hypha connection, auth, artifact state | `src/store/hyphaStore.ts` |
| Worker dashboard and deployment UI | `src/components/BioEngine/` |
| Dataset and worker services | `worker/` |
| FL client implementation | `../tabula/tabula/distributed/federated_client.py` |
| Federated server (FedAvg) | `../tabula/apps/chiron_orchestrator/` |
| Local trainer app | `../tabula/apps/tabula_trainer/` |
| Control plane | `../tabula/apps/chiron_manager/` |
| Manuscript draft (results + methods + captions + supplementary) | `resources/tabula_submission_NBT (official).md` |
| Figure 2 working dir (style guide + per-panel SVGs + composition pipeline) | `resources/figure-2/` |
| Figure 2 style spec | `resources/figure-2/STYLE.md` |
| Figure 2 design brief (background context) | `resources/new-figure-2-design.md` |
