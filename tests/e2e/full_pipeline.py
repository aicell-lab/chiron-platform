"""End-to-end pipeline test for the Chiron Platform federated training stack.

Scenario (matches the demo recording flow)
==========================================

1. Connect to Hypha with the user's PERSONAL token (no chiron-platform
   workspace permission needed — the user authenticates as themselves and
   each spawned app authorises them via authorized_users).
2. Generate a 30-day user-scoped read_write token (the orchestrator + every
   trainer will run with THIS token as HYPHA_TOKEN, so their hypha_client
   resolves to the user's personal workspace and they publish artifacts /
   write run records as the user).
3. Deploy a Chiron Orchestrator on the Chiron Worker - Stanford (CPU only).
4. Deploy two trainers (no pretrained weights) on Berlin and Boston,
   register them with the orchestrator.
5. Start training for 5 rounds with `initial_weights = chiron-platform/tabula-foundation`.
   During round 2 (stage=fit), deploy a third trainer on Stockholm with
   `pretrained_weights_artifact = chiron-platform/tabula-blood`, then
   register it. Stockholm joins from round 3 onwards.
6. After all 5 rounds:
     a. Orchestrator publishes the aggregated transformer via
        save_global_weights ("Upload Model").
     b. Stockholm trainer publishes its full model via save_model_weights
        ("Upload Model").
     c. Berlin and Boston save to local disk via save_local_model
        ("Save to worker"). Confirm both show up in list_local_model_weights.
7. Verify the run artifact landed in the USER's personal workspace
   collection `ws-user-<userId>/chiron-training-runs`, has all 3 trainers
   in its manifest, and shows status=completed.
8. Cleanup: delete published artifacts, clear local disk saves, remove
   trainers + orchestrator.

The script logs every step and asserts the invariants the platform promises
(no "*** FAIL ***" lines on a passing run). Exit code 0 on success, non-zero
on the first hard failure.

Prereqs
=======
- The four Chiron Workers (Stockholm / Boston / Berlin / Stanford) must be
  online, with their datasets available (Stanford runs the orchestrator only).
- `chiron-platform/tabula-trainer` and `chiron-platform/chiron-orchestrator`
  apps must be uploaded.
- `chiron-platform/tabula-foundation` and `chiron-platform/tabula-blood`
  artifacts must exist in `chiron-platform/chiron-models`.
- `chiron-platform/chiron-models` collection must allow rw+ for any
  authenticated user (so the user-scoped token can publish).
- PERSONAL_HYPHA_TOKEN in ../tabula/.env (user-scoped, not workspace-scoped).

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
GLOBAL_TRANSFORMER_INIT = "chiron-platform/tabula-foundation"
BLOOD_FULL_MODEL = "chiron-platform/tabula-blood"

NUM_ROUNDS = 5
# Stockholm joins mid round 2 (after round 2's fit has started). The hook
# below fires on the (round=2, stage=fit) signal so Stockholm registers
# while rounds 1 and 2 are already committed without it; the eval-filter
# in orchestrator 0.3.3+ keeps Stockholm out of round 2's evaluate (it
# didn't complete round 2's fit), and Stockholm participates from round 3
# onwards.
STOCKHOLM_JOINS_DURING_ROUND = 2
BATCH_SIZE = 8

# Site → expected dataset name. We only run trainers on these three sites;
# the orchestrator goes on Stanford (no GPU contention, no dataset).
SITES = {
    "berlin":    {"dataset": "thymus"},
    "boston":    {"dataset": "skin_aging_blsa"},
    "stockholm": {"dataset": "blood_perturb_rna_001"},
}

ENV_PATH = Path(__file__).resolve().parent.parent.parent.parent / "tabula" / ".env"


def load_token() -> str:
    """Load the PERSONAL_HYPHA_TOKEN (user-scoped) from ../tabula/.env.

    The federated-training e2e must auth with the user's own token so the run
    artifact lands in the user's personal workspace (matches the production
    UI flow). The chiron-platform workspace service-account token (HYPHA_TOKEN)
    cannot create artifacts in ws-user-* workspaces.
    """
    if not ENV_PATH.exists():
        raise SystemExit(
            f"Cannot find PERSONAL_HYPHA_TOKEN file at {ENV_PATH}. "
            "Export PERSONAL_HYPHA_TOKEN or write it into ../tabula/.env."
        )
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith("PERSONAL_HYPHA_TOKEN="):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit(f"PERSONAL_HYPHA_TOKEN= not found in {ENV_PATH}")


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
    svcs = await server.list_services({"workspace": WORKSPACE})
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
            raw = v.get("service_ids")
            # service_ids comes back as a single dict, a list of dicts, or a
            # dict-of-dicts (Hypha ObjectProxy in some cases). Walk every shape.
            candidates = []
            if hasattr(raw, "get") and raw.get("websocket_service_id"):
                candidates.append(raw)
            elif isinstance(raw, list):
                candidates.extend(raw)
            elif hasattr(raw, "values"):
                candidates.extend(raw.values())
            for entry in candidates:
                if hasattr(entry, "get") and entry.get("websocket_service_id"):
                    return entry["websocket_service_id"]
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
            raw = v.get("service_ids")
            # service_ids comes back as a single dict, a list of dicts, or a
            # dict-of-dicts (Hypha ObjectProxy in some cases). Walk every shape.
            candidates = []
            if hasattr(raw, "get") and raw.get("websocket_service_id"):
                candidates.append(raw)
            elif isinstance(raw, list):
                candidates.extend(raw)
            elif hasattr(raw, "values"):
                candidates.extend(raw.values())
            for entry in candidates:
                if hasattr(entry, "get") and entry.get("websocket_service_id"):
                    return entry["websocket_service_id"]
    return None


async def deploy_trainer(server, site: str, *, pretrained_artifact: Optional[str], app_token: str, user_id: str, user_email: str) -> Dict[str, str]:
    mid = await mgr_for(server, site)
    kwargs: Dict[str, Any] = {
        "token": app_token,
        "datasets": [SITES[site]["dataset"]],
        "trainer_artifact_id": TRAINER_ARTIFACT,
        # Hardware-aware cap. The session below also passes batch_size in
        # fit_config — the trainer clamps that at max_batch_size, so the
        # effective batch_size is min(session, max). Setting both to the
        # same value here keeps the test deterministic.
        "max_batch_size": BATCH_SIZE,
        "owner_id": user_id,
        "owner_email": user_email,
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
    hook_mid_round: Optional[Dict[int, Any]] = None,
) -> Dict[str, Any]:
    """Poll training status. Optionally trigger a hook the FIRST time a given
    round enters its fit phase (used to add Stockholm during round 2 fit, so
    rounds 1 and 2 commit without it and Stockholm joins round 3 onwards).
    Returns the final training_status dict once is_running flips False."""
    hook_mid_round = hook_mid_round or {}
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
        # Mid-round hook: fire when current_training_round == r and stage == 'fit'.
        for r, fn in hook_mid_round.items():
            if r in triggered:
                continue
            if st.get("current_training_round") == r and st.get("stage") == "fit":
                triggered.add(r)
                log(f"   → firing mid-round-{r} hook (stage=fit)")
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
    # Connect with the user's PERSONAL token (user-scoped, not chiron-platform-scoped).
    # The orchestrator/trainer apps the manager spawns add the user's email to their
    # authorized_users, so the user's token can reach them even from outside the
    # chiron-platform workspace.
    server = await connect_to_server({
        "server_url": HYPHA_BASE,
        "token": TOKEN,
    })
    user = server.config.user or {}
    user_id = user.get("id") or ""
    user_email = user.get("email") or ""
    user_workspace = server.config.workspace
    log(f"connected as user_id={user_id!r} email={user_email!r} workspace={user_workspace!r}")

    # In the production UI, server.generateToken({permission: 'read_write',
    # expires_in: 30d}) mints a fresh 30-day user-scoped token (OAuth login
    # grants admin in the user's own workspace). Headless tests don't have
    # OAuth admin, so we re-use the PERSONAL_HYPHA_TOKEN directly — it is
    # already user-scoped with the right identity, and that's all the
    # orchestrator + trainers need at runtime.
    app_token = TOKEN
    log(f"using PERSONAL_HYPHA_TOKEN as app_token (length={len(app_token)})")

    am = await server.get_service("public/artifact-manager")

    # Track everything we create so cleanup runs even on failure.
    orch_site = "stanford"
    orch_app_id: Optional[str] = None
    orch_svc: Optional[str] = None
    trainer_apps: Dict[str, str] = {}   # site → app_id
    trainer_svcs: Dict[str, str] = {}   # site → service_id
    published_artifacts: List[str] = []

    try:
        log_step("Step 1 — deploy orchestrator on Stanford")
        mid = await mgr_for(server, orch_site)
        orch_app_id = await hypha_post(mid, "create_orchestrator", {
            "token": app_token,
            "trainer_artifact_id": TRAINER_ARTIFACT,
            "owner_id": user_id,
            "owner_email": user_email,
        })
        log(f"   app_id = {orch_app_id}")
        orch_svc = await wait_for_orchestrator(server, orch_site, orch_app_id)
        if not orch_svc:
            raise RuntimeError("orchestrator did not reach RUNNING")
        log(f"   service = {orch_svc}")

        log_step("Step 2 — deploy initial 2 trainers (Berlin + Boston, no pretrained)")
        for site in ("berlin", "boston"):
            res = await deploy_trainer(server, site, pretrained_artifact=None, app_token=app_token, user_id=user_id, user_email=user_email)
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

        log_step(f"Step 4 — start_training (rounds={NUM_ROUNDS}, initial_weights={GLOBAL_TRANSFORMER_INIT})")

        # Hook to fire mid round 2 (stage=fit): deploy + register Stockholm
        # with pretrained_weights_artifact=tabula-blood. Stockholm misses
        # round 2's fit, the eval-filter excludes Stockholm from round 2's
        # evaluate (no completed fit), and Stockholm participates from round
        # 3 onwards.
        async def add_stockholm_mid_round_2(_st):
            log("   *** mid round 2 fit: deploying Stockholm trainer with tabula-blood pretrained weights ***")
            res = await deploy_trainer(server, "stockholm",
                                       pretrained_artifact=BLOOD_FULL_MODEL,
                                       app_token=app_token,
                                       user_id=user_id,
                                       user_email=user_email)
            trainer_apps["stockholm"] = res["app_id"]
            trainer_svcs["stockholm"] = res["service_id"]
            keys = await hypha_post(trainer_svcs["stockholm"], "get_transformer_keys", {})
            check(len(keys) == 24, "stockholm reports 24 FlashAttention keys",
                  f"stockholm expected 24 transformer keys, got {len(keys)}")
            await hypha_post(orch_svc, "add_trainer", {
                "trainer_service_id": trainer_svcs["stockholm"],
                "orchestrator_service_id": orch_svc,
            })
            log("   ✓ stockholm registered (joins from round 3 onwards)")

        train_task = asyncio.create_task(hypha_post(orch_svc, "start_training", {
            "num_rounds": NUM_ROUNDS,
            "fit_config": {"batch_size": BATCH_SIZE},
            "eval_config": {"batch_size": BATCH_SIZE},
            "initial_weights": {"artifact_id": GLOBAL_TRANSFORMER_INIT, "file_path": "model.pth"},
            "per_round_timeout": 1800,
        }, timeout_s=3600))

        final_status = await watch_training(
            orch_svc,
            stop_after_round=NUM_ROUNDS,
            hook_mid_round={STOCKHOLM_JOINS_DURING_ROUND: add_stockholm_mid_round_2},
        )
        try:
            await asyncio.wait_for(train_task, timeout=120)
        except Exception as e:
            log(f"   train_task: {str(e)[:200]}")

        log(f"   final round={final_status.get('current_training_round')} stage={final_status.get('stage')}")
        check(final_status.get("current_training_round") == NUM_ROUNDS,
              f"reached {NUM_ROUNDS} rounds",
              f"expected round {NUM_ROUNDS}, got {final_status.get('current_training_round')}")
        # All 3 trainers should be in the orchestrator's roster by the end.
        regs = await hypha_post(orch_svc, "list_trainers", {})
        check(len(regs) == 3, "all 3 trainers registered to orchestrator",
              f"expected 3 registered trainers at end, got {len(regs)}: {regs}")

        # Verify history — per-trainer fit contributions
        history = await hypha_post(orch_svc, "get_training_history", {})
        log(f"   training_losses (per round avg): {history.get('training_losses')}")
        log(f"   validation_losses (per round avg): {history.get('validation_losses')}")
        per_client = history.get("client_training_losses", {}) or {}
        log(f"   per-client trainers: {len(per_client)}")
        for cid, rounds in per_client.items():
            n = len(rounds) if isinstance(rounds, list) else len(rounds or {})
            log(f"     {cid[-40:]}: {n} fit rounds")
        check(len(per_client) == 3, "all 3 trainers have per-client losses",
              f"expected 3 trainers in client_training_losses, got {len(per_client)}")

        log_step("Step 5a — Orchestrator publishes global transformer (Upload Model)")
        try:
            global_aid = await hypha_post(orch_svc, "save_global_weights", {
                "description": "E2E test (global transformer)",
            }, timeout_s=300)
            published_artifacts.append(global_aid)
            await verify_published(am, global_aid, expect_global_transformer=True, label="global transformer")
        except Exception as e:
            check(False, "save_global_weights OK", f"save_global_weights failed: {e}")

        log_step("Step 5b — Stockholm publishes full model (Upload Model)")
        try:
            stockholm_aid = await hypha_post(trainer_svcs["stockholm"], "save_model_weights", {
                "description": "E2E test (full Tabula) - Stockholm",
            }, timeout_s=300)
            published_artifacts.append(stockholm_aid)
            await verify_published(am, stockholm_aid, expect_global_transformer=False, label="stockholm full")
        except Exception as e:
            check(False, "Stockholm save_model_weights OK", f"Stockholm save_model_weights failed: {e}")

        log_step("Step 5c — Berlin + Boston save to local disk (Save to worker)")
        for site in ("berlin", "boston"):
            try:
                saved_path = await hypha_post(trainer_svcs[site], "save_local_model", {
                    "description": f"E2E test (local disk) - {site}",
                }, timeout_s=120)
                log(f"   {site} saved to {saved_path}")
                listed = await hypha_post(trainer_svcs[site], "list_local_model_weights", {})
                paths = [w.get("path") for w in (listed or [])]
                check(saved_path in paths, f"{site} list_local_model_weights includes saved file",
                      f"{site} saved_path {saved_path} not in list_local_model_weights")
            except Exception as e:
                check(False, f"{site} save_local_model OK", f"{site} save_local_model failed: {e}")

        log_step("Step 6 — verify run artifact landed in user's personal workspace")
        run_collection = f"{user_workspace}/chiron-training-runs"
        log(f"   listing {run_collection}")
        try:
            items = await am.list(parent_id=run_collection, limit=20, order_by='created_at>')
            srt = sorted(items, key=lambda x: x.get('created_at', 0), reverse=True)
            log(f"   found {len(srt)} run(s) in user's collection")
            # Find the run for this orchestrator + run_id from training_status
            final_run_id = final_status.get("run_id")
            final_artifact_id = final_status.get("run_artifact_id")
            log(f"   orchestrator reports run_artifact_id={final_artifact_id} run_id={final_run_id}")
            check(final_artifact_id is not None,
                  "orchestrator reports a run_artifact_id",
                  "orchestrator's training_status has no run_artifact_id (sync disabled?)")
            check(final_artifact_id and final_artifact_id.startswith(user_workspace + "/"),
                  f"run artifact id is under {user_workspace}/",
                  f"run artifact id {final_artifact_id!r} not in user workspace {user_workspace}")
            # Re-read the artifact to verify contents
            if final_artifact_id:
                art = await am.read(artifact_id=final_artifact_id)
                m = art.get("manifest", {}) if isinstance(art, dict) else {}
                trainers_map = m.get("trainers") or {}
                rounds_recorded = len(m.get("rounds") or [])
                status = m.get("status")
                log(f"   manifest: status={status}, trainers={len(trainers_map)}, rounds={rounds_recorded}, owner_id={m.get('owner_id')}, owner_email={m.get('owner_email')}")
                check(status == "completed", "run status=completed",
                      f"expected run status=completed, got {status!r}")
                check(len(trainers_map) == 3, "run manifest has 3 trainers",
                      f"expected 3 trainers in run manifest, got {len(trainers_map)}")
                check(rounds_recorded == NUM_ROUNDS, f"run manifest has {NUM_ROUNDS} rounds",
                      f"expected {NUM_ROUNDS} rounds in run manifest, got {rounds_recorded}")
                check(m.get("owner_id") == user_id, f"run manifest owner_id == {user_id!r}",
                      f"run manifest owner_id {m.get('owner_id')!r} != user_id {user_id!r}")
        except Exception as e:
            check(False, "user-workspace run artifact accessible", f"listing/reading user run artifact failed: {e}")

        log_step("Step 7 — cleanup published artifacts")
        for aid in list(published_artifacts):
            try:
                await am.delete(artifact_id=aid)
                log(f"   ✓ deleted {aid}")
            except Exception as e:
                log(f"   ✗ delete {aid}: {e}")
        # Clear local disk saves on Berlin + Boston
        for site in ("berlin", "boston"):
            try:
                cleared = await hypha_post(trainer_svcs[site], "clear_local_model_weights", {}, timeout_s=60)
                log(f"   ✓ {site} cleared local disk saves: {cleared}")
            except Exception as e:
                log(f"   ✗ {site} clear_local_model_weights: {e}")

    except Exception:
        traceback.print_exc()
        FAILURES.append("uncaught exception (see traceback above)")
    finally:
        log_step("Step 8 — teardown trainers + orchestrator")
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
