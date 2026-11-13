"""Run driver for the Chiron benchmark matrix: one federated run per
(model family, training mode) cell, each recorded as a JSON file a reader who
was not there can evaluate.

What this is for
================

The benchmark report has one row per cell and five fields per row: the initial
weights, the rounds completed, the loss trajectory, the shared-weight scope,
and the resulting checkpoint. This driver is what fills a row. It runs one cell
at a time and writes `<out>/<cell>.json` with exactly those fields plus the
provenance needed to tell two runs apart.

It deliberately does NOT compare cells. Model families differ in architecture,
tokenisation and pre-training corpus, and the modes differ in what they start
from, so a number from one cell says nothing about another. Each record stands
alone and the report renders them side by side without ranking them.

The six cells
=============

    tabula-pretrain       tabula-continued
    scgpt-pretrain        scgpt-continued
    geneformer-pretrain   geneformer-continued

`pretrain` starts from no weights at all, so its initial-weights field is null
by definition rather than missing. `continued` starts from the family's
published foundation artifact. A third mode, dataset-specific finetuning on a
labelled task, is not built for any family and so has no cell here.

One worker image carries one model family
=========================================

`create_trainer` rejects a trainer from a different family than the worker's
image declares, because the image carries only that family's dependencies
(`CHIRON_MODEL_FAMILY` in the container env). A cell therefore needs its sites
to be running the matching image, and `--sites` is how you say which workers
those are. The driver checks the family before deploying anything, so a cell
pointed at the wrong workers fails immediately rather than half way through.

Two sites must hold DIFFERENT dataset ids
=========================================

A trainer opens every `.zarr` under every dataset id it is given and has no
shard parameter (`_chiron_trainer_base/trainer.py`, `_resolve_zarr_sources`).
Two sites given the same id therefore train on identical data while still
showing a falling loss, which is a federated run in shape and a single-site run
in fact. The driver refuses a cell whose sites do not hold disjoint ids.

Usage
=====

    # what the matrix is, and what each cell would use
    python tests/e2e/benchmark_matrix.py --list

    # resolve everything a cell needs, deploy nothing
    python tests/e2e/benchmark_matrix.py --cell tabula-continued --dry-run \
        --sites europa=tabula_1m_brain,europa-2=tabula_1m_lung

    # run one cell for real
    python tests/e2e/benchmark_matrix.py --cell tabula-continued --rounds 5 \
        --sites europa=tabula_1m_brain,europa-2=tabula_1m_lung

    # complete a record's weight-delta field (needs torch, so run in the image)
    python tests/e2e/benchmark_matrix.py --verify-weights out/tabula-continued.json

Prereqs
=======
- PERSONAL_HYPHA_TOKEN in the environment, or in `<repo-parent>/tabula/.env`.
  The user's own token, not the workspace service account: the run artifact has
  to land in the user's personal workspace, which a workspace-scoped token
  cannot write.
- Two or more workers online per cell, running the cell's family image, each
  serving a dataset id no other site in the cell serves.
- The family's trainer app and foundation artifact published (see MODELS).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
from hypha_rpc import connect_to_server

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HYPHA_BASE = "https://hypha.aicell.io"
WORKSPACE = "chiron-platform"

# The orchestrator app is family-agnostic: it aggregates whatever shared keys
# the trainers report. There is no -e2e alias of it, so benchmark runs deploy
# the published one. Deploying is not republishing, so this is safe.
ORCHESTRATOR_ARTIFACT = "chiron-platform/chiron-orchestrator"

# Per family: the trainer app to deploy, and the published foundation weights
# the `continued` mode starts from. The -e2e trainer aliases are used on
# purpose: a benchmark run must never be able to republish the live app a user
# would deploy from the website.
MODELS: Dict[str, Dict[str, str]] = {
    "tabula": {
        "trainer_artifact": "chiron-platform/tabula-trainer-e2e",
        "foundation_artifact": "chiron-platform/tabula-foundation",
    },
    "scgpt": {
        "trainer_artifact": "chiron-platform/scgpt-trainer-e2e",
        "foundation_artifact": "chiron-platform/scgpt-foundation",
    },
    "geneformer": {
        "trainer_artifact": "chiron-platform/geneformer-trainer-e2e",
        "foundation_artifact": "chiron-platform/geneformer-foundation",
    },
}

MODES = ("pretrain", "continued")

DEFAULT_ROUNDS = 5
DEFAULT_BATCH_SIZE = 8
# A round's budget. Two sites over a 1M-cell tissue shard is minutes, not
# seconds, and a timeout shorter than a round turns a slow site into a failed
# run.
DEFAULT_PER_ROUND_TIMEOUT = 1800
# How long an app may take to reach RUNNING and answer. Families differ by an
# order of magnitude because a BioEngine `@bioengine.smoke_test` runs a real
# one-step fit before the app is declared ready. Measured on the bench pair,
# 2026-11-13, from `create_trainer` to RUNNING: tabula 33s, scgpt 330s. At the
# old 300s budget the scgpt trainer was abandoned 28s before it came up. A
# generous budget costs nothing when the deploy is healthy, because the wait
# returns immediately on FAILED or ERROR rather than sitting out the clock.
# Geneformer is not measured yet, so this leaves room above the worst case
# rather than fitting it.
DEFAULT_DEPLOY_TIMEOUT = 900

def repo_root() -> Path:
    """The repository root, when this file is sitting in it.

    Computed on use rather than at import, and tolerant of not being in a
    checkout at all: --verify-weights runs this file mounted at / inside a
    Chiron image, where there is no tests/e2e above it to walk up from.
    """
    here = Path(__file__).resolve()
    return here.parents[2] if len(here.parents) >= 3 else here.parent


# ---------------------------------------------------------------------------
# Token
# ---------------------------------------------------------------------------

def load_token() -> str:
    """Return the user-scoped PERSONAL_HYPHA_TOKEN.

    The environment wins, so the driver runs from a git worktree where no
    sibling `tabula/.env` exists. Falling back on a path relative to the file
    would resolve to a directory that is only there in the root checkout.
    """
    tok = os.environ.get("PERSONAL_HYPHA_TOKEN", "").strip()
    if tok:
        return tok
    candidates = []
    if os.environ.get("CHIRON_ENV_FILE"):
        candidates.append(Path(os.environ["CHIRON_ENV_FILE"]))
    candidates.append(repo_root().parent / "tabula" / ".env")
    for env_path in candidates:
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            if line.startswith("PERSONAL_HYPHA_TOKEN="):
                val = line.split("=", 1)[1].strip().strip("\"'")
                if val:
                    return val
    raise SystemExit(
        "No PERSONAL_HYPHA_TOKEN. Export it, or point CHIRON_ENV_FILE at an "
        f"env file that sets it, or put it in {repo_root().parent / 'tabula' / '.env'}. "
        "It must be the user's own token: the run artifact lands in the user's "
        "personal workspace, which a workspace-scoped token cannot write."
    )


TOKEN = ""   # set in main(), so --list and --help need no token at all


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

START_TS = time.monotonic()
FAILURES: List[str] = []


def log(msg: str = "") -> None:
    print(f"[{time.monotonic() - START_TS:7.1f}s] {msg}", flush=True)


def log_step(title: str) -> None:
    log()
    log("=" * 78)
    log(f"  {title}")
    log("=" * 78)


def check(ok: bool, ok_msg: str, fail_msg: str) -> bool:
    if ok:
        log(f"   PASS {ok_msg}")
    else:
        log(f"   FAIL {fail_msg}")
        FAILURES.append(fail_msg)
    return bool(ok)


# ---------------------------------------------------------------------------
# Hypha HTTP gateway
# ---------------------------------------------------------------------------

class HTTPCallError(RuntimeError):
    pass


async def hypha_post(service_id: str, method: str, kwargs: Optional[dict] = None,
                     timeout_s: float = 300) -> Any:
    ws, rest = service_id.split("/", 1)
    url = f"{HYPHA_BASE}/{ws}/services/{rest}/{method}"
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(url, headers=headers,
                                 content=json.dumps(kwargs or {}).encode())
        if resp.status_code >= 400:
            raise HTTPCallError(
                f"HTTP {resp.status_code} {service_id}.{method}: {resp.text[:400]}")
        return json.loads(resp.text) if resp.text else None


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def slugify(name: str) -> str:
    """'Chiron Platform Worker - Europa 2' -> 'europa-2'.

    The slug is what `--sites` names, so it has to be derivable from the
    worker's own registered name and stable across a redeploy. Dropping the
    boilerplate prefix leaves the part that distinguishes one worker from
    another.
    """
    s = (name or "").lower()
    for noise in ("chiron platform worker", "chiron worker", "chiron e2e",
                  "chiron", "worker", "bioengine"):
        s = s.replace(noise, " ")
    out = []
    for ch in s:
        out.append(ch if ch.isalnum() else "-")
    return "-".join(p for p in "".join(out).split("-") if p) or "unnamed"


async def list_workspace_services(timeout_s: float = 30) -> List[Dict[str, Any]]:
    """List the workspace's services over HTTP rather than over RPC.

    `server.list_services({"workspace": "chiron-platform"})` hangs once the
    workspace carries enough services. Measured 2026-11-13 on europa, same
    script and token throughout: the call returned in 0.0s with 26 and 28
    services registered and did not return at all within 25-45s with 32 and
    38, across six alternations of bringing one worker up and down. In every
    one of those states `public` and the user's own workspace answered in
    0.0s, each of the ten worker and app services answered individually in
    under a second, and this HTTP endpoint answered in 0.13s with the same
    entries. So the hang is in the workspace-filtered RPC listing itself and
    not in any service it would have returned.

    This is the only call the driver made that hung, and it is the only RPC
    dependency the run loop had left, so routing it over HTTP also removes
    the last reason for the websocket to matter mid-run.
    """
    url = f"{HYPHA_BASE}/{WORKSPACE}/services"
    async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=True) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {TOKEN}"})
        if resp.status_code != 200:
            # An empty list is what a workspace with no workers looks like, so
            # a non-200 must not return one: the caller would read it as "no
            # workers online" and the preflight would blame the fleet.
            raise HTTPCallError(
                f"HTTP {resp.status_code} listing services of {WORKSPACE}: "
                f"{resp.text[:200]}")
        return resp.json() or []


async def discover_workers(server) -> Dict[str, Dict[str, Any]]:
    """Return {slug: {name, manager, family}} for every live Chiron worker.

    Keyed on the worker's own name rather than a hardcoded list of site names.
    An earlier discovery helper matched four fixed hints (berlin, boston,
    stockholm, stanford) and so returns nothing against a fleet that has since
    been renamed, which looks like "no workers online" rather than like a stale
    pattern.

    `server` is still taken, and still has to be a live connection, because
    the callers hold one and the artifact-manager proxy needs it. The listing
    itself no longer goes through it: see `list_workspace_services`.
    """
    svcs = await list_workspace_services()
    # A worker and its manager share the client-id prefix; the manager appends
    # a suffix, so match on the prefix rather than on equality.
    workers: Dict[str, Tuple[str, str]] = {}   # client_id -> (slug, name)
    for svc in svcs:
        sid = svc.get("id", "")
        if "rtc" in sid or not sid.endswith(":bioengine-worker"):
            continue
        client_id = sid.split("/")[-1].split(":")[0]
        name = svc.get("name") or client_id
        workers[client_id] = (slugify(name), name)

    out: Dict[str, Dict[str, Any]] = {}
    for svc in svcs:
        sid = svc.get("id", "")
        if "rtc" in sid or ":chiron-manager" not in sid:
            continue
        mgr_client = sid.split("/")[-1].split(":")[0]
        for client_id, (slug, name) in workers.items():
            if mgr_client.startswith(client_id):
                out[slug] = {
                    "name": name,
                    "manager": sid if "/" in sid else f"{WORKSPACE}/{sid}",
                    "family": None,
                }
    return out


async def manager_for(server, slug: str, retries: int = 10) -> str:
    """Re-resolve a worker's manager service id.

    The id rotates whenever the manager redeploys after a create_* call, so it
    is looked up again on every use rather than cached.
    """
    for _ in range(retries):
        found = await discover_workers(server)
        if slug in found:
            return found[slug]["manager"]
        await asyncio.sleep(2)
    raise RuntimeError(
        f"no worker with slug {slug!r}. Live slugs: "
        f"{sorted((await discover_workers(server)).keys())}")


async def worker_image(server, slug: str) -> Dict[str, Optional[str]]:
    """What a worker's image is, from the worker's own report.

    `worker_info.chiron_image` carries the model family, the trainer app the
    image defaults to, and the image ref. All three go into the record: the
    family is what create_trainer enforces, and the image ref is the only
    thing that says which build produced a number.
    """
    mid = await manager_for(server, slug)
    info = await hypha_post(mid, "get_worker_info", {}, timeout_s=60)
    img = ((info or {}).get("worker_info") or {}).get("chiron_image") or {}
    fam = img.get("model_family") if hasattr(img, "get") else None
    return {
        "model_family": str(fam).lower() if fam else None,
        "model_name": img.get("model_name") if hasattr(img, "get") else None,
        "default_trainer_artifact": (
            img.get("trainer_artifact") if hasattr(img, "get") else None),
        "image_ref": img.get("image_ref") if hasattr(img, "get") else None,
        "bioengine_version": (
            ((info or {}).get("worker_info") or {}).get("bioengine_version")),
    }


async def worker_datasets(server, slug: str) -> List[str]:
    mid = await manager_for(server, slug)
    info = await hypha_post(mid, "get_worker_info", {}, timeout_s=60)
    ds = (info or {}).get("datasets")
    if hasattr(ds, "keys"):
        return sorted(ds.keys())
    if isinstance(ds, list):
        return sorted(str(d) for d in ds)
    return []


# ---------------------------------------------------------------------------
# Deployment
# ---------------------------------------------------------------------------

def _service_id_from_status(entry: Any) -> Optional[str]:
    """Pull the websocket service id out of a status entry.

    `service_ids` arrives as a single dict, a list of dicts, or a dict of
    dicts depending on how Hypha proxied it, so every shape is walked.
    """
    raw = entry.get("service_ids") if hasattr(entry, "get") else None
    candidates: List[Any] = []
    if hasattr(raw, "get") and raw.get("websocket_service_id"):
        candidates.append(raw)
    elif isinstance(raw, list):
        candidates.extend(raw)
    elif hasattr(raw, "values"):
        candidates.extend(raw.values())
    for cand in candidates:
        if hasattr(cand, "get") and cand.get("websocket_service_id"):
            return cand["websocket_service_id"]
    return None


# A read-only method per kind, used only to ask whether the service answers
# yet. Both are already called elsewhere in this driver, so neither adds a
# method the apps are not expected to have.
_READY_PROBE = {"orchestrator": "get_training_status", "trainer": "get_shared_keys"}


async def service_answers(svc: str, kind: str, *, budget_s: float = 120) -> float:
    """Wait until a service actually answers a call, and return how long it took.

    RUNNING is not callable. Measured 2026-11-13 on europa-2: a trainer that
    the worker reported RUNNING went on returning HTTP 404 'Service not found'
    for 21 seconds, and the wildcard `*:<svc>` form failed and then succeeded
    at exactly the same moments as the pinned `<client_id>:<svc>` form, so this
    is a registration delay and not the pinned-lookup defect. Returns -1 if the
    budget runs out, which the caller must treat as a failure rather than as a
    service that is merely slow.
    """
    method = _READY_PROBE[kind]
    t0 = time.time()
    while time.time() - t0 < budget_s:
        try:
            await hypha_post(svc, method, {}, timeout_s=20)
            return time.time() - t0
        except Exception:
            await asyncio.sleep(3)
    return -1.0


async def wait_for_app(server, slug: str, app_id: str, kind: str,
                       timeout_s: float = DEFAULT_DEPLOY_TIMEOUT) -> Optional[str]:
    """Poll until an orchestrator or trainer app reaches RUNNING and answers.

    Returning on RUNNING alone hands back a service id that 404s for up to
    half a minute, which the next step reads as a broken app. So the wait ends
    only once the service has answered a read-only call.
    """
    status_key = "orchestrators_status" if kind == "orchestrator" else "trainers_status"
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        await asyncio.sleep(3)
        try:
            mid = await manager_for(server, slug)
            info = await hypha_post(mid, "get_worker_info", {}, timeout_s=20)
        except Exception:
            continue
        entry = (info.get(status_key) or {}).get(app_id, {})
        state = entry.get("status") if hasattr(entry, "get") else None
        if state != last:
            log(f"   {slug} {kind} {app_id}: {state}")
            last = state
        if state == "RUNNING":
            svc = _service_id_from_status(entry)
            if svc:
                waited = await service_answers(svc, kind)
                if waited < 0:
                    log(f"   {slug} {kind} {app_id} is RUNNING but its service "
                        f"{svc} never answered {_READY_PROBE[kind]}")
                    return None
                log(f"   {slug} {kind} {app_id} service answered after "
                    f"{waited:.1f}s of registration delay")
                return svc
        if state in ("FAILED", "ERROR"):
            return None
    return None


async def deploy_orchestrator(server, slug: str, *, trainer_artifact: str,
                              app_token: str, user_id: str,
                              user_email: str,
                              on_submitted: Callable[[str], None]) -> Tuple[str, str]:
    mid = await manager_for(server, slug)
    app_id = await hypha_post(mid, "create_orchestrator", {
        "token": app_token,
        "trainer_artifact_id": trainer_artifact,
        "owner_id": user_id,
        "owner_email": user_email,
    })
    log(f"   orchestrator app_id = {app_id} (on {slug})")
    on_submitted(app_id)
    svc = await wait_for_app(server, slug, app_id, "orchestrator")
    if not svc:
        raise RuntimeError(f"orchestrator {app_id} on {slug} did not become callable: it either never reached RUNNING or its service never answered. The log above says which.")
    return app_id, svc


async def deploy_trainer(server, slug: str, dataset: str, *, trainer_artifact: str,
                         initial_artifact: Optional[str], app_token: str,
                         user_id: str, user_email: str,
                         batch_size: int,
                         on_submitted: Callable[[str], None]) -> Tuple[str, str]:
    mid = await manager_for(server, slug)
    kwargs: Dict[str, Any] = {
        "token": app_token,
        "datasets": [dataset],
        "trainer_artifact_id": trainer_artifact,
        # The session's fit_config also carries batch_size and the trainer
        # clamps it at max_batch_size, so setting both to the same value keeps
        # the effective batch size equal to the recorded one.
        "max_batch_size": batch_size,
        "owner_id": user_id,
        "owner_email": user_email,
    }
    if initial_artifact:
        # Site-local initial weights. The `continued` mode instead passes the
        # foundation artifact as the session's initial_weights, so the
        # orchestrator broadcasts one starting point to every site rather than
        # each site loading its own.
        kwargs["pretrained_weights_artifact"] = {
            "artifact_id": initial_artifact,
            "file_path": "model.pth",
        }
    app_id = await hypha_post(mid, "create_trainer", kwargs)
    log(f"   trainer app_id = {app_id} (on {slug}, dataset={dataset})")
    on_submitted(app_id)
    svc = await wait_for_app(server, slug, app_id, "trainer")
    if not svc:
        raise RuntimeError(f"trainer {app_id} on {slug} did not become callable: it either never reached RUNNING or its service never answered. The log above says which.")
    return app_id, svc


async def remove_app(server, slug: str, app_id: str, kind: str, user_id: str) -> None:
    try:
        mid = await manager_for(server, slug)
        method = "remove_orchestrator" if kind == "orchestrator" else "remove_trainer"
        await hypha_post(mid, method, {
            "application_id": app_id,
            "force": True,
            "caller_id": user_id,
        }, timeout_s=180)
        log(f"   removed {slug} {kind} {app_id}")
    except Exception as exc:
        log(f"   could not remove {slug} {kind} {app_id}: {exc}")


# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------

async def still_deployed(server, trainer_apps: Dict[str, str],
                         orch_slug: str, orch_app: Optional[str]) -> List[str]:
    """Ask the workers which of this cell's apps are still there.

    `remove_app` swallows its own failure so that one bad teardown does not
    skip the rest, which means the log can say "teardown" and leave three apps
    running. That happened: a closed websocket failed all three removals and
    the run still finished. An app left behind holds GPU on a worker other
    sessions share, so the claim has to be checked rather than assumed.
    """
    left: List[str] = []
    for slug, app_id in list(trainer_apps.items()) + (
            [(orch_slug, orch_app)] if orch_app else []):
        try:
            mid = await manager_for(server, slug)
            info = await hypha_post(mid, "get_worker_info", {}, timeout_s=60)
            present = set((info.get("trainers_status") or {})) | set(
                (info.get("orchestrators_status") or {}))
            if app_id in present:
                left.append(f"{slug}:{app_id}")
        except Exception as exc:
            # Unknown is not gone. Say so rather than reporting a clean sweep.
            left.append(f"{slug}:{app_id} (could not check: {str(exc)[:80]})")
    return left


async def rpc_keepalive(server, every_s: float = 120) -> None:
    """Touch the websocket so the server does not close it mid-run.

    Every call this driver makes to an app goes over HTTP, so between the last
    deploy and the first teardown nothing uses the RPC connection. Measured
    2026-11-13 on a 30-minute run: the server closed it with
    `Idle timeout (600s)` during round 1's evaluation, and teardown then failed
    on all three apps with `Connection is closed`, leaving two trainers and an
    orchestrator deployed and holding GPU on two shared workers. Step 8's
    artifact read failed the same way, so a finished run reported a failure
    about a file that was never looked at.

    Cancelled by the caller, so the normal end of this coroutine is a
    CancelledError and not a return.
    """
    while True:
        await asyncio.sleep(every_s)
        try:
            await server.echo("ping")
        except Exception as exc:
            # Not fatal here: the next real call reports the real failure with
            # the context of what it was doing. Logged so a reader can see the
            # connection was already gone before that call.
            log(f"   keepalive failed: {str(exc)[:120]}")


async def watch_training(orch_svc: str, *, num_rounds: int,
                         budget_s: float) -> Dict[str, Any]:
    """Poll training status until it stops running, and return the last status.

    Returns whatever the orchestrator last reported even on timeout, because a
    run that stalled at round 3 of 5 is a result worth recording rather than an
    exception to swallow.
    """
    last_state: Any = None
    final: Dict[str, Any] = {}
    deadline = time.time() + budget_s
    while time.time() < deadline:
        await asyncio.sleep(3)
        try:
            st = await hypha_post(orch_svc, "get_training_status", {}, timeout_s=20)
        except Exception as exc:
            log(f"   status error: {str(exc)[:140]}")
            continue
        if not isinstance(st, dict):
            continue
        final = st
        state = (st.get("stage"), st.get("current_training_round"), st.get("is_running"))
        if state != last_state:
            log(f"   stage={str(st.get('stage') or '-'):<10} "
                f"round={st.get('current_training_round')} "
                f"running={st.get('is_running')}")
            last_state = state
        if st.get("is_running") is False and st.get("current_training_round"):
            break
    return final


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------

async def artifact_files(artifact_id: str) -> List[str]:
    ws, alias = artifact_id.split("/", 1)
    url = f"{HYPHA_BASE}/{ws}/artifacts/{alias}/files/"
    # follow_redirects, because this endpoint answers 307 on some paths and
    # httpx does not follow by default, which would come back as "no files".
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {TOKEN}"})
        if resp.status_code != 200:
            # An empty list is what an artifact with no files looks like, so a
            # non-200 must not return one. The caller cannot tell them apart.
            raise HTTPCallError(
                f"HTTP {resp.status_code} listing files of {artifact_id}: "
                f"{resp.text[:200]}")
        body = resp.json() or []
        return [f.get("name") for f in body if isinstance(f, dict)]


async def artifact_resolves(am, artifact_id: str, *, budget_s: float = 90) -> Dict[str, Any]:
    """Does this checkpoint id actually resolve, with its weights attached?

    `save_global_weights` returns the id before the file upload finishes, so a
    read that comes back without model.pth is early rather than wrong. Polling
    for the file is the difference between recording a checkpoint and recording
    an id that happens to be well formed.
    """
    out: Dict[str, Any] = {"artifact_id": artifact_id, "readable": False,
                           "files": [], "manifest_name": None,
                           "global_transformer": None}
    try:
        info = await am.read(artifact_id)
        manifest = (info or {}).get("manifest") or {}
        out["readable"] = True
        out["manifest_name"] = manifest.get("name")
        out["global_transformer"] = manifest.get("global_transformer")
    except Exception as exc:
        out["error"] = str(exc)[:300]
        return out
    t0 = time.time()
    deadline = t0 + budget_s
    while time.time() < deadline:
        try:
            out["files"] = await artifact_files(artifact_id)
        except Exception as exc:
            # Keep polling: a listing that fails once is not an artifact
            # without weights. If it never succeeds the error is what the
            # caller reports, instead of an empty file list it would read as
            # a finding about the checkpoint.
            out["files_error"] = str(exc)[:300]
            await asyncio.sleep(3)
            continue
        out.pop("files_error", None)
        if "model.pth" in out["files"]:
            break
        await asyncio.sleep(3)
    # How long it actually polled, so no message can claim a wait that did not
    # happen. The first long run printed "after 90s" about a check that ran
    # for none of it.
    out["polled_s"] = time.time() - t0
    out["has_weights"] = "model.pth" in out["files"]
    if out.get("files_error"):
        out["error"] = out["files_error"]
    return out


# ---------------------------------------------------------------------------
# The matrix
# ---------------------------------------------------------------------------

def cell_id(family: str, mode: str) -> str:
    return f"{family}-{mode}"


def all_cells() -> List[Tuple[str, str]]:
    return [(f, m) for f in MODELS for m in MODES]


def cell_config(cell: str) -> Dict[str, Any]:
    for family, mode in all_cells():
        if cell_id(family, mode) != cell:
            continue
        spec = MODELS[family]
        return {
            "cell": cell,
            "family": family,
            "mode": mode,
            "trainer_artifact": spec["trainer_artifact"],
            "orchestrator_artifact": ORCHESTRATOR_ARTIFACT,
            # null by definition for pretrain, not missing.
            "initial_weights_artifact": (
                None if mode == "pretrain" else spec["foundation_artifact"]),
        }
    raise SystemExit(
        f"unknown cell {cell!r}. Known: {', '.join(cell_id(f, m) for f, m in all_cells())}")


def parse_sites(spec: str) -> Dict[str, str]:
    """'europa=tabula_1m_brain,europa-2=tabula_1m_lung' -> {slug: dataset}."""
    sites: Dict[str, str] = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise SystemExit(f"--sites entry {part!r} is not slug=dataset_id")
        slug, dataset = part.split("=", 1)
        sites[slug.strip()] = dataset.strip()
    return sites


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

async def preflight(server, am, cfg: Dict[str, Any], sites: Dict[str, str],
                    orch_slug: str) -> bool:
    """Check everything a cell needs before deploying any of it.

    Each item is a separate check so a failure says which prerequisite is
    missing rather than that the run failed.
    """
    ok = True
    log_step(f"Preflight for {cfg['cell']}")

    ok &= check(len(sites) >= 2, f"{len(sites)} sites given (a federated run needs 2+)",
                f"{cfg['cell']} needs at least 2 sites, got {len(sites)}: {sorted(sites)}")

    datasets = list(sites.values())
    if len(sites) >= 2:
        ok &= check(len(set(datasets)) == len(datasets),
                    f"site dataset ids are disjoint: {datasets}",
                    "two sites share a dataset id, so they would train on identical "
                    f"data and still show a falling loss: {sites}")
    else:
        # With one site there is nothing for this check to discriminate, and a
        # vacuous PASS beside the failure above would read as reassurance.
        log("   SKIP disjointness: nothing to compare with fewer than 2 sites")

    live = await discover_workers(server)
    log(f"   live worker slugs: {sorted(live)}")
    # The orchestrator may be hosted on one of the sites, so check each worker
    # once rather than once per role.
    for slug in sorted(set(sites) | {orch_slug}):
        ok &= check(slug in live, f"worker {slug!r} is online",
                    f"worker {slug!r} not in the live fleet {sorted(live)}")
    if not ok:
        return False

    images: Dict[str, Dict[str, Optional[str]]] = {}
    for slug in sites:
        img = await worker_image(server, slug)
        images[slug] = img
        fam = img["model_family"]
        if fam is None:
            ok &= check(False, "",
                        f"{slug} does not report worker_info.chiron_image."
                        f"model_family, so the cell's family cannot be checked "
                        f"before deploying")
        else:
            ok &= check(fam == cfg["family"],
                        f"{slug} runs the {fam} image ({img['image_ref']})",
                        f"{slug} runs the {fam!r} image but the cell is "
                        f"{cfg['family']!r}; create_trainer rejects a trainer "
                        f"from another family")
    cfg["site_images"] = images

    for slug, dataset in sites.items():
        have = await worker_datasets(server, slug)
        ok &= check(dataset in have, f"{slug} serves {dataset!r}",
                    f"{slug} does not serve {dataset!r}; it has {have}")

    for label, aid in (("trainer app", cfg["trainer_artifact"]),
                       ("orchestrator app", cfg["orchestrator_artifact"]),
                       ("initial weights", cfg["initial_weights_artifact"])):
        if aid is None:
            log(f"   NOTE initial weights: null by definition for mode "
                f"{cfg['mode']!r}, not missing")
            continue
        try:
            info = await am.read(aid)
            version = ((info or {}).get("manifest") or {}).get("version")
            ok &= check(True, f"{label} {aid} resolves (version {version})", "")
        except Exception as exc:
            ok &= check(False, "", f"{label} {aid} does not resolve: {str(exc)[:200]}")

    return ok


# ---------------------------------------------------------------------------
# One cell
# ---------------------------------------------------------------------------

async def run_cell(server, am, cfg: Dict[str, Any], sites: Dict[str, str], *,
                   orch_slug: str, rounds: int, batch_size: int,
                   per_round_timeout: int, user_id: str, user_email: str,
                   app_token: str, user_workspace: str,
                   keep_apps: bool,
                   limit_train_batches: Optional[int] = None,
                   limit_val_batches: Optional[int] = None) -> Dict[str, Any]:
    """Run one matrix cell and return its record."""
    record: Dict[str, Any] = {
        "cell": cfg["cell"],
        "model_family": cfg["family"],
        "mode": cfg["mode"],
        "initial_weights_artifact": cfg["initial_weights_artifact"],
        "initial_weights_is_null_by_definition": cfg["mode"] == "pretrain",
        "requested_rounds": rounds,
        "batch_size": batch_size,
        # Recorded because it decides what a round means. Unset, a round is a
        # whole epoch over the site's data, which at 250,000 cells and batch 8
        # is 31,250 steps. Set, a round is that many batches and an epoch spans
        # many rounds, so the figure has to travel with any loss curve.
        "limit_train_batches": limit_train_batches,
        # Same reasoning for validation, and it is the one that decides a
        # run's wall clock. Measured 2026-11-13 on a 250,000-cell site: a
        # fit capped at 10 batches took 21s and the uncapped evaluate after
        # it ran for over ten minutes, so a loss curve's cost is set by this
        # field and the val loss is over a different number of cells without
        # it.
        "limit_val_batches": limit_val_batches,
        "orchestrator_app_artifact": cfg["orchestrator_artifact"],
        "trainer_app_artifact": cfg["trainer_artifact"],
        "orchestrator_site": orch_slug,
        "sites": dict(sites),
        # Which build produced the numbers below. A trajectory without this is
        # a number nobody can place.
        "site_images": cfg.get("site_images") or {},
        "started_at_unix": int(time.time()),
        # Filled in below; absent values stay null so a reader can tell a
        # measurement that did not happen from one that came back empty.
        # Written as soon as each app is up, not at the end, so a run that
        # fails mid-way leaves a record naming what it deployed. Without them
        # a failure at step 3 produced a record that said only "uncaught
        # exception" and nothing about which app had not answered.
        "orchestrator_app": None,
        "orchestrator_service_id": None,
        "trainer_apps": {},
        "trainer_service_ids": {},
        # null means teardown never ran to the point of checking, [] means it
        # checked and found nothing left. --keep-apps leaves it null on purpose.
        "leaked_apps": None,
        "run_id": None,
        "run_artifact_id": None,
        "rounds_completed": None,
        "loss_trajectory": None,
        "weight_scope": None,
        "checkpoint": None,
        "weight_delta": {"measured": False,
                         "reason": "run --verify-weights on this record (needs torch)"},
        "failures": [],
    }

    orch_app: Optional[str] = None
    orch_svc: Optional[str] = None
    trainer_apps: Dict[str, str] = {}
    trainer_svcs: Dict[str, str] = {}

    keepalive = asyncio.create_task(rpc_keepalive(server))
    try:
        log_step(f"{cfg['cell']} step 1 - orchestrator on {orch_slug}")

        # Teardown has to own an app from the moment it EXISTS, not from the
        # moment it works. Measured on the scgpt-pretrain cell, 2026-11-13: the
        # trainer was submitted, the driver gave up waiting 28s before it came
        # up, and because the app id was only recorded on success, teardown
        # removed the orchestrator, checked the two apps it knew about, and
        # printed "every app this cell deployed is gone" while
        # `small-leaf-7604` was still holding a GPU on the worker. The check
        # was green about a set that excluded the leak.
        def _claim_orch(app_id: str) -> None:
            nonlocal orch_app
            orch_app = app_id
            record["orchestrator_app"] = app_id

        orch_app, orch_svc = await deploy_orchestrator(
            server, orch_slug, trainer_artifact=cfg["trainer_artifact"],
            app_token=app_token, user_id=user_id, user_email=user_email,
            on_submitted=_claim_orch)
        record["orchestrator_app"] = orch_app
        record["orchestrator_service_id"] = orch_svc

        log_step(f"{cfg['cell']} step 2 - trainers on {', '.join(sites)}")
        for slug, dataset in sites.items():
            app_id, svc = await deploy_trainer(
                server, slug, dataset,
                trainer_artifact=cfg["trainer_artifact"],
                initial_artifact=None,
                app_token=app_token, user_id=user_id, user_email=user_email,
                batch_size=batch_size,
                on_submitted=lambda aid, s=slug: trainer_apps.__setitem__(s, aid))
            trainer_apps[slug] = app_id
            trainer_svcs[slug] = svc
            record["trainer_apps"][slug] = app_id
            record["trainer_service_ids"][slug] = svc

        log_step(f"{cfg['cell']} step 3 - shared weight scope")
        scope: Dict[str, Any] = {"per_site": {}}
        for slug, svc in trainer_svcs.items():
            keys = await hypha_post(svc, "get_shared_keys", {})
            keys = list(keys or [])
            scope["per_site"][slug] = {"shared_key_count": len(keys),
                                       "shared_keys": sorted(keys)}
            log(f"   {slug}: {len(keys)} shared keys")
            check(len(keys) > 0, f"{slug} reports a non-empty shared scope",
                  f"{slug} reports 0 shared keys, so nothing would be federated")
        key_sets = {slug: tuple(v["shared_keys"]) for slug, v in scope["per_site"].items()}
        identical = len(set(key_sets.values())) == 1
        scope["identical_across_sites"] = identical
        # Not a style check. FedAvg averages by key, so a key one site shares
        # and another does not is a weight that gets averaged against nothing.
        check(identical, "every site shares the same key set",
              f"sites disagree on the shared key set: "
              f"{ {s: len(k) for s, k in key_sets.items()} }")
        record["weight_scope"] = scope

        log_step(f"{cfg['cell']} step 4 - register trainers")
        for slug, svc in trainer_svcs.items():
            await hypha_post(orch_svc, "add_trainer", {
                "trainer_service_id": svc,
                "orchestrator_service_id": orch_svc,
            })
            log(f"   registered {slug}")

        log_step(f"{cfg['cell']} step 5 - start_training "
                 f"(rounds={rounds}, initial_weights={cfg['initial_weights_artifact']})")
        fit_config: Dict[str, Any] = {"batch_size": batch_size}
        if limit_train_batches is not None:
            fit_config["limit_train_batches"] = limit_train_batches
        eval_config: Dict[str, Any] = {"batch_size": batch_size}
        if limit_val_batches is not None:
            eval_config["limit_val_batches"] = limit_val_batches
        start_kwargs: Dict[str, Any] = {
            "num_rounds": rounds,
            "fit_config": fit_config,
            "eval_config": eval_config,
            "per_round_timeout": per_round_timeout,
        }
        if cfg["initial_weights_artifact"]:
            start_kwargs["initial_weights"] = {
                "artifact_id": cfg["initial_weights_artifact"],
                "file_path": "model.pth",
            }
        train_task = asyncio.create_task(
            hypha_post(orch_svc, "start_training", start_kwargs,
                       timeout_s=per_round_timeout * rounds + 600))
        final = await watch_training(
            orch_svc, num_rounds=rounds,
            budget_s=per_round_timeout * rounds + 600)
        try:
            await asyncio.wait_for(train_task, timeout=180)
        except Exception as exc:
            log(f"   start_training returned: {str(exc)[:200]}")

        record["run_id"] = final.get("run_id")
        record["run_artifact_id"] = final.get("run_artifact_id")
        record["rounds_completed"] = final.get("current_training_round")
        record["final_stage"] = final.get("stage")
        check(record["rounds_completed"] == rounds,
              f"completed all {rounds} rounds",
              f"completed {record['rounds_completed']} of {rounds} rounds")

        log_step(f"{cfg['cell']} step 6 - loss trajectory")
        history = await hypha_post(orch_svc, "get_training_history", {})
        history = history if isinstance(history, dict) else {}
        per_client = history.get("client_training_losses") or {}
        traj = {
            "rounds": record["rounds_completed"],
            "sites": sorted(sites),
            "site_datasets": dict(sites),
            "training_losses": history.get("training_losses"),
            "validation_losses": history.get("validation_losses"),
            "per_site_training_losses": {k: v for k, v in per_client.items()},
            "train_epochs": history.get("train_epochs"),
            "train_visited_fraction": history.get("train_visited_fraction"),
        }
        record["loss_trajectory"] = traj
        log(f"   training_losses   = {traj['training_losses']}")
        log(f"   validation_losses = {traj['validation_losses']}")
        check(bool(traj["training_losses"]), "a training-loss series exists",
              "no training_losses in the orchestrator's history, so this cell "
              "has no trajectory to plot")
        check(len(per_client) == len(sites),
              f"all {len(sites)} sites contributed per-site losses",
              f"expected {len(sites)} sites in client_training_losses, got "
              f"{len(per_client)}")

        log_step(f"{cfg['cell']} step 7 - publish and resolve the checkpoint")
        try:
            ckpt_id = await hypha_post(orch_svc, "save_global_weights", {
                "description": (
                    f"Chiron benchmark matrix: {cfg['family']} / {cfg['mode']}, "
                    f"{record['rounds_completed']} rounds over "
                    f"{len(sites)} sites ({', '.join(sorted(sites))})"),
            }, timeout_s=600)
            # Deliberately NOT deleted afterwards. The record's whole claim is
            # that this id resolves, so a driver that cleaned it up would
            # publish a row pointing at nothing.
            record["checkpoint"] = await artifact_resolves(am, ckpt_id)
            ck = record["checkpoint"]
            # Two failures, two causes. A read that never happened is not a
            # checkpoint without weights: on the first long run this printed
            # "has no model.pth" about an artifact that had a 3.1 MB model.pth,
            # because the connection had closed before anything was looked at.
            if ck.get("error"):
                check(False, "", f"checkpoint {ckpt_id} was NOT checked: the "
                                 f"read failed, so whether it has weights is "
                                 f"unknown. {ck['error']}")
            else:
                check(ck.get("has_weights") is True,
                      f"checkpoint {ckpt_id} resolves with model.pth attached",
                      f"checkpoint {ckpt_id} was read, and after "
                      f"{ck.get('polled_s', 0):.0f}s of polling its file list "
                      f"still has no model.pth: {ck.get('files')}")
        except Exception as exc:
            check(False, "", f"save_global_weights failed: {str(exc)[:300]}")

        log_step(f"{cfg['cell']} step 8 - run artifact in the user's workspace")
        if record["run_artifact_id"]:
            check(str(record["run_artifact_id"]).startswith(user_workspace + "/"),
                  f"run artifact is under {user_workspace}/",
                  f"run artifact {record['run_artifact_id']!r} is not in "
                  f"{user_workspace}")
            try:
                art = await am.read(artifact_id=record["run_artifact_id"])
                manifest = (art or {}).get("manifest") or {}
                record["run_artifact"] = {
                    "status": manifest.get("status"),
                    "trainers": len(manifest.get("trainers") or {}),
                    "rounds_recorded": len(manifest.get("rounds") or []),
                    "owner_id": manifest.get("owner_id"),
                }
                log(f"   run artifact: {record['run_artifact']}")
            except Exception as exc:
                check(False, "", f"could not read the run artifact: {str(exc)[:200]}")
        else:
            check(False, "", "the orchestrator reported no run_artifact_id, so "
                             "this run left no record of its own")

    except Exception:
        traceback.print_exc()
        FAILURES.append(f"{cfg['cell']}: uncaught exception (traceback above)")
    finally:
        if keep_apps:
            log_step(f"{cfg['cell']} teardown skipped (--keep-apps)")
            log(f"   trainers: {trainer_apps}")
            log(f"   orchestrator: {orch_app} on {orch_slug}")
        else:
            log_step(f"{cfg['cell']} teardown")
            # Only what this cell deployed. Other apps on these workers belong
            # to someone else's run.
            for slug, app_id in trainer_apps.items():
                await remove_app(server, slug, app_id, "trainer", user_id)
            if orch_app:
                await remove_app(server, orch_slug, orch_app, "orchestrator", user_id)
            # After teardown, not before: removing an app is the last thing
            # that needs the connection.
            left = await still_deployed(server, trainer_apps, orch_slug, orch_app)
            check(not left, "every app this cell deployed is gone",
                  f"still deployed after teardown, holding GPU on a shared "
                  f"worker: {left}. Remove them before the next run.")
            record["leaked_apps"] = left
        keepalive.cancel()

    record["finished_at_unix"] = int(time.time())
    record["failures"] = list(FAILURES)
    return record


# ---------------------------------------------------------------------------
# --verify-weights: did the shared weights move off their starting point?
# ---------------------------------------------------------------------------

async def download_weights(artifact_id: str, dest: Path) -> Path:
    ws, alias = artifact_id.split("/", 1)
    url = f"{HYPHA_BASE}/{ws}/artifacts/{alias}/files/model.pth"
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=600, follow_redirects=True) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {TOKEN}"})
        resp.raise_for_status()
        dest.write_bytes(resp.content)
    return dest


async def verify_weights(record_path: Path) -> int:
    """Fill in a record's weight_delta field.

    Needs torch, which the host does not have, so this runs inside a Chiron
    image. Kept in this file rather than a second script so the field's
    definition sits beside the record that carries it.
    """
    try:
        import torch
    except ImportError:
        log("torch is not importable here, so the delta was NOT measured. Run "
            "this inside a Chiron image, for example "
            "ghcr.io/aicell-lab/chiron-tabula:0.7.10.")
        return 2

    record = json.loads(record_path.read_text())
    ckpt = (record.get("checkpoint") or {}).get("artifact_id")
    initial = record.get("initial_weights_artifact")
    if not ckpt:
        log("this record has no checkpoint id, so there is nothing to compare")
        return 2

    def is_float(t: Any) -> bool:
        return hasattr(t, "dtype") and getattr(t.dtype, "is_floating_point", False)

    def summarise(per_key: Dict[str, float]) -> Dict[str, Any]:
        """Reduce a key -> max-abs-delta map to the numbers a reader needs.

        Split by dtype, because a state dict carries integer buffers such as
        bn.num_batches_tracked alongside the parameters. A batch counter rises
        by thousands over a run, so a max taken over both is a statement about
        the counter and not about any weight, which is the opposite of what
        this field is read for.
        """
        floats = {k: v for k, v in per_key.items() if k in float_keys}
        ints = {k: v for k, v in per_key.items() if k not in float_keys}
        out: Dict[str, Any] = {
            "keys_compared": len(per_key),
            "keys_moved": sum(1 for v in per_key.values() if v > 0),
            "keys_unchanged": sorted(k for k, v in per_key.items() if v == 0),
            "float_parameter_keys": len(floats),
            "integer_buffer_keys": len(ints),
        }
        out["keys_unchanged_count"] = len(out["keys_unchanged"])
        out["keys_unchanged"] = out["keys_unchanged"][:10]
        if floats:
            vals = sorted(floats.values())
            out["float_keys_moved"] = sum(1 for v in vals if v > 0)
            out["max_abs_delta_float"] = vals[-1]
            out["max_abs_delta_float_key"] = max(floats, key=floats.get)
            out["median_abs_delta_float"] = vals[len(vals) // 2]
        if ints:
            ivals = sorted(ints.values())
            out["max_abs_delta_integer_buffer"] = ivals[-1]
            out["max_abs_delta_integer_buffer_key"] = max(ints, key=ints.get)
        return out

    tmp = Path("/tmp/chiron-weight-delta")
    log(f"downloading final checkpoint {ckpt}")
    final_path = await download_weights(ckpt, tmp / "final.pth")
    final_sd = torch.load(final_path, map_location="cpu", weights_only=False)
    if isinstance(final_sd, dict) and "state_dict" in final_sd:
        final_sd = final_sd["state_dict"]

    float_keys = {k for k, t in final_sd.items() if is_float(t)}
    delta: Dict[str, Any] = {
        "measured": True,
        "checkpoint_artifact": ckpt,
        "checkpoint_tensor_count": len(final_sd),
        "checkpoint_parameter_count": int(
            sum(t.numel() for t in final_sd.values() if hasattr(t, "numel"))),
        "checkpoint_float_tensor_count": len(float_keys),
        "checkpoint_integer_buffer_count": len(final_sd) - len(float_keys),
    }

    if not initial:
        # Nothing to subtract from. Saying so is the point: for a from-scratch
        # run "moved off its initial values" has no referent, and inventing one
        # would be worse than recording the absence.
        delta["comparison"] = "not applicable"
        delta["why"] = ("mode is pretrain, so there are no initial weights to "
                        "compare against; the trajectory is the evidence that "
                        "training moved, and the counts above are the evidence "
                        "that the checkpoint carries the shared scope")
    else:
        log(f"downloading initial weights {initial}")
        init_path = await download_weights(initial, tmp / "initial.pth")
        init_sd = torch.load(init_path, map_location="cpu", weights_only=False)
        if isinstance(init_sd, dict) and "state_dict" in init_sd:
            init_sd = init_sd["state_dict"]
        # The two sides name the same tensors differently. A federated
        # checkpoint carries only the shared scope and names it from the
        # transformer's own root (`blocks.0.attention...`), while a published
        # foundation artifact carries the whole model and names that same
        # tensor from the model's root (`transformer.blocks.0.attention...`).
        # Measured on chiron-platform/tabula-foundation against the checkpoint
        # of the tabula-continued cell, 2026-11-13: 2,447 tensors against 24,
        # exact intersection 0, and all 24 matching by dotted suffix with equal
        # shapes. Matching on equality alone therefore compared nothing and
        # printed "0 of 0 keys moved", which reads as a finding about the
        # training and is really a finding about the naming.
        pairs: List[Tuple[str, str]] = []
        unpaired_final: List[str] = []
        for k in final_sd:
            if k in init_sd:
                pairs.append((k, k))
                continue
            hits = [g for g in init_sd if g.endswith("." + k)]
            if len(hits) == 1:
                pairs.append((k, hits[0]))
            else:
                # Zero hits is a genuine absence; more than one is ambiguous
                # and resolving it by picking would invent a comparison.
                unpaired_final.append(k)
        per_key: Dict[str, float] = {}
        for fk, ik in pairs:
            a, b = init_sd[ik], final_sd[fk]
            if not (hasattr(a, "shape") and hasattr(b, "shape")) or a.shape != b.shape:
                continue
            per_key[fk] = float((b.float() - a.float()).abs().max())
        delta["comparison"] = "initial vs final"
        delta["initial_artifact"] = initial
        delta["keys_in_both"] = len(pairs)
        delta["keys_matched_by_suffix"] = sum(1 for fk, ik in pairs if fk != ik)
        delta["keys_unpairable"] = len(unpaired_final)
        delta["unpairable_key_sample"] = unpaired_final[:10]
        delta["whole_checkpoint"] = summarise(per_key)

        # The issue asks how many parameters were SHARED and that those moved.
        # A delta over the whole checkpoint answers a different question, since
        # it also covers site-local keys that FedAvg never touched, so a scope
        # that moved not at all could still be hidden behind a large all-keys
        # count. Restrict to the keys the trainers themselves reported.
        scope_keys = sorted({
            k
            for site in (record.get("weight_scope") or {}).get("per_site", {}).values()
            for k in (site.get("shared_keys") or [])
        })
        fed: Dict[str, Any] = {"reported_shared_keys": len(scope_keys)}
        if not scope_keys:
            fed["measured"] = False
            fed["reason"] = ("this record carries no weight_scope, so which keys "
                             "were federated is unknown here and only the "
                             "whole-checkpoint figures above are available")
        else:
            # A site reports its scope relative (blocks.0.attention...) while a
            # checkpoint key is absolute (transformer.blocks.0...), so match on
            # equality or on a dotted suffix rather than equality alone.
            matched: Dict[str, float] = {}
            unresolved = []
            for sk in scope_keys:
                if sk in per_key:
                    matched[sk] = per_key[sk]
                    continue
                hits = [k for k in per_key if k.endswith("." + sk)]
                if len(hits) == 1:
                    matched[hits[0]] = per_key[hits[0]]
                else:
                    unresolved.append(sk)
            fed["measured"] = bool(matched)
            fed["keys_resolved_into_checkpoint"] = len(matched)
            fed["keys_unresolved"] = len(unresolved)
            fed["unresolved_key_sample"] = unresolved[:10]
            if matched:
                fed.update(summarise(matched))
                fed["parameter_count"] = int(sum(
                    final_sd[k].numel() for k in matched if hasattr(final_sd[k], "numel")))
            else:
                # Loud, because an empty intersection yields no deltas at all,
                # and "0 keys moved" over 0 keys would otherwise print as a
                # finding about the training rather than about the matching.
                fed["reason"] = (f"none of the {len(scope_keys)} reported shared "
                                 "keys could be matched to a checkpoint key, so "
                                 "the federated-scope delta was NOT measured")
        delta["federated_scope"] = fed

        wc = delta["whole_checkpoint"]
        log(f"   whole checkpoint: {wc['keys_moved']} of {wc['keys_compared']} "
            f"keys moved, max abs delta over float params "
            f"{wc.get('max_abs_delta_float')} ({wc.get('max_abs_delta_float_key')})")
        if wc.get("integer_buffer_keys"):
            log(f"   {wc['integer_buffer_keys']} integer buffers excluded from "
                f"that max; their own max is "
                f"{wc.get('max_abs_delta_integer_buffer')} "
                f"({wc.get('max_abs_delta_integer_buffer_key')})")
        if fed.get("measured"):
            log(f"   federated scope: {fed['float_keys_moved']} of "
                f"{fed['float_parameter_keys']} float params moved, "
                f"{fed['parameter_count']} parameters, max abs delta "
                f"{fed.get('max_abs_delta_float')}")
        else:
            log(f"   federated scope: NOT measured - {fed.get('reason')}")

    record["weight_delta"] = delta
    record_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    log(f"updated {record_path}")

    # Exit non-zero when a scope WAS reported and none of it resolved. The
    # record says so either way, but a caller reading only the status would
    # otherwise take a record carrying no federated measurement at all for a
    # successful one. A record with no scope at all is a different case: the
    # run's own failures list already carries why, so it is not re-raised here.
    fed = delta.get("federated_scope") or {}
    if fed.get("reported_shared_keys") and not fed.get("measured"):
        return 1
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def print_matrix() -> None:
    print("Chiron benchmark matrix: 6 cells, 3 model families x 2 training modes")
    print()
    print(f"  {'cell':<24}{'family':<13}{'mode':<11}{'initial weights':<40}trainer app")
    for family, mode in all_cells():
        cfg = cell_config(cell_id(family, mode))
        init = cfg["initial_weights_artifact"] or "none, by definition"
        print(f"  {cfg['cell']:<24}{family:<13}{mode:<11}{init:<40}"
              f"{cfg['trainer_artifact']}")
    print()
    print("A cell needs its sites to run that family's worker image, each")
    print("serving a dataset id no other site in the cell serves. No cell may")
    print("be compared with any other: the families differ in architecture,")
    print("tokenisation and pre-training corpus, and the modes differ in what")
    print("they start from.")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Run one cell of the Chiron benchmark matrix and record it.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--list", action="store_true",
                   help="print the six cells and what each would use, then exit")
    p.add_argument("--cell", help="cell to run, e.g. tabula-continued")
    p.add_argument("--sites", default="",
                   help="comma-separated slug=dataset_id pairs, two or more")
    p.add_argument("--orchestrator-site", default=None,
                   help="worker to host the orchestrator (default: the first site)")
    p.add_argument("--rounds", type=int, default=DEFAULT_ROUNDS)
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    p.add_argument("--per-round-timeout", type=int, default=DEFAULT_PER_ROUND_TIMEOUT)
    p.add_argument("--limit-train-batches", type=int, default=None,
                   help="cap a round at this many batches per site. Unset, a "
                        "round is a whole epoch, which on a 250,000-cell site "
                        "at batch 8 is 31,250 steps. The value is recorded on "
                        "the run, because a loss curve cannot be read without "
                        "knowing what one round covered.")
    p.add_argument("--limit-val-batches", type=int, default=None,
                   help="cap each round's evaluation at this many batches per "
                        "site. Measured on a 250,000-cell site: a fit capped "
                        "at 10 batches took 21s and the uncapped evaluate "
                        "after it ran for over ten minutes, so leaving this "
                        "unset makes validation, not training, decide what a "
                        "benchmark run costs.")
    p.add_argument("--out", default="outputs/benchmark-matrix",
                   help="directory for the per-cell JSON records")
    p.add_argument("--dry-run", action="store_true",
                   help="run preflight only: resolve every prerequisite, deploy nothing")
    p.add_argument("--keep-apps", action="store_true",
                   help="leave the orchestrator and trainers running after the cell")
    p.add_argument("--verify-weights", metavar="RECORD_JSON",
                   help="fill in a finished record's weight_delta field (needs torch)")
    p.add_argument("--workers", action="store_true",
                   help="list the live worker slugs, their families and datasets")
    return p


async def amain(args: argparse.Namespace) -> int:
    global TOKEN
    TOKEN = load_token()

    if args.verify_weights:
        return await verify_weights(Path(args.verify_weights))

    server = await connect_to_server({"server_url": HYPHA_BASE, "token": TOKEN})
    try:
        user = server.config.user or {}
        user_id = user.get("id") or ""
        user_email = user.get("email") or ""
        user_workspace = server.config.workspace
        log(f"connected as {user_id!r} <{user_email}> workspace={user_workspace!r}")

        if args.workers:
            found = await discover_workers(server)
            log(f"{len(found)} live worker(s)")
            for slug in sorted(found):
                img = await worker_image(server, slug)
                ds = await worker_datasets(server, slug)
                log(f"   {slug:<16} family={img['model_family'] or '-':<12} "
                    f"name={found[slug]['name']!r}")
                log(f"   {'':<16} image={img['image_ref']}")
                log(f"   {'':<16} datasets={ds}")
            log("")
            log("A cell needs 2+ sites of its own family, each on a dataset id")
            log("no other site in that cell serves.")
            return 0

        if not args.cell:
            log("nothing to do: pass --cell, --list, --workers or --verify-weights")
            return 2

        cfg = cell_config(args.cell)
        sites = parse_sites(args.sites)
        if not sites:
            log("--sites is required to run a cell, as slug=dataset_id pairs. "
                "Use --workers to see what is online.")
            return 2
        orch_slug = args.orchestrator_site or sorted(sites)[0]

        am = await server.get_service("public/artifact-manager")

        if not await preflight(server, am, cfg, sites, orch_slug):
            log("")
            log("preflight failed, so nothing was deployed")
            return 1
        log("")
        log("preflight passed")
        if args.dry_run:
            log("--dry-run, so stopping before deploying anything")
            return 0

        record = await run_cell(
            server, am, cfg, sites,
            orch_slug=orch_slug, rounds=args.rounds, batch_size=args.batch_size,
            per_round_timeout=args.per_round_timeout,
            limit_train_batches=args.limit_train_batches,
            limit_val_batches=args.limit_val_batches,
            user_id=user_id, user_email=user_email, app_token=TOKEN,
            user_workspace=user_workspace, keep_apps=args.keep_apps)

        out_dir = Path(args.out)
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{cfg['cell']}.json"
        out_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
        log("")
        log(f"record written to {out_path}")
        log("next: python tests/e2e/benchmark_matrix.py --verify-weights "
            f"{out_path}   (inside a Chiron image, needs torch)")
    finally:
        await server.disconnect()

    log("")
    log("=" * 78)
    if FAILURES:
        log(f"  {len(FAILURES)} check(s) failed:")
        for f in FAILURES:
            log(f"    - {f}")
        log("=" * 78)
        return 1
    log("  all checks passed")
    log("=" * 78)
    return 0


def main() -> int:
    args = build_parser().parse_args()
    if args.list:
        print_matrix()
        return 0
    return asyncio.run(amain(args))


if __name__ == "__main__":
    sys.exit(main())
