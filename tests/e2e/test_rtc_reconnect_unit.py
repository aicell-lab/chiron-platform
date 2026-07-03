"""In-process test for FlowerClientProxy._call_rtc reconnect + WS fallback.

The real RTC transport smoke test (test_rtc_transport.py) proves the
happy path. This one focuses on the failure modes:

  1. Transient RTC failure → _open_rtc raises once → _call_rtc retries →
     second attempt succeeds → returned value flows through untouched.
  2. Persistent RTC failure → _open_rtc raises every time → after
     _RTC_MAX_RETRIES attempts _call_rtc falls back to ws_service and
     returns the WS result.
  3. Between calls the cache is left in a "closed" state, so the next
     call re-opens from scratch (proves we don't get stuck on a
     poisoned handle).

Runs in seconds — no Hypha connection, no Ray, no aiortc. Imports the
FlowerClientProxy class directly from the shipped orchestrator.py.
"""

import asyncio
import sys
import types
from pathlib import Path


# The orchestrator.py imports bioengine / flwr / hypha_rpc at module load
# time. Stub the ones that would require the real BioEngine runtime so
# we can import FlowerClientProxy in a bare Python process.
def _stub_module(name, attrs=None):
    m = types.ModuleType(name)
    for k, v in (attrs or {}).items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


class _FakeLogger:
    def __init__(self): self.records = []
    def _record(self, level, msg): self.records.append((level, msg))
    def info(self, msg): self._record("info", msg)
    def debug(self, msg): self._record("debug", msg)
    def warning(self, msg): self._record("warning", msg)
    def error(self, msg): self._record("error", msg)


def _passthrough(*dargs, **dkwargs):
    """Universal decorator stub.

    Two shapes are used by @bioengine.app in orchestrator.py:
      @bioengine.method                 → wraps a function
      @bioengine.app(num_cpus=1, ...)   → returns a wrapper that wraps a class
    Handle both: if called with a single positional callable, return it
    unwrapped; otherwise return a wrapper that returns its argument.
    """
    if len(dargs) == 1 and callable(dargs[0]) and not dkwargs:
        return dargs[0]

    def wrapper(fn):
        return fn
    return wrapper


_stub_module("bioengine", {
    "logger": _FakeLogger(),
    "MissingDataServerError": type("MDS", (Exception,), {}),
    "app": _passthrough,
    "method": _passthrough,
    "async_init": _passthrough,
    "health_check": _passthrough,
})
_stub_module("bioengine.datasets", {"ping_data_server": lambda: None})

# Minimal flwr stubs — FlowerClientProxy inherits from fl.client.NumPyClient
# which we just need as an object.
class _NumPyClient:
    pass


_stub_module("flwr", {})
_stub_module("flwr.client", {"NumPyClient": _NumPyClient})
_stub_module("flwr.common", {
    "Code": None, "EvaluateIns": None, "EvaluateRes": None,
    "FitIns": None, "FitRes": None, "Parameters": None, "Status": None,
    "ndarrays_to_parameters": lambda x: x, "parameters_to_ndarrays": lambda x: x,
})
_stub_module("flwr.common.typing", {"Scalar": float})
_stub_module("flwr.server.client_manager", {"SimpleClientManager": object})
_stub_module("flwr.server.history", {"History": object})
_stub_module("flwr.server.strategy", {"FedAvg": object})
_stub_module("hypha_rpc", {
    "connect_to_server": None,
    "get_rtc_service": None,  # we monkey-patch on the FlowerClientProxy attribute directly
})
_stub_module("hypha_rpc.rpc", {"RemoteService": object})
_stub_module("hypha_rpc.utils", {"ObjectProxy": object})
_stub_module("pydantic", {"Field": lambda *a, **k: None})
# `flwr.client` was already stubbed above but the orchestrator does
# `import flwr as fl` and uses `fl.client.NumPyClient`, which needs the
# submodule attribute set on the top-level module too.
sys.modules["flwr"].client = sys.modules["flwr.client"]
sys.modules["flwr"].server = types.ModuleType("flwr.server")
sys.modules["flwr"].server.client_manager = sys.modules["flwr.server.client_manager"]
sys.modules["flwr"].server.history = sys.modules["flwr.server.history"]
sys.modules["flwr"].server.strategy = sys.modules["flwr.server.strategy"]

