# Chiron Platform — CLAUDE.md

## What This Repository Is

**Chiron Platform** is the web frontend and federated orchestration layer described in the Nature Biotechnology manuscript:

> *"Toward a privacy-preserving predictive foundation model of single-cell transcriptomics with federated learning and tabular modeling"* — Ding et al.

The paper introduces **Tabula**, a single-cell foundation model that combines:
1. **Tabular learning** — treats each cell as a permutation-invariant row of genes (not an ordered sequence), with gene-wise reconstruction loss and cell-wise contrastive loss.
2. **Federated learning (FL)** — clients train locally on private data; only shared transformer weights are sent to the central server (FedAvg). Raw data never leaves the institution.

Chiron is the platform that makes this deployable. It coordinates BioEngine Workers across institutions so they can participate in collaborative training sessions without sharing raw single-cell data.

> **Current scope:** Tabula is the only model supported. A future version of Chiron will generalize to any single-cell foundation model, so keep the platform layer model-agnostic wherever possible.

### Companion Repositories

| Repo | Location | Purpose |
|------|----------|---------|
| `chiron-platform` | this repo | React UI + federated orchestration apps |
| `tabula` | `./tabula/` (separate git repo) | Tabula model, training code, FL client/server apps |

The `tabula/` folder is a **separate git repository** checked out alongside this one. Do not commit platform changes into it or vice versa.

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
├── tabula/                     # Separate git repo — Tabula model + FL apps
│   ├── tabula/
│   │   ├── model/              # Tabula transformer architecture
│   │   ├── training/           # Training loop and utilities
│   │   ├── datasets/           # AnnData/.h5ad dataset handling
│   │   └── distributed/        # FL client implementation (federated_client.py)
│   └── apps/
│       ├── chiron_manager/     # Control plane — worker lifecycle management
│       ├── chiron_orchestrator/# Flower-based federated server (FedAvg aggregation)
│       └── tabula_trainer/     # Local FL client — trains on local datasets, shares only weights
├── deployment.yaml             # Kubernetes deployment spec
├── tabula/docker-compose.yaml  # Local development orchestration
└── tabula_submission_NBT (official).txt  # Manuscript (NBT submission)
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

### Backend (`tabula/`)
- **Python 3.11**
- **PyTorch 1.13.1** (CUDA 11.7) + **PyTorch Lightning 2.2**
- **Flower (flwr 1.22.0)** for FL coordination (FedAvg)
- **Hypha RPC** — primary cross-service communication; do not introduce alternatives
- **Ray 2.33** for distributed computing
- **AnnData** + **Zarr** for single-cell data serialization

### Infrastructure
- **Docker** (conda/miniforge3, CUDA 11.7) — `ghcr.io/aicell-lab/tabula:0.3.0`
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
```bash
# Conda setup
conda create -n tabula python=3.11 -y && conda activate tabula
pip install torch==1.13.1+cu117 --extra-index-url https://download.pytorch.org/whl/cu117
MAX_JOBS=4 pip install flash-attn==2.3.5 --no-build-isolation
pip install anndata==0.12.6
pip install "git+https://github.com/aicell-lab/bioengine-worker.git@8ad5177#egg=bioengine[datasets,worker]"
pip install -r tabula/requirements.txt && pip install -e tabula/

# Start dataset server
python -m tabula.datasets --data-import-dir /path/to/data

# Start BioEngine Worker (loads chiron-manager on startup)
python -m bioengine.worker \
  --mode single-machine \
  --head-num-cpus 3 --head-num-gpus 1 --head-memory-in-gb 30 \
  --startup-applications '{"artifact_id":"chiron-platform/chiron-manager","application_id":"chiron-manager"}'

# Docker — preferred way to run the worker locally
# The .env file in tabula/ must contain HYPHA_TOKEN, DATA_DIR, BIOENGINE_HOME, UID, GID
# IMPORTANT: unset HYPHA_TOKEN from the shell before running docker compose, otherwise
# the shell variable overrides the .env file value.
cd tabula/
unset HYPHA_TOKEN && docker compose up -d worker-tabula

# To restart the worker with an updated token:
cd tabula/
unset HYPHA_TOKEN && docker compose down worker-tabula && docker compose up -d worker-tabula
```

### Uploading and deploying BioEngine apps

**Always use the local BioEngine worker to upload apps** — do not use `npx hypha-cli art cp` directly, as it bypasses the worker's upload pipeline and may not stage/commit correctly.

The token in `tabula/.env` must be valid for the `chiron-platform` workspace. Check expiry before running:

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

HYPHA_TOKEN = "<chiron-platform token from tabula/.env>"
WORKER_ID   = "chiron-platform/<worker-id>:bioengine-worker"  # discover via list_services()
APP_DIR     = "tabula/apps/chiron_manager"   # or whichever app

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

## Git Conventions

- Always commit as `nilsmechtel` unless the user specifies otherwise.
- Set git identity before committing:
  ```bash
  git -c user.name="nilsmechtel" -c user.email="nils.mechtel@gmail.com" commit ...
  ```

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
| FL client implementation | `tabula/tabula/distributed/federated_client.py` |
| Federated server (FedAvg) | `tabula/apps/chiron_orchestrator/` |
| Local trainer app | `tabula/apps/tabula_trainer/` |
| Control plane | `tabula/apps/chiron_manager/` |
| Platform + training context (manuscript) | `resources/tabula_submission_NBT (official).txt` |
| Platform context (methods) | `resources/tabula_online_methods.md` |
