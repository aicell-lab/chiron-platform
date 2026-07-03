"""In-process test for FlowerClientProxy transport dispatch + RTC semantics.

The real transport smoke test (test_rtc_transport.py) proves the happy
path against live workers. This one focuses on the routing + failure
modes in isolation:

  WebSocket transport (default while KTH's coturn access is blocked):
    W1. Happy path — weights ride ws_service. _open_rtc is NEVER called,
        so a broken RTC path can't affect a websocket run.
    W2. Method-name dispatch — start_fit, get_fit_status, start_evaluate,
        get_evaluate_status, get_parameters all resolve to the matching
        ws_service attribute.

  WebRTC transport (privacy-preserving, no gateway):
    R1. Happy path — weights ride RTC, ws_service.<weight-method> is not
        touched.
    R2. Transient failure — _open_rtc raises once, _call_rtc retries,
        second attempt succeeds; ws_service still untouched.
    R3. Persistent failure — every _open_rtc attempt raises → after
        _RTC_MAX_RETRIES tries _call_rtc raises RTCUnavailableError.
        ws_service is NEVER touched (no silent fallback). Flower's
        round collector drops the trainer from THIS round; the next
        round gets a fresh RTC probe.
    R4. Recovery — after a hard-fail, the next _call_rtc probes RTC
        from scratch (no poisoned state, no cooldown). When RTC comes
        back, the call succeeds without any WS involvement.

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
RTCUnavailableError = mod.RTCUnavailableError


# ── Fakes ──────────────────────────────────────────────────────────────────

class FakeWSService:
    """Stand-in for the WebSocket service handle. In the hard-fail contract
    the weight methods must NEVER be called on this — test asserts that."""
    id = "chiron-platform/fake-worker-XYZ:tabula-trainer"

    def __init__(self):
        self.calls = []

    async def get_properties(self):
        self.calls.append(("get_properties",))
        return {"artifact_id": "chiron-platform/tabula-trainer"}

    async def start_fit(self, **kwargs):
        # Any hit on this method is a contract violation — record it so
        # the test can assert on it.
        self.calls.append(("start_fit", kwargs))
        return "ws-start-fit-ok"

    async def get_fit_status(self):
        self.calls.append(("get_fit_status",))
        return {"status": "COMPLETED"}


class FakeRTCService:
    """Stand-in for the peer-connected RTC service proxy."""
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

async def test_websocket_transport_routes_through_ws_service():
    """In 'websocket' mode, weight-transfer methods hit ws_service directly.
    _open_rtc is NEVER called — a completely broken RTC path can't affect
    a websocket run. This is the safe default while the KTH network can't
    reach coturn."""
    ws = FakeWSService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
        transport="websocket",
    )
    async def blown_open():
        raise AssertionError("_open_rtc must not be called in websocket mode")
    proxy._open_rtc = blown_open

    got = await proxy._call_weight("start_fit", parameters=[b"weights"], server_round=1)
    assert got == "ws-start-fit-ok", got
    assert ("start_fit", {"parameters": [b"weights"], "server_round": 1}) in ws.calls
    print("  ✓ websocket routes weights through ws_service, RTC path untouched")


async def test_websocket_transport_dispatches_every_weight_method():
    """Every weight method name resolves to the matching ws_service
    attribute. Guards against a future refactor that would hard-code the
    dispatcher to a subset (start_fit but not get_parameters, etc.)."""
    ws = FakeWSService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
        transport="websocket",
    )
    r_start = await proxy._call_weight("start_fit", parameters=[b"w"], server_round=1)
    r_status = await proxy._call_weight("get_fit_status")
    assert r_start == "ws-start-fit-ok"
    assert r_status["status"] == "COMPLETED"
    hits = [c[0] for c in ws.calls]
    assert hits == ["start_fit", "get_fit_status"], f"unexpected ws hits: {hits}"
    print("  ✓ websocket dispatch resolves each method by name")


async def test_happy_path_uses_rtc():
    """Basic invariant: when RTC is available, weight transfers go through it,
    the WS handle is not called for start_fit / get_fit_status."""
    ws = FakeWSService()
    rtc = FakeRTCService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
        transport="webrtc",
    )
    async def fake_open():
        return rtc
    proxy._open_rtc = fake_open

    got = await proxy._call_weight("start_fit", parameters=[b"weights"], server_round=1)
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
        transport="webrtc",
    )
    calls = {"n": 0}
    async def flaky_open():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated ICE hiccup")
        return rtc
    proxy._open_rtc = flaky_open

    got = await proxy._call_weight("start_fit", parameters=[b"weights"], server_round=1)
    assert got == "rtc-start-fit-ok", got
    assert calls["n"] == 2, f"expected retry, got n={calls['n']}"
    assert not ws.calls, f"WS should NOT have been called on a recoverable RTC drop, got: {ws.calls}"
    print("  ✓ transient RTC failure recovers on retry (WS untouched)")


async def test_persistent_rtc_failure_raises_and_never_uses_ws():
    """The hard-fail contract: every _open_rtc attempt raises → after
    _RTC_MAX_RETRIES tries, _call_rtc raises RTCUnavailableError. The WS
    handle is NEVER touched — weights only ever ride the peer-to-peer
    data channel. Flower's strategy catches the exception at the
    round-collector layer, drops this client from the round, and the FL
    loop keeps moving with the surviving clients."""
    ws = FakeWSService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
        transport="webrtc",
    )
    open_calls = {"n": 0}
    async def always_broken_open():
        open_calls["n"] += 1
        raise RuntimeError(f"simulated fatal (attempt {open_calls['n']})")
    proxy._open_rtc = always_broken_open

    raised = None
    try:
        await proxy._call_weight("start_fit", parameters=[b"weights"], server_round=1)
    except RTCUnavailableError as e:
        raised = e
    assert raised is not None, "expected RTCUnavailableError but the call returned"
    # The original exception should be chained so operators can see the root cause.
    assert isinstance(raised.__cause__, RuntimeError), (
        f"expected the last _open_rtc failure to be chained as __cause__, got: {raised.__cause__!r}"
    )
    assert open_calls["n"] == mod._RTC_MAX_RETRIES, (
        f"expected {mod._RTC_MAX_RETRIES} RTC attempts, got {open_calls['n']}"
    )
    assert not ws.calls, (
        f"WS handle must never be touched for weight transfer — got: {ws.calls}"
    )
    print(
        f"  ✓ persistent RTC failure raises RTCUnavailableError after "
        f"{mod._RTC_MAX_RETRIES} attempts; WS untouched"
    )


async def test_next_call_after_hard_fail_retries_rtc_fresh():
    """After a call raises RTCUnavailableError, the proxy holds no poisoned
    state — the next _call_rtc attempt hits _open_rtc from scratch. When
    RTC is back, the call succeeds without any WS involvement."""
    ws = FakeWSService()
    rtc = FakeRTCService()
    proxy = FlowerClientProxy(
        ws_service=ws, hypha_client=None,
        artifact_id="chiron-platform/tabula-trainer", check_interval=0.001,
        transport="webrtc",
    )
    open_calls = {"n": 0}
    async def flaky_then_ok():
        open_calls["n"] += 1
        # First call's retries all fail; next call's first attempt succeeds.
        if open_calls["n"] <= mod._RTC_MAX_RETRIES:
            raise RuntimeError(f"broken (attempt {open_calls['n']})")
        return rtc
    proxy._open_rtc = flaky_then_ok

    # Call 1 exhausts retries and raises — trainer is dropped from round.
    raised = None
    try:
        await proxy._call_weight("start_fit", parameters=[b"a"], server_round=1)
    except RTCUnavailableError as e:
        raised = e
    assert raised is not None
    assert open_calls["n"] == mod._RTC_MAX_RETRIES
    assert not ws.calls, f"WS must not be touched on the failed round: {ws.calls}"

    # Call 2 (simulating the next round) tries RTC afresh — no cooldown,
    # no skip, no poisoned handle — and succeeds on the first attempt.
    r2 = await proxy._call_weight("get_fit_status")
    assert r2["status"] == "COMPLETED"
    assert r2["result"][0] == [b"WEIGHT_BYTES_RTC"], (
        f"expected RTC result on the recovered call, got {r2['result']}"
    )
    assert open_calls["n"] == mod._RTC_MAX_RETRIES + 1, (
        f"expected exactly one fresh RTC probe on the recovered call, "
        f"total open_calls={open_calls['n']}"
    )
    assert not ws.calls, f"WS must not be touched on the recovered call: {ws.calls}"
    print("  ✓ post-failure state is clean: next call retries RTC fresh and succeeds")


# ── Runner ────────────────────────────────────────────────────────────────

async def main():
    print("FlowerClientProxy transport dispatch + RTC hard-fail unit tests")
    print()
    for t in [
        test_websocket_transport_routes_through_ws_service,
        test_websocket_transport_dispatches_every_weight_method,
        test_happy_path_uses_rtc,
        test_transient_rtc_failure_recovers,
        test_persistent_rtc_failure_raises_and_never_uses_ws,
        test_next_call_after_hard_fail_retries_rtc_fresh,
    ]:
        print(f"── {t.__name__}")
        await t()
    print()
    print("╭─────────────────────────────────────────────╮")
    print("│  ✅ transport dispatch tests PASS           │")
    print("╰─────────────────────────────────────────────╯")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or 0)