# Load orchestrator.py as a module.
orchestrator_py = Path("/data/nmechtel/tabula/apps/chiron_orchestrator/orchestrator.py")
mod = types.ModuleType("chiron_orchestrator_test")
mod.__file__ = str(orchestrator_py)
exec(compile(orchestrator_py.read_text(), str(orchestrator_py), "exec"), mod.__dict__)
FlowerClientProxy = mod.FlowerClientProxy


# ── Fakes ──────────────────────────────────────────────────────────────────

class FakeWSService:
    """Stand-in for the WebSocket service handle."""
    id = "chiron-platform/fake-worker-XYZ:tabula-trainer"

    def __init__(self):
        self.calls = []

    async def get_properties(self):
        self.calls.append(("get_properties",))
        return {"artifact_id": "chiron-platform/tabula-trainer"}

    async def start_fit(self, **kwargs):
        self.calls.append(("start_fit", kwargs))
        return "ws-start-fit-ok"

    async def get_fit_status(self):
        self.calls.append(("get_fit_status",))
        return {
            "status": "COMPLETED",
            "message": "",
            "current_batch": 10,
            "total_batches": 10,
            "progress": 1.0,
            "result": ([b"WEIGHT_BYTES_WS"], 100, {"loss": 1.11}),
        }


class FakeRTCService:
    """Stand-in for the peer-connected RTC service proxy — same schema."""
    def __init__(self, tag: str = "rtc"):
        self.tag = tag
        self.calls = []

    async def start_fit(self, **kwargs):
        self.calls.append(("start_fit", kwargs))
        return f"{self.tag}-start-fit-ok"

    async def get_fit_status(self):
        self.calls.append(("get_fit_status",))
        return {
            "status": "COMPLETED",
            "message": "",
            "current_batch": 10,
            "total_batches": 10,
            "progress": 1.0,
            "result": ([b"WEIGHT_BYTES_RTC"], 200, {"loss": 2.22}),
        }


# ── The tests ─────────────────────────────────────────────────────────────

async def test_happy_path_uses_rtc():
    """Basic invariant: when RTC is available, weight transfers go through it,
    the WS handle is not called for start_fit / get_fit_status."""
    ws = FakeWSService()
    rtc = FakeRTCService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
    )
    # Bypass real WebRTC establishment — return a fake service directly.
    async def fake_open():
        return rtc
    proxy._open_rtc = fake_open

    got = await proxy._call_rtc("start_fit", parameters=[b"weights"], server_round=1)
    assert got == "rtc-start-fit-ok", got
    assert ("start_fit", {"parameters": [b"weights"], "server_round": 1}) in rtc.calls
    assert not ws.calls, f"WS handle should not have been touched, got: {ws.calls}"
    print("  ✓ happy path routes through RTC, leaves WS untouched")


async def test_transient_rtc_failure_recovers():
    """First _open_rtc raises; second attempt succeeds; call returns the RTC
    result. Proves the reconnect wiring end-to-end."""
    ws = FakeWSService()
    rtc = FakeRTCService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
    )
    calls = {"n": 0}
    async def flaky_open():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated ICE hiccup")
        return rtc
    proxy._open_rtc = flaky_open

    got = await proxy._call_rtc("start_fit", parameters=[b"weights"], server_round=1)
    assert got == "rtc-start-fit-ok", got
    assert calls["n"] == 2, f"expected retry, got n={calls['n']}"
    assert not ws.calls, f"WS should NOT have been called on a recoverable RTC drop, got: {ws.calls}"
    print("  ✓ transient RTC failure recovers on retry (no WS fallback needed)")


async def test_persistent_rtc_failure_falls_back_to_ws():
    """Every _open_rtc attempt raises; after retries exhaust, the WS handle is
    called and its result flows through — training loop keeps moving."""
    ws = FakeWSService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
    )
    calls = {"n": 0}
    async def always_broken_open():
        calls["n"] += 1
        raise RuntimeError(f"simulated fatal (attempt {calls['n']})")
    proxy._open_rtc = always_broken_open

    got = await proxy._call_rtc("start_fit", parameters=[b"weights"], server_round=1)
    assert got == "ws-start-fit-ok", got
    assert calls["n"] == mod._RTC_MAX_RETRIES, (
        f"expected {mod._RTC_MAX_RETRIES} RTC attempts before fallback, got {calls['n']}"
    )
    assert ("start_fit", {"parameters": [b"weights"], "server_round": 1}) in ws.calls, (
        f"WS fallback should have received the same call, ws.calls={ws.calls}"
    )
    print(f"  ✓ persistent RTC failure falls back to WS after {mod._RTC_MAX_RETRIES} attempts")


