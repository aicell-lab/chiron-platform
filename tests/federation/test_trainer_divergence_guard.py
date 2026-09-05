"""A site that diverges must be able to take part in the next round.

    python tests/federation/test_trainer_divergence_guard.py \\
        --trainer <trainer-app> --orchestrator <orchestrator-app>

Companion to test_nan_containment.py, which covers the orchestrator half of
svamp #0015. This one runs against a real trainer holding a real model, because
the half it covers is about what a site keeps on disk and in memory, which a
mock cannot have.

The problem it guards against is that a federated round only broadcasts the
shared trunk. A site's own modules (for Tabula the tissue embedder and the
projection heads) are never overwritten from outside. So a round that leaves
those modules numerically broken breaks the site permanently: every later round
returns nothing usable no matter how healthy the global model arriving from the
orchestrator is, and no broadcast, and not even the shared-only reload the
orchestrator issues at the start of a run, can put it back.

Four steps, each one a fit against the real trainer:

  1. a healthy round, to show the site works and to record its weights
  2. a global model that is already broken, which must be refused before it is
     ever applied
  3. a global model that is finite but degenerate, which makes the round
     diverge. The round must fail rather than report a broken result, and the
     site's own weights must come back exactly as they were in step 1
  4. a healthy round again, which is the whole point: after two bad rounds the
     site is still a working member of the federation

Step 3's degenerate model is every weight set to a constant. That is finite, so
step 2's guard does not catch it, but it is not a transformer either: the
attention logits and the LayerNorms blow up and the fit diverges on real data.
Reaching divergence through an actual forward pass rather than by injecting a
broken result is what makes step 4 meaningful.

The trainer is left holding freshly reloaded foundation weights on exit,
whatever the outcome.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import traceback
from typing import Any, List, Optional, Tuple

import numpy as np

from hypha_rpc import connect_to_server

SERVER_URL = "https://hypha.aicell.io"
WORKSPACE = "chiron-platform"
CHECKPOINT = "chiron-platform/tabula-foundation"
CHECKPOINT_FILE = "model.pth"

LIMIT_TRAIN_BATCHES = 2
BATCH_SIZE = 8
DEGENERATE_VALUE = 0.25
FIT_TIMEOUT_S = 1200

_failures: List[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        _failures.append(f"{label} {detail}".strip())


def _unpack(result: Any) -> Tuple[Any, Any, Any]:
    if isinstance(result, dict):
        return result.get("parameters"), result.get("num_examples"), result.get("metrics")
    if isinstance(result, (list, tuple)) and len(result) == 3:
        return result[0], result[1], result[2]
    return None, None, result


class FitOutcome:
    """What one fit did, whether it completed or was refused."""

    def __init__(self, status: str, message: str = "", loss: Any = None,
                 weights: Optional[List[np.ndarray]] = None):
        self.status = status
        self.message = message or ""
        self.loss = loss
        self.weights = weights

    @property
    def completed(self) -> bool:
        return self.status == "COMPLETED"

    @property
    def finite(self) -> bool:
        if self.weights is None:
            return False
        loss_ok = self.loss is not None and np.isfinite(float(self.loss))
        return loss_ok and all(np.isfinite(w).all() for w in self.weights)

    def __str__(self) -> str:
        if self.completed:
            return f"COMPLETED loss={self.loss} weights_finite={self.finite}"
        return f"{self.status}: {self.message.strip()[:220]}"


async def restore(trainer: Any, shared_only: bool) -> None:
    await trainer.load_pretrained_weights(
        artifact_id=CHECKPOINT, file_path=CHECKPOINT_FILE, shared_only=shared_only
    )


async def read_weights(trainer: Any) -> List[np.ndarray]:
    return [np.asarray(a) for a in await trainer.get_parameters()]


async def run_fit(trainer: Any, orch_id: str, parameters: List[np.ndarray],
                  server_round: int) -> FitOutcome:
    await trainer.start_fit(
        parameters=parameters,
        batch_size=BATCH_SIZE,
        config={},
        limit_train_batches=LIMIT_TRAIN_BATCHES,
        server_round=server_round,
        orchestrator_service_id=orch_id,
        session_id="divergence-guard",
    )
    deadline = asyncio.get_running_loop().time() + FIT_TIMEOUT_S
    status: Any = {}
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(5)
        status = await trainer.get_fit_status()
        if status.get("status") in ("COMPLETED", "FAILED", "CANCELLED"):
            break
    else:
        return FitOutcome("TIMEOUT", f"no terminal status within {FIT_TIMEOUT_S}s")

    if status.get("status") != "COMPLETED":
        return FitOutcome(status.get("status", "?"), str(status.get("message", "")))
    params, _, metrics = _unpack(status.get("result"))
    return FitOutcome(
        "COMPLETED",
        loss=dict(metrics or {}).get("loss"),
        weights=[np.asarray(a) for a in (params or [])],
    )


def same_weights(a: List[np.ndarray], b: List[np.ndarray]) -> bool:
    if len(a) != len(b):
        return False
    return all(
        x.shape == y.shape and np.array_equal(x, y, equal_nan=False)
        for x, y in zip(a, b)
    )


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trainer", required=True)
    parser.add_argument("--orchestrator", required=True)
    args = parser.parse_args()

    token = os.environ.get("HYPHA_TOKEN")
    if not token:
        print("HYPHA_TOKEN is not set", file=sys.stderr)
        return 2

    trainer_id = f"{WORKSPACE}/*:{args.trainer}"
    orch_id = f"{WORKSPACE}/*:{args.orchestrator}"
    server = await connect_to_server(
        {"server_url": SERVER_URL, "token": token, "workspace": WORKSPACE}
    )
    trainer = await server.get_service(trainer_id)
    orch = await server.get_service(orch_id)

    # start_fit is only accepted from a registered orchestrator, so the trainer
    # is registered for the duration and removed again on the way out.
    await orch.add_trainer(trainer_service_id=trainer_id, orchestrator_service_id=orch_id)
    try:
        print("Reloading the full checkpoint so the site starts from known-good weights")
        await restore(trainer, shared_only=False)
        clean = await read_weights(trainer)
        print(f"  {len(clean)} shared tensors, max |w| {max(np.abs(w).max() for w in clean):.4f}")

        print("\n1. a healthy round")
        healthy = await run_fit(trainer, orch_id, clean, 1)
        print(f"     {healthy}")
        # A completed round keeps its result, so what the site holds now is no
        # longer the checkpoint. This, not `clean`, is what the two bad rounds
        # below must leave behind.
        baseline = await read_weights(trainer)

        print("\n2. a global model that is already broken")
        broken = [w.copy() for w in clean]
        broken[0].reshape(-1)[0] = np.nan
        refused = await run_fit(trainer, orch_id, broken, 2)
        print(f"     {refused}")
        after_refusal = await read_weights(trainer)

        print(f"\n3. a finite but degenerate global model (every weight {DEGENERATE_VALUE})")
        degenerate = [np.full(w.shape, DEGENERATE_VALUE, dtype=w.dtype) for w in clean]
        diverged = await run_fit(trainer, orch_id, degenerate, 3)
        print(f"     {diverged}")
        after_divergence = await read_weights(trainer)

        print("\n4. a healthy round again, after both bad rounds")
        recovered = await run_fit(trainer, orch_id, clean, 4)
        print(f"     {recovered}")

        print("\nChecks")

        check(
            "the site trains normally to begin with",
            healthy.completed and healthy.finite,
            str(healthy),
        )

        check(
            "a broken global model is refused rather than applied",
            not refused.completed and "not finite" in refused.message,
            str(refused),
        )
        check(
            "refusing it left this site's own weights untouched",
            same_weights(baseline, after_refusal),
            "(the round must be rejected before _set_weights, not after)",
        )

        check(
            "a round that diverges fails instead of returning a broken model",
            not diverged.completed and "diverged" in diverged.message,
            str(diverged),
        )
        check(
            "the diverged round rolled this site back to its previous weights",
            same_weights(baseline, after_divergence),
            "(a partial rollback would leave the site-local modules broken)",
        )

        check(
            "the site is still a working member of the federation afterwards",
            recovered.completed and recovered.finite,
            str(recovered),
        )
        # Without the rollback this is the check that fails: the site would
        # return NaN here for good, and no broadcast could repair it.
        check(
            "its recovered loss is in the same range as the healthy one",
            healthy.loss is not None
            and recovered.loss is not None
            and abs(float(recovered.loss) - float(healthy.loss)) < 3.0,
            f"(healthy {healthy.loss}, after recovery {recovered.loss}; "
            "losses are means over randomly corrupted batches, so only the "
            "order of magnitude is meaningful)",
        )
    finally:
        print("\nLeaving the trainer on freshly reloaded foundation weights")
        try:
            await restore(trainer, shared_only=False)
        except Exception as exc:
            print(f"  (restore failed: {exc})")
        try:
            await orch.remove_trainer(trainer_service_id=trainer_id)
        except Exception as exc:
            print(f"  (could not remove the trainer: {exc})")

    print("\n" + ("ALL CHECKS PASSED" if not _failures else f"{len(_failures)} CHECK(S) FAILED"))
    for f in _failures:
        print(f"  - {f}")
    return 0 if not _failures else 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        traceback.print_exc()
        raise SystemExit(2)
