---
name: chiron-maintainer
description: Maintainer-side operations for the Chiron platform and its Tabula trainer. Covers backend environment setup, running a worker locally, BioEngine app upload and deployment, and federated training session orchestration.
---

# Chiron / Tabula maintainer skill

Use this skill when working on the Chiron platform internals: setting up a local Tabula backend, building or redeploying a BioEngine app (`chiron-manager`, `chiron-orchestrator`, `tabula-trainer`), or running a federated training session. For agent or end-user workflows on the public platform, use `public/skills/chiron-platform/SKILL.md` instead.

## Tabula backend setup

All commands assume the `tabula` repo is checked out at `../tabula/` (sibling of this repo). If not present, clone first:

```bash
git clone https://github.com/aicell-lab/tabula ../tabula
```

```bash
conda create -n tabula python=3.11 -y && conda activate tabula
pip install torch==1.13.1+cu117 --extra-index-url https://download.pytorch.org/whl/cu117
MAX_JOBS=4 pip install flash-attn==2.3.5 --no-build-isolation
pip install anndata==0.12.6
pip install "git+https://github.com/aicell-lab/bioengine.git@375dadf#egg=bioengine[datasets,worker]"
pip install -r ../tabula/requirements.txt && pip install -e ../tabula/
```

## Running a local worker

```bash
# Dataset server (standalone)
python -m tabula.datasets --data-dir /path/to/data

# BioEngine Worker that auto-loads chiron-manager
python -m bioengine.worker \
  --mode single-machine \
  --head-num-cpus 3 --head-num-gpus 1 --head-memory-in-gb 30 \
  --startup-applications '{"artifact_id":"chiron-platform/chiron-manager","application_id":"chiron-manager"}'
```

Docker is the preferred local path. The `.env` file in `../tabula/` must define `HYPHA_TOKEN`, `DATA_DIR`, `BIOENGINE_HOME`, `UID`, `GID`. **Important:** `unset HYPHA_TOKEN` from the shell before running docker compose, otherwise the exported shell variable overrides the value in `.env`.

```bash
cd ../tabula/
unset HYPHA_TOKEN && docker compose up -d worker-tabula

# To restart with a refreshed token:
unset HYPHA_TOKEN && docker compose down worker-tabula && docker compose up -d worker-tabula
```

The current trainer image is `ghcr.io/aicell-lab/tabula:0.6.0`.

## Uploading and deploying BioEngine apps

Always use the local BioEngine worker to upload apps. `npx hypha-cli art cp` bypasses the worker's upload pipeline and may not stage or commit correctly.

The token in `../tabula/.env` must be valid for the `chiron-platform` workspace. Check expiry before running:

```python
import base64, json, time
payload = HYPHA_TOKEN.split('.')[1] + '=='
data = json.loads(base64.urlsafe_b64decode(payload))
remaining = data['exp'] - time.time()
print(f"Token valid for {remaining/3600:.1f}h, expires {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(data['exp']))}")
```

```python
import asyncio
from hypha_rpc import connect_to_server

HYPHA_TOKEN = "<chiron-platform token from ../tabula/.env>"
APP_DIR     = "../tabula/apps/chiron_manager"  # or whichever app

async def main():
    server = await connect_to_server({'server_url': 'https://hypha.aicell.io', 'token': HYPHA_TOKEN})

    svcs = await server.list_services()
    worker_svc = next(s for s in svcs if 'bioengine-worker' in s['id'] and 'rtc' not in s['id'])
    worker = await server.get_service(worker_svc['id'])

    files = []
    for fname in ['manifest.yaml', 'manager.py']:  # adjust per app
        with open(f"{APP_DIR}/{fname}") as f:
            files.append({'name': fname, 'content': f.read(), 'type': 'text'})
    artifact_id = await worker.upload_app(files=files)
    print('Uploaded:', artifact_id)

    result = await worker.deploy_app(artifact_id=artifact_id, application_id='chiron-manager')
    print('Deployed:', result)

asyncio.run(main())
```

Notes:

- `worker.upload_app(files=)` uploads to the artifact store and returns the artifact id.
- `worker.deploy_app(artifact_id=, application_id=)` deploys or redeploys the app on Ray Serve. Reuse the same `application_id` to replace in place.
- Pass only `manifest.yaml` and the Python source files. Skip tutorial and docs files.
- The worker must be in the `chiron-platform` workspace. Verify with `server.list_services()`.
- Do **not** pass `_rkwargs=True` to `worker.upload_app` or `worker.deploy_app`. The BioEngine worker's schema validator rejects it.

## Federated training session

Once at least one orchestrator and one or more trainer workers are running, drive the session from the Chiron UI at https://chiron.aicell.io/#/training:

1. Create an Orchestrator application.
2. Create one or more Tabula Trainer applications.
3. Register trainers to the orchestrator.
4. Start federated training rounds.
5. Monitor progress and publish trained weights to the artifact hub.

Resource baseline per site:

| Application | CPU | GPU |
|-------------|-----|-----|
| Tabula Trainer | 1 | 1 |
| Orchestrator | 1 | 0 |
| Manager | 0 | 0 |

The same flow is available via Hypha RPC. See `public/skills/chiron-platform/apps/chiron-orchestrator.md` for the underlying `start_training` contract.
