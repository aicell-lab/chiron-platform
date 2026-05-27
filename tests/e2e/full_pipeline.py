"""End-to-end pipeline test for the Chiron Platform federated training stack.

Scenario
========

1. Deploy a Chiron Orchestrator on the Chiron Worker - Boston (CPU only).
2. Deploy two trainers from scratch (no pretrained weights):
     - Chiron Worker - Berlin   (thymus)
     - Chiron Worker - Stanford (liver)
3. Register both with the orchestrator and start training for 5 rounds with
   `initial_weights = chiron-platform/tabula-global-average`. The orchestrator
   broadcasts the transformer-only slice of that checkpoint to every trainer at
   round 1; each trainer's tissue-specific embedder + projection heads stay
   local. Each fit phase runs the full 90 demo batches (batch_size=8,
   limit_train_batches=None).
4. Just before round 3, deploy a third trainer on Chiron Worker - Stockholm
   (blood) WITH `pretrained_weights_artifact = chiron-platform/tabula-blood`
   (full Tabula model). The Stockholm trainer therefore starts with a
   tissue-specific embedder + projection heads tuned for blood, while the
   shared transformer will be overwritten by the orchestrator's averaged
   weights when it joins. Register Stockholm so it joins the federation from
   round 3 onwards.
5. After all 5 rounds:
     a. Trainer (Berlin) publishes via save_model_weights (full Tabula).
     b. Orchestrator publishes via save_global_weights (transformer-only).
     c. Berlin trainer calls save_local_model (disk).
   The test then verifies each artifact's manifest + files, then deletes
   everything (published artifacts + on-disk saves).
6. Tear down trainers + orchestrator.

The script logs every step and asserts the invariants the platform promises
(no "*** FAIL ***" lines on a passing run). Exit code 0 on success, non-zero
on the first hard failure.

Prereqs
=======
- The four Chiron Workers (Boston / Berlin / Stanford / Stockholm) must be
  online, with their datasets available.
- `chiron-platform/tabula-trainer` and `chiron-platform/chiron-orchestrator`
  apps must be uploaded.
- `chiron-platform/tabula-global-average` and `chiron-platform/tabula-blood`
  artifacts must exist in `chiron-platform/chiron-models`.
- Hypha token with chiron-platform write access, expected at
  `../tabula/.env` (HYPHA_TOKEN=...).

Usage
=====
    python tests/e2e/full_pipeline.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from hypha_rpc import connect_to_server

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HYPHA_BASE = "https://hypha.aicell.io"
WORKSPACE = "chiron-platform"
TRAINER_ARTIFACT = "chiron-platform/tabula-trainer"
ORCHESTRATOR_ARTIFACT = "chiron-platform/chiron-orchestrator"
GLOBAL_TRANSFORMER_INIT = "chiron-platform/tabula-global-average"
BLOOD_FULL_MODEL = "chiron-platform/tabula-blood"

NUM_ROUNDS = 5
STOCKHOLM_JOINS_ROUND = 3
BATCH_SIZE = 8
EXPECTED_BATCHES_PER_ROUND = 90  # full demo dataset

# Site → expected dataset name. We only run trainers on these three sites; the
# orchestrator goes on Boston (no GPU contention, no dataset).
SITES = {
    "berlin":    {"dataset": "thymus"},
    "stanford":  {"dataset": "liver"},
    "stockholm": {"dataset": "blood_perturb_rna_001"},
}

ENV_PATH = Path(__file__).resolve().parent.parent.parent.parent / "tabula" / ".env"


def load_token() -> str:
    if not ENV_PATH.exists():
        raise SystemExit(
            f"Cannot find HYPHA_TOKEN file at {ENV_PATH}. "
            "Export HYPHA_TOKEN or write it into ../tabula/.env."
        )
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith("HYPHA_TOKEN="):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit(f"HYPHA_TOKEN= not found in {ENV_PATH}")


TOKEN = load_token()


# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

START_TS = time.monotonic()
FAILURES: List[str] = []


def log(msg: str = "") -> None:
    print(f"[{time.monotonic()-START_TS:7.1f}s] {msg}", flush=True)


def log_step(title: str) -> None:
    log("")
    log("=" * 78)
    log(f"  {title}")
    log("=" * 78)


def check(ok: bool, ok_msg: str, fail_msg: str) -> bool:
    if ok:
        log(f"   ✓ {ok_msg}")
    else:
        log(f"   ✗ FAIL: {fail_msg}")
        FAILURES.append(fail_msg)
    return ok


# ---------------------------------------------------------------------------
# HTTP helpers (everything goes through Hypha's HTTP gateway)
# ---------------------------------------------------------------------------

class HTTPCallError(RuntimeError):
    pass


async def hypha_post(service_id: str, method: str, kwargs: Optional[dict] = None, timeout_s: float = 300) -> Any:
    ws, rest = service_id.split("/", 1)
    url = f"{HYPHA_BASE}/{ws}/services/{rest}/{method}"
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=timeout_s) as c:
        r = await c.post(url, headers=headers, content=json.dumps(kwargs or {}).encode())
        if r.status_code >= 400:
            raise HTTPCallError(f"HTTP {r.status_code} {service_id}.{method}: {r.text[:400]}")
        return json.loads(r.text) if r.text else None


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

async def discover_managers(server) -> Dict[str, str]:
    """Return {site: chiron-manager service id} for the 4 chiron workers."""
    svcs = await server.list_services()
    workers: Dict[str, str] = {}
    for s in svcs:
        sid = s.get("id", "")
        if "rtc" in sid or not sid.endswith(":bioengine-worker"):
            continue
        name = (s.get("name") or "").lower()
        for hint in ("boston", "berlin", "stockholm", "stanford"):
            if hint in name:
                workers[hint] = sid.split("/")[-1].split(":")[0]
    out: Dict[str, str] = {}
    for s in svcs:
        sid = s.get("id", "")
        if "rtc" in sid or ":chiron-manager" not in sid:
            continue
        cid = sid.split("/")[-1].split(":")[0]
        for site, wcid in workers.items():
            if site not in out and wcid in cid:
                full = sid if "/" in sid else f"{WORKSPACE}/{sid}"
                out[site] = full
    return out


async def mgr_for(server, site: str, retries: int = 10) -> str:
    """Re-discover a site's chiron-manager (its id rotates whenever it
    redeploys after create_trainer / create_orchestrator). Retry to absorb
    short windows where it's missing from the service list."""
    for _ in range(retries):
        m = await discover_managers(server)
        if site in m:
            return m[site]
        await asyncio.sleep(2)
    raise RuntimeError(f"manager for {site!r} not found")


