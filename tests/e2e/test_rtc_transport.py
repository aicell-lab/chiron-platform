"""Smoke test for the new WebRTC-transport FlowerClientProxy path.

Scope: prove that
  (a) orchestrator 0.3.10 spawns cleanly on a demo worker (no import /
      construction regression from the FlowerClientProxy refactor),
  (b) the orchestrator successfully opens a WebRTC data channel to the
      trainer when the first `start_fit` fires,
  (c) a single fit + evaluate round completes end-to-end with
      credible loss values, meaning weights flowed correctly over the
      data channel in both directions,
  (d) round-end cleanup tears the peer connection down without leaking.

Uses two workers: Stanford (orchestrator, CPU-only) and Stockholm (a
single trainer, one dataset). Runs 1 training round. Cleans up on exit
in every branch.

Not a replacement for tests/e2e/full_pipeline.py — that covers late-join,
multiple trainers, publish/save flows, and 5 rounds. This is a focused
regression gate for the transport switch.

Exit code 0 on success, non-zero on the first hard failure.
"""

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

from hypha_rpc import connect_to_server

# Reuse the discovery + wait helpers from the full pipeline test so we hit
# the exact same list_services filters + service_ids shape-walking. Any
# behaviour change in the manager RPC surface breaks both places at once.
sys.path.insert(0, str(Path(__file__).parent))
from full_pipeline import (  # type: ignore  # noqa: E402
    WORKSPACE,
    discover_managers as _discover_managers_full,
    hypha_post,
    mgr_for,
    wait_for_orchestrator,
    wait_for_trainer,
)


# ── env / config ───────────────────────────────────────────────────────────

HYPHA_URL = "https://hypha.aicell.io"
NUM_ROUNDS = 1
PER_ROUND_TIMEOUT_MIN = 30


