"""In-process test that the orchestrator keeps its event loop free.

BioEngine gives a Ray Serve replica's health check 3 s to get an answer out of
the entry deployment, and three consecutive misses stop the replica. The
orchestrator's per-round work is exactly the kind that blows that budget:
aggregating a round, converting parameters to and from protobuf, and
serialising a checkpoint each run for seconds at a time on a real model. Run
on the event loop, they starve the health check and get the orchestrator
restarted in the middle of the training it is running. So they go to a worker
thread via ``_offload``.

  O1. The loop stays responsive while offloaded work runs. A poller ticking
      alongside a one-second blocking call keeps its cadence, which is the
      property the health check actually depends on.
  O2. Return values come back and exceptions propagate, so callers can keep
      treating these as ordinary calls.
  O3. Keyword arguments survive the hop.
  O4. No blocking call is left sitting directly inside a coroutine. Checked
      against the shipped source so a later edit cannot quietly reintroduce
      one.

Runs in seconds — no Hypha connection, no Ray, no model.
"""

import ast
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from test_rtc_reconnect_unit import mod, orchestrator_py  # noqa: E402

# Calls that must never run on the event loop, as (owner, attribute) where a
# bare function has no owner. numpy and torch release the GIL inside these, so
# a worker thread is enough to keep the loop scheduled.
_BLOCKING_CALLS = {
    (None, "parameters_to_ndarrays"),
    (None, "ndarrays_to_parameters"),
    (None, "aggregate_fit"),
    ("torch", "save"),
    ("np", "savez"),
    ("np", "load"),
}


async def test_loop_stays_responsive_during_offload():
    # time.sleep releases the GIL, which is what numpy's and torch's own loops
    # do. A call that held the GIL outright would need a subprocess, not a
    # thread, and that is a deliberately different design.
    gaps = []

    async def poll():
        last = time.monotonic()
        while True:
            await asyncio.sleep(0.02)
            now = time.monotonic()
            gaps.append(now - last)
            last = now

    poller = asyncio.create_task(poll())
    await mod._offload(time.sleep, 1.0)
    poller.cancel()

    assert len(gaps) > 30, f"poller only ticked {len(gaps)} times"
    # Generous: the point is "tens of ms", not "seconds". A regression that
    # put the work back on the loop would show a single ~1 s gap here.
    assert max(gaps) < 0.3, f"loop stalled for {max(gaps):.3f}s"
    print(f"  ✓ loop kept ticking ({len(gaps)} times, worst gap {max(gaps)*1000:.0f}ms)")


async def test_offload_returns_and_propagates():
    assert await mod._offload(sum, [1, 2, 3]) == 6

    def boom():
        raise ValueError("key count does not match parameter count")

    try:
        await mod._offload(boom)
    except ValueError as e:
        assert "key count" in str(e)
    else:
        raise AssertionError("exception did not propagate")
    print("  ✓ return values come back, exceptions propagate")


async def test_offload_forwards_kwargs():
    def f(a, b=0, c=0):
        return a + b + c

    assert await mod._offload(f, 1, b=2, c=3) == 6
    print("  ✓ keyword arguments survive the hop")


async def test_no_blocking_call_inside_a_coroutine():
    tree = ast.parse(orchestrator_py.read_text(), str(orchestrator_py))

    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        for inner in ast.walk(node):
            # Don't attribute a nested coroutine's calls to its parent.
            if inner is not node and isinstance(inner, ast.AsyncFunctionDef):
                continue
            if not isinstance(inner, ast.Call):
                continue
            fn = inner.func
            if isinstance(fn, ast.Name):
                key = (None, fn.id)
            elif isinstance(fn, ast.Attribute):
                owner = fn.value.id if isinstance(fn.value, ast.Name) else None
                key = (owner, fn.attr)
                if key not in _BLOCKING_CALLS:
                    key = (None, fn.attr)
            else:
                continue
            if key in _BLOCKING_CALLS:
                offenders.append(f"{node.name} line {inner.lineno}: {key[1]}")

    assert not offenders, "blocking calls left on the event loop:\n  " + "\n  ".join(
        offenders
    )
    print("  ✓ no blocking call sits directly inside a coroutine")


async def main():
    print("Orchestrator event-loop offload unit tests")
    print()
    for t in [
        test_loop_stays_responsive_during_offload,
        test_offload_returns_and_propagates,
        test_offload_forwards_kwargs,
        test_no_blocking_call_inside_a_coroutine,
    ]:
        print(f"── {t.__name__}")
        await t()
    print()
    print("╭─────────────────────────────────────────────╮")
    print("│  ✅ event-loop offload tests PASS           │")
    print("╰─────────────────────────────────────────────╯")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or 0)
