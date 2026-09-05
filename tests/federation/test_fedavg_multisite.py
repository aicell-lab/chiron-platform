"""Assert FedAvg, the round barrier and the per-trainer override at N sites.

Run against a live orchestrator with no real trainers registered:

    python tests/federation/test_fedavg_multisite.py --orchestrator <app-name>

Three mock sites with deliberately unequal sample counts run two rounds. Every
check below is a number computed from the site specs alone, so a passing run
says the orchestrator's arithmetic agrees with an independent calculation
rather than merely that it produced output.

What is checked:

  1. Broadcast. All three sites receive byte-identical parameters in round 1,
     and again in round 2. A federation that quietly sends each site its own
     weights would still produce plausible-looking losses.
  2. Aggregation. What round 2 broadcasts equals the sample-weighted mean of
     what the three sites returned in round 1, elementwise. Unequal sample
     counts are what make this distinguishable from an unweighted mean.
  3. Round barrier. The earliest round-2 fit starts after the latest round-1
     fit finished. Staggered fit delays make this a real question.
  4. weighted_average. The aggregated fit and evaluate losses equal the
     sample-weighted means of the per-site losses.
  5. Per-trainer override. A site given its own batch_size and learning_rate
     sees those values and the other two do not.

The run artifact this creates is deleted on the way out, so a synthetic run
does not land in the platform's public run list.
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

from mock_trainer import (  # noqa: E402
    MockFederation,
    SiteSpec,
    expected_fedavg,
    expected_weighted_loss,
)

from hypha_rpc import connect_to_server  # noqa: E402

SERVER_URL = "https://hypha.aicell.io"
WORKSPACE = "chiron-platform"
TRAINER_ARTIFACT = "chiron-platform/tabula-trainer"

# Three weight tensors, small enough to compare by eye when an assertion
# fails. The shapes differ so a bug that flattens or transposes the parameter
# list cannot pass by coincidence.
SHARED_KEYS = ["mock.layer0.weight", "mock.layer0.bias", "mock.layer1.weight"]


def _site(name: str, base: float, n_train: int, n_val: int, delay: float) -> SiteSpec:
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
        fit_delay=delay,
    )


# Unequal counts on purpose. With equal counts the weighted mean and the plain
# mean coincide, and the test could not tell a correct FedAvg from one that
# ignores num_examples entirely.
SITES = [
    _site("boston", 1.0, n_train=100, n_val=40, delay=0.0),
    _site("stockholm", 2.0, n_train=300, n_val=60, delay=6.0),
    _site("stanford", 4.0, n_train=600, n_val=90, delay=12.0),
]

# The site that gets its own values, and what they are. batch_size is a
# control parameter (it becomes a start_fit kwarg) and learning_rate is a
# model hyperparameter (it rides inside config=), so overriding both covers
# each side of the orchestrator's config split.
OVERRIDE_SITE = "stanford"
OVERRIDE = {"batch_size": 8, "learning_rate": 0.005}
BASE_FIT_CONFIG = {"batch_size": 32, "learning_rate": 0.001}
BASE_EVAL_CONFIG = {"batch_size": 32}

NUM_ROUNDS = 2

_failures: List[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        _failures.append(f"{label} {detail}".strip())


def arrays_equal(a: List[np.ndarray], b: List[np.ndarray], tol: float = 1e-5) -> bool:
    if len(a) != len(b):
        return False
    return all(
        x.shape == y.shape and np.allclose(x, y, rtol=0, atol=tol) for x, y in zip(a, b)
    )


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--orchestrator", required=True, help="Orchestrator app name")
    parser.add_argument("--keep-run", action="store_true", help="Leave the run artifact behind")
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
        print(f"Orchestrator already has trainers registered: {list(existing)}", file=sys.stderr)
        print("Use a fresh orchestrator so the mocks are the whole federation.", file=sys.stderr)
        return 2

    run_artifact = None
    async with MockFederation(server, TRAINER_ARTIFACT, SITES, SHARED_KEYS) as fed:
        print(f"Registered {len(fed.service_ids)} mock trainers")
        for sid in fed.service_ids:
            await orch.add_trainer(trainer_service_id=sid, orchestrator_service_id=orch_id)
        registered = list(await orch.list_trainers())
        print(f"Orchestrator sees {len(registered)} trainers: {registered}")
        if len(registered) != len(SITES):
            print("Registration collapsed sites onto one key", file=sys.stderr)
            return 2

        # The override is keyed by the client-agnostic service id, which is
        # what the orchestrator keys its client_manager by.
        override_key = next(r for r in registered if r.endswith(f"mock-trainer-{OVERRIDE_SITE}"))

        await orch.start_training(
            num_rounds=NUM_ROUNDS,
            fit_config=dict(BASE_FIT_CONFIG),
            fit_config_per_trainer={override_key: dict(OVERRIDE)},
            eval_config=dict(BASE_EVAL_CONFIG),
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
        trainers = {name: fed.trainers[name] for name in (s.name for s in SITES)}

        print("\nChecks")

        # 1. Broadcast identity, both rounds.
        for rnd in range(NUM_ROUNDS):
            seen = [t.seen_fit_parameters[rnd] for t in trainers.values() if len(t.seen_fit_parameters) > rnd]
            check(
                f"round {rnd + 1}: every site got the same parameters",
                len(seen) == len(SITES) and all(arrays_equal(seen[0], s) for s in seen[1:]),
                f"({len(seen)}/{len(SITES)} sites reported a fit call)",
            )

        # 2. Round 2's broadcast is the weighted mean of round 1's returns.
        want = expected_fedavg(SITES)
        got = trainers["boston"].seen_fit_parameters[1] if len(trainers["boston"].seen_fit_parameters) > 1 else None
        check(
            "round 2 broadcast equals the sample-weighted mean of round 1",
            got is not None and arrays_equal(want, got),
            "" if got is None else f"want[1]={want[1]} got[1]={got[1]}",
        )
        # An unweighted mean would be a different number. Prove the test can
        # tell them apart rather than trusting that it can.
        naive = [sum(s.weights[i].astype(np.float64) for s in SITES) / len(SITES) for i in range(3)]
        check(
            "the weighted and unweighted means differ, so check 2 is meaningful",
            not arrays_equal(want, naive),
            f"weighted[1]={want[1]} unweighted[1]={naive[1]}",
        )

        # 3. The round barrier held.
        r1_last_finish = max(t.fit_finished_at[0] for t in trainers.values())
        r2_first_start = min(t.fit_started_at[1] for t in trainers.values() if len(t.fit_started_at) > 1)
        check(
            "round 2 started only after every site finished round 1",
            r2_first_start > r1_last_finish,
            f"(gap {r2_first_start - r1_last_finish:.1f}s)",
        )

        # 4. weighted_average over the sites.
        want_fit = expected_weighted_loss(SITES, "fit")
        want_eval = expected_weighted_loss(SITES, "evaluate")
        fit_losses = list(history.get("training_losses") or [])
        eval_losses = list(history.get("validation_losses") or [])
        check(
            "aggregated fit loss is the sample-weighted mean",
            bool(fit_losses) and abs(float(fit_losses[0][1]) - want_fit) < 1e-6,
            f"want {want_fit} got {fit_losses[:1]}",
        )
        check(
            "aggregated evaluate loss is the sample-weighted mean",
            bool(eval_losses) and abs(float(eval_losses[0][1]) - want_eval) < 1e-6,
            f"want {want_eval} got {eval_losses[:1]}",
        )
        check(
            "every site appears in the per-client history",
            len(history.get("client_training_losses") or {}) == len(SITES),
            f"({len(history.get('client_training_losses') or {})} of {len(SITES)})",
        )

        # 5. The per-trainer override reached exactly one site.
        for name, t in trainers.items():
            want_bs = OVERRIDE["batch_size"] if name == OVERRIDE_SITE else BASE_FIT_CONFIG["batch_size"]
            want_lr = OVERRIDE["learning_rate"] if name == OVERRIDE_SITE else BASE_FIT_CONFIG["learning_rate"]
            got_bs = t.seen_fit_batch_sizes[0] if t.seen_fit_batch_sizes else None
            got_lr = t.seen_fit_configs[0].get("learning_rate") if t.seen_fit_configs else None
            check(
                f"{name}: batch_size {want_bs}, learning_rate {want_lr}",
                got_bs == want_bs and got_lr == want_lr,
                f"got batch_size={got_bs} learning_rate={got_lr}",
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