# ---------------------------------------------------------------------------
# Deployment helpers
# ---------------------------------------------------------------------------

async def wait_for_orchestrator(server, site: str, app_id: str, timeout_s: float = 240) -> Optional[str]:
    """Poll until orchestrator app reaches RUNNING and return its websocket service id."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        await asyncio.sleep(3)
        try:
            mid = await mgr_for(server, site)
            info = await hypha_post(mid, "get_worker_info", {}, timeout_s=15)
        except Exception:
            continue
        v = (info.get("orchestrators_status") or {}).get(app_id, {})
        if v.get("status") == "RUNNING":
            sids = v.get("service_ids") or []
            if sids and sids[0].get("websocket_service_id"):
                return sids[0]["websocket_service_id"]
    return None


async def wait_for_trainer(server, site: str, app_id: str, timeout_s: float = 240) -> Optional[str]:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        await asyncio.sleep(3)
        try:
            mid = await mgr_for(server, site)
            info = await hypha_post(mid, "get_worker_info", {}, timeout_s=15)
        except Exception:
            continue
        v = (info.get("trainers_status") or {}).get(app_id, {})
        if v.get("status") == "RUNNING":
            sids = v.get("service_ids") or []
            if sids and sids[0].get("websocket_service_id"):
                return sids[0]["websocket_service_id"]
    return None


async def deploy_trainer(server, site: str, *, pretrained_artifact: Optional[str], app_token: str, user_id: str) -> Dict[str, str]:
    mid = await mgr_for(server, site)
    kwargs: Dict[str, Any] = {
        "token": app_token,
        "datasets": [SITES[site]["dataset"]],
        "trainer_artifact_id": TRAINER_ARTIFACT,
        "owner_id": user_id,
    }
    if pretrained_artifact is not None:
        kwargs["pretrained_weights_artifact"] = {
            "artifact_id": pretrained_artifact,
            "file_path": "model.pth",
        }
        log(f"   deploying trainer on {site} (dataset={SITES[site]['dataset']}, pretrained={pretrained_artifact})")
    else:
        log(f"   deploying trainer on {site} (dataset={SITES[site]['dataset']}, pretrained=None)")
    app_id = await hypha_post(mid, "create_trainer", kwargs)
    svc_id = await wait_for_trainer(server, site, app_id)
    if not svc_id:
        raise RuntimeError(f"{site} trainer {app_id} did not reach RUNNING in time")
    return {"app_id": app_id, "service_id": svc_id}


async def remove_app(server, site: str, app_id: str, kind: str, user_id: str) -> None:
    try:
        mid = await mgr_for(server, site)
        method = "remove_orchestrator" if kind == "orchestrator" else "remove_trainer"
        await hypha_post(mid, method, {
            "application_id": app_id,
            "force": True,
            "caller_id": user_id,
        }, timeout_s=120)
        log(f"   ✓ {site} {kind} {app_id} removed")
    except Exception as e:
        log(f"   ✗ {site} {kind} cleanup error: {e}")


# ---------------------------------------------------------------------------
# Training monitoring
# ---------------------------------------------------------------------------

async def watch_training(
    orch_svc: str,
    *,
    stop_after_round: Optional[int] = None,
    hook_before_round: Optional[Dict[int, Any]] = None,
) -> Dict[str, Any]:
    """Poll training status. Optionally trigger a hook just before a given
    round starts (used to add Stockholm before round 3). Returns the final
    training_status dict once is_running flips False."""
    hook_before_round = hook_before_round or {}
    triggered: set = set()
    last_state: Any = None
    final_status: Dict[str, Any] = {}
    deadline = time.time() + 1800
    while time.time() < deadline:
        await asyncio.sleep(3)
        try:
            st = await hypha_post(orch_svc, "get_training_status", {}, timeout_s=15)
        except Exception as e:
            log(f"   status err: {str(e)[:120]}")
            continue
        cur_state = (st.get("stage"), st.get("current_training_round"), st.get("is_running"))
        if cur_state != last_state:
            log(f"   stage={st.get('stage'):<10} round={st.get('current_training_round')} running={st.get('is_running')}")
            last_state = cur_state
        # Pre-round hook: fire when current_training_round == round-1
        # and stage transitions (we're between rounds).
        for r, fn in hook_before_round.items():
            if r in triggered:
                continue
            if st.get("current_training_round") == r - 1 and st.get("stage") in (None, "aggregation", "distribution", "evaluate"):
                triggered.add(r)
                log(f"   → firing pre-round-{r} hook")
                try:
                    await fn(st)
                except Exception as e:
                    log(f"     hook failed: {e}")
        if stop_after_round and st.get("current_training_round") == stop_after_round and st.get("is_running") is False:
            final_status = st
            break
        if st.get("is_running") is False and st.get("current_training_round"):
            final_status = st
            break
    return final_status


# ---------------------------------------------------------------------------
# Verification of published artifacts
# ---------------------------------------------------------------------------

async def list_artifact_files(artifact_id: str) -> List[str]:
    workspace, alias = artifact_id.split("/", 1)
    url = f"{HYPHA_BASE}/{workspace}/artifacts/{alias}/files/"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers={"Authorization": f"Bearer {TOKEN}"})
        if r.status_code != 200:
            return []
        return [f.get("name") for f in (r.json() or []) if isinstance(f, dict)]


async def verify_published(am, artifact_id: str, *, expect_global_transformer: bool, label: str) -> bool:
    info = await am.read(artifact_id)
    m = info.get("manifest") or {}
    files = await list_artifact_files(artifact_id)
    log(f"   {label} → {artifact_id}")
    log(f"     name = {m.get('name')!r}")
    log(f"     description = {(m.get('description') or '')[:90]!r}")
    log(f"     global_transformer = {m.get('global_transformer')}")
    log(f"     files = {files}")
    ok = True
    ok &= check(m.get("global_transformer") is expect_global_transformer,
                f"global_transformer == {expect_global_transformer}",
                f"{label} expected global_transformer={expect_global_transformer}, got {m.get('global_transformer')}")
    ok &= check("model.pth" in files, "model.pth present", f"{label} missing model.pth in artifact files")
    ok &= check("documentation.md" in files, "documentation.md present", f"{label} missing documentation.md in artifact files")
    return ok


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    server = await connect_to_server({
        "server_url": HYPHA_BASE,
        "token": TOKEN,
        "workspace": WORKSPACE,
    })
    app_token = await server.generate_token({
        "workspace": WORKSPACE,
        "permission": "read_write",
        "expires_in": 3600,
    })
    user_id = server.config.user.get("id")
    am = await server.get_service("public/artifact-manager")

    # Track everything we create so cleanup runs even on failure.
    orch_site = "boston"
    orch_app_id: Optional[str] = None
    orch_svc: Optional[str] = None
    trainer_apps: Dict[str, str] = {}   # site → app_id
    trainer_svcs: Dict[str, str] = {}   # site → service_id
    published_artifacts: List[str] = []

    try:
        log_step("Step 1 — deploy orchestrator on Boston")
        mid = await mgr_for(server, orch_site)
        orch_app_id = await hypha_post(mid, "create_orchestrator", {
            "token": app_token,
            "trainer_artifact_id": TRAINER_ARTIFACT,
            "owner_id": user_id,
        })
        log(f"   app_id = {orch_app_id}")
        orch_svc = await wait_for_orchestrator(server, orch_site, orch_app_id)
        if not orch_svc:
            raise RuntimeError("orchestrator did not reach RUNNING")
        log(f"   service = {orch_svc}")

        log_step("Step 2 — deploy initial 2 trainers (Berlin + Stanford, no pretrained)")
        for site in ("berlin", "stanford"):
            res = await deploy_trainer(server, site, pretrained_artifact=None, app_token=app_token, user_id=user_id)
            trainer_apps[site] = res["app_id"]
            trainer_svcs[site] = res["service_id"]
            keys = await hypha_post(trainer_svcs[site], "get_transformer_keys", {})
            check(len(keys) == 24, f"{site} reports 24 FlashAttention keys",
                  f"{site} expected 24 transformer keys, got {len(keys)}")

        log_step("Step 3 — register both with orchestrator")
        for site, svc in trainer_svcs.items():
            await hypha_post(orch_svc, "add_trainer", {
                "trainer_service_id": svc,
                "orchestrator_service_id": orch_svc,
            })
            log(f"   ✓ registered {site}")

        log_step(f"Step 4 — start_training (rounds={NUM_ROUNDS}, initial_weights={GLOBAL_TRANSFORMER_INIT}, full 90 batches/round)")

        # Hook to fire before round 3: deploy + register Stockholm with
        # pretrained_weights_artifact=tabula-blood.
        async def add_stockholm(_st):
            log("   *** mid-training: deploying Stockholm trainer with tabula-blood pretrained weights ***")
            res = await deploy_trainer(server, "stockholm",
                                       pretrained_artifact=BLOOD_FULL_MODEL,
                                       app_token=app_token, user_id=user_id)
            trainer_apps["stockholm"] = res["app_id"]
            trainer_svcs["stockholm"] = res["service_id"]
            keys = await hypha_post(trainer_svcs["stockholm"], "get_transformer_keys", {})
            check(len(keys) == 24, "stockholm reports 24 FlashAttention keys",
                  f"stockholm expected 24 transformer keys, got {len(keys)}")
            await hypha_post(orch_svc, "add_trainer", {
                "trainer_service_id": trainer_svcs["stockholm"],
                "orchestrator_service_id": orch_svc,
            })
            log("   ✓ stockholm registered (joins from next round onwards)")

        train_task = asyncio.create_task(hypha_post(orch_svc, "start_training", {
            "num_rounds": NUM_ROUNDS,
            "fit_config": {"batch_size": BATCH_SIZE},          # no limit_train_batches → full 90 batches
            "eval_config": {"batch_size": BATCH_SIZE},
            "initial_weights": {"artifact_id": GLOBAL_TRANSFORMER_INIT, "file_path": "model.pth"},
            "per_round_timeout": 1800,
        }, timeout_s=3600))

        final_status = await watch_training(
            orch_svc,
            stop_after_round=NUM_ROUNDS,
            hook_before_round={STOCKHOLM_JOINS_ROUND: add_stockholm},
        )
        try:
            await asyncio.wait_for(train_task, timeout=120)
        except Exception as e:
            log(f"   train_task: {str(e)[:200]}")

        log(f"   final round={final_status.get('current_training_round')} stage={final_status.get('stage')}")
        check(final_status.get("current_training_round") == NUM_ROUNDS,
              f"reached {NUM_ROUNDS} rounds",
              f"expected round {NUM_ROUNDS}, got {final_status.get('current_training_round')}")

        # Verify history → each trainer's per-round contribution
        history = await hypha_post(orch_svc, "get_training_history", {})
        log(f"   training_losses (per round avg): {history.get('training_losses')}")
        log(f"   validation_losses (per round avg): {history.get('validation_losses')}")
        client_train = history.get("client_metrics_fit", {}) or history.get("client_train_losses", {})
        if client_train:
            for cid, rounds in (client_train.items() if isinstance(client_train, dict) else []):
                if isinstance(rounds, list):
                    log(f"     {cid}: {len(rounds)} fit entries")
                elif isinstance(rounds, dict):
                    counts = {k: (len(v) if isinstance(v, list) else 1) for k, v in rounds.items()}
                    log(f"     {cid}: {counts}")

        log_step("Step 5a — Berlin publishes via save_model_weights (full Tabula)")
        try:
            full_aid = await hypha_post(trainer_svcs["berlin"], "save_model_weights", {
                "description": "E2E test (full Tabula) - Berlin",
            }, timeout_s=300)
            published_artifacts.append(full_aid)
            await verify_published(am, full_aid, expect_global_transformer=False, label="berlin full")
        except Exception as e:
            check(False, "Berlin save_model_weights OK", f"Berlin save_model_weights failed: {e}")

        log_step("Step 5b — Orchestrator publishes via save_global_weights (transformer-only)")
        try:
            global_aid = await hypha_post(orch_svc, "save_global_weights", {
                "description": "E2E test (global transformer)",
            }, timeout_s=300)
            published_artifacts.append(global_aid)
            await verify_published(am, global_aid, expect_global_transformer=True, label="global transformer")
        except Exception as e:
            check(False, "save_global_weights OK", f"save_global_weights failed: {e}")

        log_step("Step 5c — Berlin saves to local disk via save_local_model")
        try:
            saved_path = await hypha_post(trainer_svcs["berlin"], "save_local_model", {
                "description": "E2E test (local disk)",
            }, timeout_s=120)
            log(f"   saved to {saved_path}")
            # Confirm it shows up in list_local_model_weights
            listed = await hypha_post(trainer_svcs["berlin"], "list_local_model_weights", {})
            paths = [w.get("path") for w in (listed or [])]
            check(saved_path in paths, "list_local_model_weights includes saved file",
                  f"saved_path {saved_path} not in list_local_model_weights")
        except Exception as e:
            check(False, "save_local_model OK", f"save_local_model failed: {e}")

        log_step("Step 6 — cleanup published artifacts")
        for aid in list(published_artifacts):
            try:
                await am.delete(artifact_id=aid)
                log(f"   ✓ deleted {aid}")
            except Exception as e:
                log(f"   ✗ delete {aid}: {e}")
        # Clear local disk saves on Berlin
        try:
            cleared = await hypha_post(trainer_svcs["berlin"], "clear_local_model_weights", {}, timeout_s=60)
            log(f"   ✓ cleared local disk saves: {cleared}")
        except Exception as e:
            log(f"   ✗ clear_local_model_weights: {e}")

    except Exception:
        traceback.print_exc()
        FAILURES.append("uncaught exception (see traceback above)")
    finally:
        log_step("Step 7 — teardown trainers + orchestrator")
        for site, app_id in trainer_apps.items():
            await remove_app(server, site, app_id, "trainer", user_id)
        if orch_app_id:
            await remove_app(server, orch_site, orch_app_id, "orchestrator", user_id)
        await server.disconnect()

    log("")
    log("=" * 78)
    if FAILURES:
        log(f"  ✗  TEST FAILED ({len(FAILURES)} issue{'s' if len(FAILURES) != 1 else ''}):")
        for f in FAILURES:
            log(f"    - {f}")
        log("=" * 78)
        sys.exit(1)
    else:
        log("  ✓  ALL CHECKS PASSED")
        log("=" * 78)


if __name__ == "__main__":
    asyncio.run(main())
