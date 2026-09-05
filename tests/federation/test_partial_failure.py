"""Exercise the failure and straggler paths that only exist above one site.

    python tests/federation/test_partial_failure.py --orchestrator <app> --scenario fail

With a single trainer there is no such thing as a partial round: the site
either finishes, or the round has nothing to aggregate and the run stops. The
interesting behaviour, a round that continues with the sites that answered,
starts at two. Three scenarios cover the three ways a site can leave a round.

  fail       A site reports FAILED. The other two are aggregated, and the
             failed site is kept out of the evaluate roster for that round,
             because a trainer that never fit cannot evaluate.
  straggler  A site overruns the round timeout but stops when asked. The
             orchestrator sends cancel_fit, collects the weights the site
             hands back, and counts it in the aggregate. Nothing is lost.
  deaf       A site overruns the round timeout and ignores cancel_fit. The
             orchestrator waits out its grace window, drops the site, and
             finishes the round with the other two.

In each case the expected aggregate is the sample-weighted mean over exactly
the sites that contributed, computed from the specs alone. Which sites those
are is the whole question, so an aggregate that matches is evidence the round
included and excluded the right ones.
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

_failures: List[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        _failures.append(f"{label} {detail}".strip())


def arrays_equal(a: List[np.ndarray], b: List[np.ndarray], tol: float = 1e-5) -> bool:
    if len(a) != len(b):
        return False
    return all(x.shape == y.shape and np.allclose(x, y, rtol=0, atol=tol) for x, y in zip(a, b))


def _site(name: str, base: float, n_train: int, n_val: int, **kw: Any) -> SiteSpec:
    return SiteSpec(
        name=name,
        weights=[
            np.full((2, 3), base, dtype=np.float32),
            np.full((3,), base * 10, dtype=np.float32),
            np.full((4, 2), -base, dtype=np.float32),
        ],
        num_examples=n_train,
        eval_examples=n_val,
        fit_loss=base,
        eval_loss=base * 2,
        **kw,
    )


def build_scenario(name: str):
    """Return (sites, odd_one_out, per_round_timeout).

    The two healthy sites are identical across scenarios so the expected
    aggregate over the survivors is the same number every time, and only the
    third site's behaviour changes.
    """
    healthy = [
        _site("boston", 1.0, 100, 40),
        _site("stockholm", 2.0, 300, 60),
    ]
    if name == "fail":
        # Timeout is generous: this site fails immediately, so the round must
        # move on without ever hitting the graceful-stop path.
        return healthy + [_site("stanford", 4.0, 600, 90, fail_fit_with="mock GPU OOM")], "stanford", 120
    if name == "straggler":
        # 40s of work against a 25s round. Long enough that the round timeout
        # fires first, short enough that the site is still there to answer.
        return healthy + [_site("stanford", 4.0, 600, 90, fit_delay=40.0)], "stanford", 25
    if name == "deaf":
        # Overruns the round timeout and then keeps going past the 180s grace
        # window, so the orchestrator has to give up on it rather than wait.
        return (
            healthy + [_site("stanford", 4.0, 600, 90, fit_delay=200.0, honour_cancel=False)],
            "stanford",
            25,
        )
    raise ValueError(name)


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--orchestrator", required=True)
    parser.add_argument("--scenario", required=True, choices=["fail", "straggler", "deaf"])
    parser.add_argument("--keep-run", action="store_true")
    args = parser.parse_args()

    token = os.environ.get("HYPHA_TOKEN")
    if not token:
        print("HYPHA_TOKEN is not set", file=sys.stderr)
        return 2

    sites, odd, per_round_timeout = build_scenario(args.scenario)
    # The odd site out is expected to contribute in the straggler scenario
    # (it answers the stop signal) and not in the other two.
    contributes = args.scenario == "straggler"
    survivors = [s.name for s in sites] if contributes else [s.name for s in sites if s.name != odd]

    orch_id = f"{WORKSPACE}/*:{args.orchestrator}"
    server = await connect_to_server(
        {"server_url": SERVER_URL, "token": token, "workspace": WORKSPACE}
    )
    orch = await server.get_service(orch_id)

    existing = await orch.list_trainers()
    if existing:
        print(f"Orchestrator already has trainers: {list(existing)}", file=sys.stderr)
        return 2

    print(f"Scenario '{args.scenario}': {odd} is the odd site out, "
          f"round timeout {per_round_timeout}s, expected contributors {survivors}")

    run_artifact = None
    async with MockFederation(server, TRAINER_ARTIFACT, sites, SHARED_KEYS) as fed:
        for sid in fed.service_ids:
            await orch.add_trainer(trainer_service_id=sid, orchestrator_service_id=orch_id)
        registered = list(await orch.list_trainers())
        if len(registered) != len(sites):
            print(f"Expected {len(sites)} registrations, got {registered}", file=sys.stderr)
            return 2

        await orch.start_training(
            num_rounds=NUM_ROUNDS,
            fit_config={"batch_size": 32, "learning_rate": 0.001},
            eval_config={"batch_size": 32},
            per_round_timeout=per_round_timeout,
            transport="websocket",
        )

        deadline = asyncio.get_running_loop().time() + 1800
        status: Dict[str, Any] = {}
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(10)
            status = await orch.get_training_status()
            if not status.get("is_running"):
                break
            print(f"    round {status.get('current_training_round')}/{NUM_ROUNDS} "
                  f"stage={status.get('stage')}")
        else:
            print("Training did not finish in 30 minutes", file=sys.stderr)
            await orch.stop_training()
            return 2

        run_artifact = status.get("run_artifact_id")
        history = await orch.get_training_history()
        trainers = fed.trainers

        print("\nChecks")

        # The run has to survive the incident at all. A partial round that
        # aborts the whole session is the failure mode this is guarding.
        err = status.get("error")
        check(
            f"the run completed all {NUM_ROUNDS} rounds despite one site "
            f"{'failing' if args.scenario == 'fail' else 'overrunning'}",
            status.get("current_training_round") == NUM_ROUNDS and not err,
            f"round={status.get('current_training_round')} error={err}",
        )

        # Round 2's broadcast names exactly who contributed to round 1.
        want = expected_fedavg(sites, contributing=survivors)
        got = trainers["boston"].seen_fit_parameters[1] if len(trainers["boston"].seen_fit_parameters) > 1 else None
        check(
            f"round 2 broadcast is the weighted mean over {len(survivors)} contributing site(s)",
            got is not None and arrays_equal(want, got),
            "" if got is None else f"want[1]={want[1]} got[1]={got[1]}",
        )
        # Show that the number above distinguishes the two candidate rosters,
        # so a pass is not an accident of the chosen weights. The comparison
        # is always "with the odd site" against "without it", which is the
        # aggregate the orchestrator would have produced had it made the
        # opposite decision about that site.
        counterfactual = expected_fedavg(
            sites, contributing=None if not contributes else [s.name for s in sites if s.name != odd]
        )
        check(
            "the aggregate would have been a different number had the round "
            f"{'excluded' if contributes else 'included'} {odd}",
            not arrays_equal(want, counterfactual),
            f"observed[1]={want[1]} counterfactual[1]={counterfactual[1]}",
        )

        # Per-client history is the platform's record of who took part.
        recorded = set((history.get("client_training_losses") or {}).keys())
        want_recorded = {r for r in registered if any(r.endswith(f"mock-trainer-{s}") for s in survivors)}
        check(
            "the per-site fit history lists exactly the contributing sites",
            recorded == want_recorded,
            f"got {sorted(recorded)}",
        )

        # A site that did not fit must not be asked to evaluate: the trainer
        # rejects an evaluate that no fit preceded.
        if not contributes:
            check(
                f"{odd} was kept out of the evaluate roster",
                len(trainers[odd].seen_eval_parameters) == 0,
                f"(it saw {len(trainers[odd].seen_eval_parameters)} evaluate calls)",
            )

        # The stop signal is what separates a straggler from a dropped site,
        # so check it was actually sent, and only to the site that overran.
        if args.scenario in ("straggler", "deaf"):
            check(
                f"cancel_fit was sent to {odd}",
                trainers[odd].cancel_fit_calls >= 1,
                f"({trainers[odd].cancel_fit_calls} call(s))",
            )
            quiet = [n for n, t in trainers.items() if n != odd and t.cancel_fit_calls]
            check(
                "the sites that finished on time were not asked to stop",
                not quiet,
                f"unexpectedly cancelled: {quiet}",
            )
        if args.scenario == "straggler":
            check(
                f"{odd}'s weights were collected after it stopped",
                len(trainers[odd].seen_eval_parameters) > 0,
                "(it was included in the evaluate roster, so its fit was accepted)",
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
