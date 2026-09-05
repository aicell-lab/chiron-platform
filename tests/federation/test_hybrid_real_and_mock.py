"""Run a real Tabula trainer and mock sites in one federation.

    python tests/federation/test_hybrid_real_and_mock.py \
        --orchestrator <fresh-app> --trainer <tabula-trainer-app>

The all-mock tests prove the orchestrator's arithmetic against an
independently computed number, but every tensor in them is a toy array of a
handful of floats. This one puts a real Tabula state dict through the same
path: 24 float32 tensors, about 3 MB, produced by an actual optimiser on a
GPU, aggregated against sites the test controls.

How a real trainer can still be checked exactly
-----------------------------------------------
The real site's post-fit weights R are unknown, so the aggregate cannot be
predicted outright. What makes it checkable is choosing what the mocks return.
Both mocks return M, the starting model P halved, so with s for the real
site's declared share of the samples FedAvg gives

    G = (1 - s) * M + s * R,   that is   G - M = s * (R - M).

Two optimiser steps at 1e-4 barely move a transformer, so R is close to P and
R - M is close to P - M. Least-squares projecting the observed G - M onto the
known P - M therefore recovers s itself:

    alpha = <G - M, P - M> / <P - M, P - M>.

One scalar, computed over every element of all 24 tensors, separates the four
things that could have happened:

  * correct sample-weighted FedAvg     alpha ~= s, about 0.03
  * real site dropped from the round   alpha  = 0
  * unweighted mean of the three       alpha ~= 1/3
  * mocks ignored, real site alone     alpha ~= 1

Halving rather than filling with a constant matters. A state dict where every
entry is the same number is not a transformer: its attention logits and
LayerNorms blow up, the real site's next round returns NaN, and that one NaN
then poisons the aggregate for every site regardless of sample weight. Half a
real model is still a real model.

The mock tensors are built from the live trainer's own parameters, not from
constants written here, so the test follows the model rather than restating
it.

Registration order matters. The orchestrator caches the shared key list from
the first client that registers and never clears it, so the real trainer has
to be added first and the orchestrator has to be a fresh one that has not
already cached some other federation's keys.
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

from mock_trainer import MockFederation, SiteSpec  # noqa: E402

from hypha_rpc import connect_to_server  # noqa: E402

SERVER_URL = "https://hypha.aicell.io"
WORKSPACE = "chiron-platform"
TRAINER_ARTIFACT = "chiron-platform/tabula-trainer"

# What every mock returns: the starting model, halved. Halving leaves a
# transformer a transformer, so the aggregate the real site trains on next
# round is still something its own forward pass survives.
MOCK_SCALE = 0.5

# Each mock claims this many training samples against the real site's 16, so
# the real share is about 3 percent. Small enough that the aggregate is
# dominated by a known quantity, large enough that recovering the real site's
# weights from the aggregate only amplifies float32 noise by about 30.
MOCK_EXAMPLES = 250
MOCK_EVAL_EXAMPLES = 250
MOCK_SITES = ["boston", "stanford"]

NUM_ROUNDS = 2
# One optimiser step per round per site. The question here is what happens to
# the weights in transit, not whether the model learns.
LIMIT_TRAIN_BATCHES = 2
LIMIT_VAL_BATCHES = 2

_failures: List[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        _failures.append(f"{label} {detail}".strip())


def structure(arrays: List[np.ndarray]) -> List[tuple]:
    return [(a.shape, str(a.dtype)) for a in arrays]


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--orchestrator", required=True, help="Fresh orchestrator app name")
    parser.add_argument("--trainer", required=True, help="Real Tabula trainer app name")
    parser.add_argument("--keep-run", action="store_true")
    args = parser.parse_args()

    token = os.environ.get("HYPHA_TOKEN")
    if not token:
        print("HYPHA_TOKEN is not set", file=sys.stderr)
        return 2

    orch_id = f"{WORKSPACE}/*:{args.orchestrator}"
    real_id = f"{WORKSPACE}/*:{args.trainer}"

    server = await connect_to_server(
        {"server_url": SERVER_URL, "token": token, "workspace": WORKSPACE}
    )
    orch = await server.get_service(orch_id)
    real = await server.get_service(real_id)

    if list(await orch.list_trainers()):
        print("Orchestrator already has trainers registered", file=sys.stderr)
        return 2
    if await real.is_busy():
        print("The real trainer is busy", file=sys.stderr)
        return 2

    # Shapes come off the live model so the mocks are indistinguishable from
    # real sites as far as the orchestrator's weight handling is concerned.
    shared_keys = list(await real.get_shared_keys())
    reference = [np.asarray(a) for a in await real.get_parameters()]
    props = await real.get_properties()
    print(
        f"Real trainer '{args.trainer}': {len(shared_keys)} shared keys, "
        f"{sum(a.nbytes for a in reference) / 1e6:.2f} MB, "
        f"{props.get('train_samples')} train samples"
    )

    halved = [(a.astype(np.float64) * MOCK_SCALE).astype(a.dtype) for a in reference]
    specs = [
        SiteSpec(
            name=name,
            weights=halved,
            num_examples=MOCK_EXAMPLES,
            eval_examples=MOCK_EVAL_EXAMPLES,
            fit_loss=0.5,
            eval_loss=0.5,
        )
        for name in MOCK_SITES
    ]

    run_artifact = None
    registered: List[str] = []
    try:
        async with MockFederation(server, TRAINER_ARTIFACT, specs, shared_keys) as fed:
            # Real trainer first: whichever client registers first is the one
            # whose shared key list the orchestrator caches for the whole run.
            await orch.add_trainer(trainer_service_id=real_id, orchestrator_service_id=orch_id)
            for sid in fed.service_ids:
                await orch.add_trainer(trainer_service_id=sid, orchestrator_service_id=orch_id)
            registered = list(await orch.list_trainers())
            print(f"Orchestrator sees {len(registered)} trainers: {registered}")
            if len(registered) != len(specs) + 1:
                print("Registration did not produce one key per site", file=sys.stderr)
                return 2

            await orch.start_training(
                num_rounds=NUM_ROUNDS,
                # limit_val_batches belongs to the evaluate config alone.
                # Both are control parameters, so the orchestrator splats
                # them straight into the trainer call, and start_fit does not
                # declare limit_val_batches.
                fit_config={
                    "batch_size": int(props.get("max_batch_size") or 8),
                    "limit_train_batches": LIMIT_TRAIN_BATCHES,
                },
                eval_config={
                    "batch_size": int(props.get("max_batch_size") or 8),
                    "limit_val_batches": LIMIT_VAL_BATCHES,
                },
                per_round_timeout=900,
                transport="websocket",
            )

            deadline = asyncio.get_running_loop().time() + 2700
            status: Dict[str, Any] = {}
            while asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(10)
                status = await orch.get_training_status()
                if not status.get("is_running"):
                    break
                print(
                    f"    round {status.get('current_training_round')}/{NUM_ROUNDS} "
                    f"stage={status.get('stage')}"
                )
            else:
                print("Training did not finish in 45 minutes", file=sys.stderr)
                await orch.stop_training()
                return 2

            run_artifact = status.get("run_artifact_id")
            history = await orch.get_training_history()
            mocks = fed.trainers

            print("\nChecks")

            err = status.get("error")
            check(
                f"the run completed all {NUM_ROUNDS} rounds",
                status.get("current_training_round") == NUM_ROUNDS and not err,
                f"round={status.get('current_training_round')} error={err}",
            )

            # Round 1 broadcasts whatever the orchestrator pulled off its first
            # client, so the mocks should see the real model byte for byte.
            r1 = [t.seen_fit_parameters[0] for t in mocks.values() if t.seen_fit_parameters]
            check(
                "both mock sites received the real model unchanged in round 1",
                len(r1) == len(specs)
                and all(
                    structure(p) == structure(reference)
                    and all(np.array_equal(x, y) for x, y in zip(p, reference))
                    for p in r1
                ),
                f"({len(r1)}/{len(specs)} sites reported a round 1 fit)",
            )

            got = next(
                (t.seen_fit_parameters[1] for t in mocks.values() if len(t.seen_fit_parameters) > 1),
                None,
            )
            # Aggregation must not reorder, reshape or retype a single tensor
            # of a 24-tensor state dict on its way through FedAvg.
            check(
                "the aggregate has the same 24 tensors, shapes and dtypes as the model",
                got is not None and structure(got) == structure(reference),
                "" if got is not None else "(no round 2 broadcast recorded)",
            )

            per_client = history.get("client_training_losses") or {}
            real_key = next((r for r in registered if r.endswith(args.trainer)), None)

            if got is not None and structure(got) == structure(reference):
                # The real site's declared sample count is one batch limit's
                # worth of its dataset, which is what the trainer reports as
                # num_examples for a limited fit.
                n_r = int(props.get("train_samples") or 0)
                if LIMIT_TRAIN_BATCHES:
                    n_r = min(n_r, LIMIT_TRAIN_BATCHES * int(props.get("max_batch_size") or 8))
                share = n_r / (n_r + MOCK_EXAMPLES * len(specs))

                # alpha = <G - M, P - M> / <P - M, P - M> over every element of
                # all 24 tensors. See the module docstring: this is the real
                # site's weight in the aggregate, read back off the aggregate.
                num = den = 0.0
                for g, m, p in zip(got, halved, reference):
                    dg = g.astype(np.float64) - m.astype(np.float64)
                    dp = p.astype(np.float64) - m.astype(np.float64)
                    num += float((dg * dp).sum())
                    den += float((dp * dp).sum())
                alpha = num / den if den else float("nan")

                check(
                    "the real site enters the aggregate at its sample-weighted share",
                    abs(alpha - share) < 0.5 * share,
                    f"(measured weight {alpha:.4f} against a declared {share:.4f}; "
                    f"0 would mean dropped, {1/3:.3f} an unweighted mean, 1 the mocks ignored)",
                )

                # Inverting the identity for the one unknown. Recovered weights
                # that still look like a slightly trained transformer are only
                # possible if the weighting was applied as declared.
                recovered = [
                    m.astype(np.float64) + (g.astype(np.float64) - m.astype(np.float64)) / share
                    for g, m in zip(got, halved)
                ]
                worst = max(float(np.abs(r).max()) for r in recovered)
                ref_worst = max(float(np.abs(a).max()) for a in reference)
                drift = max(
                    float(np.abs(r - p.astype(np.float64)).max())
                    for r, p in zip(recovered, reference)
                )
                check(
                    "inverting FedAvg for the real site recovers plausible weights",
                    np.isfinite(worst) and worst < max(50.0, ref_worst * 5),
                    f"(recovered max |w| {worst:.2f} against {ref_worst:.2f} before training, "
                    f"assuming n_r={n_r} of {n_r + MOCK_EXAMPLES * len(specs)})",
                )
                check(
                    "the recovered weights are the starting model moved a little, not reproduced",
                    np.isfinite(drift) and 0.0 < drift < ref_worst,
                    f"(largest recovered weight change {drift:.4f})",
                )

            check(
                "every site appears in the per-site fit history",
                len(per_client) == len(specs) + 1 and real_key in per_client,
                f"({len(per_client)} sites, real site present: {real_key in per_client})",
            )

            # The barrier is the claim that no site starts round 2 before the
            # slowest finishes round 1, and the real site is by far the slowest.
            starts = [t.fit_started_at[1] for t in mocks.values() if len(t.fit_started_at) > 1]
            finishes = [t.fit_finished_at[0] for t in mocks.values() if t.fit_finished_at]
            if starts and finishes:
                check(
                    "round 2 started only after round 1 was aggregated",
                    min(starts) > max(finishes),
                    f"(gap {min(starts) - max(finishes):.1f}s)",
                )

            await orch.reset_training_state()
    finally:
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