async def test_next_call_after_fallback_retries_rtc_fresh():
    """After the cooldown expires, the proxy re-attempts RTC on the next call.
    Zero the cooldown here to prove the retry path — the cooldown itself is
    covered by test_cooldown_skips_rtc_within_window."""
    ws = FakeWSService()
    rtc = FakeRTCService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
    )
    calls = {"n": 0}
    async def flaky_then_ok():
        calls["n"] += 1
        # First call's retries all fail; second call's first attempt succeeds.
        if calls["n"] <= mod._RTC_MAX_RETRIES:
            raise RuntimeError(f"broken (attempt {calls['n']})")
        return rtc
    proxy._open_rtc = flaky_then_ok

    # Call 1 falls back to WS + arms the cooldown.
    r1 = await proxy._call_rtc("start_fit", parameters=[b"a"], server_round=1)
    assert r1 == "ws-start-fit-ok"
    assert len(ws.calls) == 1
    assert proxy._rtc_cooldown_until > 0, "cooldown should be armed after fallback"

    # Simulate the cooldown having expired.
    proxy._rtc_cooldown_until = 0

    # Call 2 should attempt RTC afresh, and succeed.
    r2 = await proxy._call_rtc("get_fit_status")
    assert r2["status"] == "COMPLETED"
    assert r2["result"][0] == [b"WEIGHT_BYTES_RTC"], (
        f"expected RTC result on the recovered call, got {r2['result']}"
    )
    assert len(ws.calls) == 1, f"WS should NOT have been touched on the recovered call: {ws.calls}"
    # A successful RTC call must clear the cooldown so subsequent calls also
    # go via RTC at full cadence.
    assert proxy._rtc_cooldown_until == 0.0, (
        "cooldown should have been cleared on RTC success"
    )
    print("  ✓ post-fallback state is clean: next call retries RTC and succeeds")


async def test_cooldown_skips_rtc_within_window():
    """After a WS fallback, subsequent calls made within the cooldown window
    must bypass RTC entirely — this is the perf-critical optimisation that
    keeps a broken-TURN session from paying the ICE-timeout tax per call."""
    ws = FakeWSService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
    )
    open_calls = {"n": 0}
    async def always_broken_open():
        open_calls["n"] += 1
        raise RuntimeError("simulated TURN gap")
    proxy._open_rtc = always_broken_open

    # First call: RTC attempted _RTC_MAX_RETRIES times, then falls back.
    await proxy._call_rtc("start_fit", parameters=[b"a"], server_round=1)
    assert open_calls["n"] == mod._RTC_MAX_RETRIES
    assert proxy._rtc_cooldown_until > 0

    # Second call, still inside the cooldown window: MUST NOT attempt RTC.
    await proxy._call_rtc("get_fit_status")
    assert open_calls["n"] == mod._RTC_MAX_RETRIES, (
        f"cooldown should have suppressed RTC attempts, but _open_rtc was called "
        f"{open_calls['n']} times (expected {mod._RTC_MAX_RETRIES})"
    )
    # Both calls should have landed on WS.
    assert len(ws.calls) == 2, f"expected 2 WS calls (both routed via cooldown), got {ws.calls}"

    print(f"  ✓ cooldown ({mod._RTC_COOLDOWN_SECONDS:.0f}s) skips RTC on the next call")


# ── Runner ────────────────────────────────────────────────────────────────

async def main():
    print("FlowerClientProxy._call_rtc reconnect + fallback unit tests")
    print()
    for t in [
        test_happy_path_uses_rtc,
        test_transient_rtc_failure_recovers,
        test_persistent_rtc_failure_falls_back_to_ws,
        test_next_call_after_fallback_retries_rtc_fresh,
        test_cooldown_skips_rtc_within_window,
    ]:
        print(f"── {t.__name__}")
        await t()
    print()
    print("╭──────────────────────────────────────────────╮")
    print("│  ✅ RTC reconnect + fallback unit tests PASS │")
    print("╰──────────────────────────────────────────────╯")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or 0)