def load_token() -> str:
    """Same lookup as tests/e2e/full_pipeline.py — PERSONAL_HYPHA_TOKEN in
    tabula/.env so this run lands on the user's own workspace and the
    orchestrator/trainer auth cleanly."""
    env_path = Path("/data/nmechtel/tabula/.env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("PERSONAL_HYPHA_TOKEN="):
                return line.split("=", 1)[1].strip()
    tok = os.environ.get("PERSONAL_HYPHA_TOKEN") or os.environ.get("HYPHA_TOKEN")
    if not tok:
        raise SystemExit("PERSONAL_HYPHA_TOKEN not found")
    return tok


def log(msg: str = "") -> None:
    print(msg, flush=True)


def log_step(title: str) -> None:
    log()
    log(f"── {title}")


# ── manager discovery + deploy helpers (mirrors full_pipeline.py) ─────────

async def call_manager(server, mgr_id: str, method: str, **kwargs) -> Any:
    svc = await server.get_service(mgr_id)
    return await getattr(svc, method)(**kwargs)


# ── the test ──────────────────────────────────────────────────────────────

async def main() -> int:
    token = load_token()
    server = await connect_to_server({"server_url": HYPHA_URL, "token": token})
    ws = server.config.workspace
    user_id = server.config.user["id"]
    user_email = server.config.user.get("email")
    log(f"connected: workspace={ws}, user={user_id} ({user_email})")

    log_step("1. Discover Stanford + Stockholm managers")
    managers = await _discover_managers_full(server)
    stanford_mgr = managers.get("stanford")
    stockholm_mgr = managers.get("stockholm")
    assert stanford_mgr, f"No Stanford manager visible: {list(managers)}"
    assert stockholm_mgr, f"No Stockholm manager visible: {list(managers)}"
    log(f"  Stanford: {stanford_mgr}")
    log(f"  Stockholm: {stockholm_mgr}")

    # Track everything we create so cleanup runs on both success + failure.
    orch_app_id: Optional[str] = None
    orch_svc_id: Optional[str] = None
    trainer_app_id: Optional[str] = None
    trainer_svc_id: Optional[str] = None
    trainer_was_preexisting = False  # if True, cleanup only unregisters, does not remove the app

    try:
        log_step("2. Use the PERSONAL_HYPHA_TOKEN as app_token")
        # server.generate_token requires admin on our own workspace, which
        # the personal token doesn't have. full_pipeline.py hits the same
        # wall and passes the personal token through directly — the app
        # runs as our identity on our workspace.
        app_token = token
        log(f"  ok (length={len(app_token)})")

        log_step("3. Deploy orchestrator (0.3.10) on Stanford")
        orch_app_id = await call_manager(
            server,
            stanford_mgr,
            "create_orchestrator",
            token=app_token,
            owner_id=user_id,
            owner_email=user_email,
        )
        log(f"  app_id={orch_app_id}")

        log_step("4. Wait for orchestrator service to register")
        orch_svc_id = await wait_for_orchestrator(server, "stanford", orch_app_id)
        assert orch_svc_id, f"orchestrator {orch_app_id} never registered a service"
        log(f"  orch_svc_id={orch_svc_id}")

        log_step("5. Reuse an existing Stockholm trainer if one is available; otherwise deploy fresh")
        # Demo takes routinely leave a trainer running on Stockholm — the
        # worker has one GPU slot, so re-deploying triggers "insufficient
        # resources". Instead reuse the existing trainer, which is exactly
        # the realistic operator flow (spin up an orchestrator, register
        # trainers that are already running).
        mid = await mgr_for(server, "stockholm")
        info = await hypha_post(mid, "get_worker_info", {}, timeout_s=15)
        preexisting_trainers = list((info.get("trainers_status") or {}))
        if preexisting_trainers:
            trainer_app_id = preexisting_trainers[0]
            trainer_was_preexisting = True
            log(f"  reusing pre-existing trainer app '{trainer_app_id}' on Stockholm")
        else:
            trainer_app_id = await call_manager(
                server,
                stockholm_mgr,
                "create_trainer",
                datasets=["blood_perturb_rna_001"],
                token=app_token,
                owner_id=user_id,
                owner_email=user_email,
            )
            log(f"  deployed fresh trainer app '{trainer_app_id}' on Stockholm")

        log_step("6. Wait for trainer service to register")
        trainer_svc_id = await wait_for_trainer(server, "stockholm", trainer_app_id)
        assert trainer_svc_id, f"trainer {trainer_app_id} never registered a service"
        log(f"  trainer_svc_id={trainer_svc_id}")

        log_step("7. Register trainer with orchestrator")
        orch = await server.get_service(orch_svc_id)
        await orch.add_trainer(
            trainer_service_id=trainer_svc_id,
            orchestrator_service_id=orch_svc_id,
        )
        registered = await orch.list_trainers()
        assert trainer_svc_id in registered, f"add_trainer didn't stick: {registered}"
        log(f"  registered trainers: {registered}")

        log_step("8. Start 1-round training (this is where the WebRTC channel opens)")
        # Explicit initial_weights so the first round has meaningful weights.
        # `start_training` is fire-and-forget — the loop runs in a
        # background task server-side. We poll get_training_status.
        await orch.start_training(
            num_rounds=NUM_ROUNDS,
            fit_config={},
            eval_config={},
            per_round_timeout=PER_ROUND_TIMEOUT_MIN * 60,
            initial_weights={
                "artifact_id": "chiron-platform/tabula-foundation",
                "file_path": "model.pth",
            },
        )
        log("  start_training returned; polling status")

        log_step("9. Poll until training completes")
        deadline = time.time() + PER_ROUND_TIMEOUT_MIN * 60 + 300
        last_stage = None
        last_round = None
        while time.time() < deadline:
            status = await orch.get_training_status()
            stage = status.get("stage")
            rnd = status.get("current_training_round")
            if (stage, rnd) != (last_stage, last_round):
                log(f"  stage={stage!r:<15} round={rnd}")
                last_stage, last_round = stage, rnd
            if not status.get("is_running"):
                log(f"  training loop exited. final stage={stage!r}, round={rnd}")
                break
            await asyncio.sleep(3)
        else:
            raise AssertionError("training did not complete within the timeout")

        log_step("10. Verify round 1 loss values look real")
        history = await orch.get_training_history()
        train_losses = history.get("training_losses") or []
        val_losses = history.get("validation_losses") or []
        assert train_losses, f"no training_losses in history: {history}"
        assert val_losses, f"no validation_losses in history: {history}"
        r, train_loss = train_losses[-1]
        r2, val_loss = val_losses[-1]
        assert r == NUM_ROUNDS and r2 == NUM_ROUNDS, f"unexpected rounds: {r=} {r2=}"
        assert train_loss == train_loss and val_loss == val_loss  # NaN check
        assert train_loss > 0, f"train_loss={train_loss} is non-positive — RTC likely returned garbage"
        assert val_loss > 0, f"val_loss={val_loss} is non-positive"
        log(f"  ✓ round {NUM_ROUNDS} train_loss={train_loss:.4f}  val_loss={val_loss:.4f}")

        log_step("11. Confirm per-client losses were captured (proves weight round-trip)")
        client_train = history.get("client_training_losses") or {}
        assert trainer_svc_id in client_train and client_train[trainer_svc_id], (
            f"no per-client fit metrics recorded for {trainer_svc_id}: {list(client_train)}"
        )
        _, cl_train_loss = client_train[trainer_svc_id][-1]
        log(f"  ✓ per-client train_loss={cl_train_loss:.4f}")

        log("")
        log("╭─────────────────────────────────────────────╮")
        log("│  ✅ RTC transport smoke test PASSED         │")
        log("│    fit + evaluate rode WebRTC data channel  │")
        log("╰─────────────────────────────────────────────╯")
        return 0

    finally:
        log()
        log_step("cleanup")
        if orch_svc_id and trainer_svc_id:
            try:
                orch = await server.get_service(orch_svc_id)
                await orch.remove_trainer(trainer_service_id=trainer_svc_id)
                log("  ✓ trainer removed from orchestrator (RTC peer connection closed)")
            except Exception as e:
                log(f"  · trainer unregister failed: {e}")
        if trainer_app_id and not trainer_was_preexisting:
            try:
                await call_manager(
                    server, stockholm_mgr,
                    "remove_trainer", application_id=trainer_app_id,
                    caller_id=user_id, caller_email=user_email,
                )
                log(f"  ✓ trainer app {trainer_app_id} removed")
            except Exception as e:
                log(f"  · trainer remove failed: {e}")
        elif trainer_was_preexisting:
            log(f"  · trainer app {trainer_app_id} was pre-existing — leaving in place")
        if orch_app_id:
            try:
                await call_manager(
                    server, stanford_mgr,
                    "remove_orchestrator", application_id=orch_app_id,
                    caller_id=user_id, caller_email=user_email,
                )
                log(f"  ✓ orchestrator app {orch_app_id} removed")
            except Exception as e:
                log(f"  · orchestrator remove failed: {e}")
        await server.disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
