"""One diverged site must not take the federation down with it.

    python tests/federation/test_nan_containment.py --orchestrator <app>

Aggregation is a weighted sum, and NaN times any weight is still NaN. Before
svamp #0015 that meant a single site returning a broken model destroyed the
aggregate for every institution in the round, however small that site's share
of the data, and the broken aggregate was then sent back to all of them. The
run still reported success and still landed in the platform's run list, with
blank losses as the only sign.

Three mock sites at 100, 300 and 600 samples. The third returns weights full
of NaN. Two rounds. What the checks establish, in order of what they rule out:

  * the run survives, rather than completing "successfully" with nothing in it
  * round 2's broadcast is finite, so the healthy sites were not poisoned
  * round 2's broadcast is exactly the weighted mean over the two healthy
    sites, computed independently here, so the diverged site was dropped from
    the aggregate rather than merely averaged into something that happens to
    look finite
  * the aggregate over all three sites would have been a different (non-finite)
    number, so the check above can tell the two apart
  * the diverged site is absent from the per-site history the platform records
  * the diverged site is kept off the evaluate roster, since a site whose fit
    was rejected has nothing to evaluate

The NaN site's 600 samples are the largest share of the three on purpose. If
the containment were sample-weighted in any way, this is the arrangement that
would expose it.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mock_trainer import MockFederation, SiteSpec, expected_fedavg  # noqa: E402

from hypha_rpc import connect_to_server  # noqa: E402

SERVER_URL = "https://hypha.aicell.io"
WORKSPACE = "chiron-platform"
TRAINER_ARTIFACT = "chiron-platform/tabula-trainer"
SHARED_KEYS = ["mock.layer0.weight", "mock.layer0.bias", "mock.layer1.weight"]

NUM_ROUNDS = 2
NAN_SITE = "stanford"

_failures: List[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        _failures.append(f"{label} {detail}".strip())


def arrays_equal(a: List[np.ndarray], b: List[np.ndarray], tol: float = 1e-5) -> bool:
    if len(a) != len(b):
        return False
    return all(
        x.shape == y.shape and np.allclose(x, y, rtol=0, atol=tol)
        for x, y in zip(a, b)
    )


def _site(name: str, base: float, n_train: int, n_val: int) -> SiteSpec:
    weights = [
        np.full((2, 3), base, dtype=np.float32),
        np.full((3,), base * 10, dtype=np.float32),
        np.full((4, 2), -base, dtype=np.float32),
    ]
    return SiteSpec(
        name=name,
        weights=weights,
        num_examples=n_train,
        eval_examples=n_val,
        fit_loss=base,
        eval_loss=base * 2,
    )


def _break(spec: SiteSpec) -> SiteSpec:
    """Make one site return a model that has gone numerically bad.

    Only the first tensor is spoiled, and only partly. A site whose every
    weight is NaN would be caught by any check at all. One bad entry in one
    tensor is what a diverged optimiser actually produces, and it is enough:
    a weighted sum propagates it to every element it touches.
    """
    broken = [w.copy() for w in spec.weights]
    broken[0][0, 0] = np.nan
    spec.weights = broken
    spec.fit_loss = float("nan")
    spec.eval_loss = float("nan")
    return spec


SITES = [
    _site("boston", 1.0, 100, 40),
    _site("stockholm", 2.0, 300, 60),
    _break(_site(NAN_SITE, 4.0, 600, 90)),
]
HEALTHY = [s.name for s in SITES if s.name != NAN_SITE]


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--orchestrator", required=True)
    parser.add_argument("--keep-run", action="store_true")
    args = parser.parse_args()

    token = os.environ.get("HYPHA_TOKEN")
    if not token:
        print("HYPHA_TOKEN is not set", file=sys.stderr)
        return 2

    orch_id = f"{WORKSPACE}/*:{args.orchestrator}"
    server = await connect_to_server(
        {"server_url": SERVER_URL, "token": token, "workspace": WORKSPACE}
    )
    orch = await server.get_service(orch_id)

    existing = await orch.list_trainers()
    if existing:
        print(f"Orchestrator already has trainers: {list(existing)}", file=sys.stderr)
        return 2

    print(
        f"{NAN_SITE} returns NaN weights and holds the largest sample share "
        f"({SITES[-1].num_examples} of "
        f"{sum(s.num_examples for s in SITES)}). Expected contributors: {HEALTHY}"
    )

    run_artifact = None
    async with MockFederation(server, TRAINER_ARTIFACT, SITES, SHARED_KEYS) as fed:
        for sid in fed.service_ids:
            await orch.add_trainer(
                trainer_service_id=sid, orchestrator_service_id=orch_id
            )
        registered = list(await orch.list_trainers())
        if len(registered) != len(SITES):
            print(f"Expected {len(SITES)} registrations, got {registered}", file=sys.stderr)
            return 2

        await orch.start_training(
            num_rounds=NUM_ROUNDS,
            fit_config={"batch_size": 32, "learning_rate": 0.001},
            eval_config={"batch_size": 32},
            per_round_timeout=300,
            transport="websocket",
        )

        deadline = asyncio.get_running_loop().time() + 900
        status: Dict[str, Any] = {}
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(5)
            status = await orch.get_training_status()
            if not status.get("is_running"):
                break
            print(
                f"    round {status.get('current_training_round')}/{NUM_ROUNDS} "
                f"stage={status.get('stage')}"
            )
        else:
            print("Training did not finish within 15 minutes", file=sys.stderr)
            await orch.stop_training()
            return 2

        run_artifact = status.get("run_artifact_id")
        history = await orch.get_training_history()
        trainers = fed.trainers

        print("\nChecks")

        err = status.get("error")
        check(
            f"the run completed all {NUM_ROUNDS} rounds with one site diverged",
            status.get("current_training_round") == NUM_ROUNDS and not err,
            f"round={status.get('current_training_round')} error={err}",
        )

        got = (
            trainers["boston"].seen_fit_parameters[1]
            if len(trainers["boston"].seen_fit_parameters) > 1
            else None
        )
        check(
            "the healthy sites received a finite model in round 2",
            got is not None
            and all(np.isfinite(np.asarray(a)).all() for a in got),
            "(a non-finite broadcast means the aggregate was poisoned)",
        )

        want = expected_fedavg(SITES, contributing=HEALTHY)
        check(
            "round 2 broadcast is the weighted mean over the two healthy sites",
            got is not None and arrays_equal(want, got),
            "" if got is None else f"want[1]={want[1]} got[1]={got[1]}",
        )
        # The counterfactual is the aggregate the orchestrator would have
        # produced had it kept the diverged site, which is what it used to do.
        counterfactual = expected_fedavg(SITES)
        check(
            "including the diverged site would have given a different number",
            not arrays_equal(want, counterfactual),
            f"observed[1]={want[1]} counterfactual[1]={counterfactual[1]}",
        )

        recorded = set((history.get("client_training_losses") or {}).keys())
        want_recorded = {
            r
            for r in registered
            if any(r.endswith(f"mock-trainer-{s}") for s in HEALTHY)
        }
        check(
            "the per-site fit history lists only the healthy sites",
            recorded == want_recorded,
            f"got {sorted(recorded)}",
        )

        check(
            f"{NAN_SITE} was kept off the evaluate roster",
            len(trainers[NAN_SITE].seen_eval_parameters) == 0,
            f"(it saw {len(trainers[NAN_SITE].seen_eval_parameters)} evaluate calls)",
        )

        losses = [float(v) for _, v in (history.get("training_losses") or [])]
        check(
            "the run's recorded losses are numbers, not blanks",
            bool(losses) and all(np.isfinite(x) for x in losses),
            f"({losses})",
        )

        await orch.reset_training_state()
        for sid in registered:
            try:
                await orch.remove_trainer(trainer_service_id=sid)
            except Exception as exc:
                print(f"    (could not remove {sid}: {exc})")

    if run_artifact and not args.keep_run:
        try:
            am = await server.get_service("public/artifact-manager")
            await am.delete(artifact_id=run_artifact)
            print(f"\nDeleted the synthetic run artifact {run_artifact}")
        except Exception as exc:
            print(f"\nCould not delete run artifact {run_artifact}: {exc}")

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
