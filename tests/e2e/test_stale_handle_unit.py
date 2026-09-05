"""In-process test for FlowerClientProxy WebSocket stale-handle recovery.

The orchestrator's handle on a trainer can go dead mid-round in two ways. The
proxy replica is restarted, because Ray Serve allows its health check 3 s to
get an answer out of the entry deployment and something blew that budget, and
Hypha drops the service registration. Or the proxy simply loses its Hypha
websocket, which is what a host network flap looks like from here. Either way
the cached handle starts reporting the peer as gone, and either way the entry
deployment where the fit actually runs is untouched and still holds the
result, so the round is recoverable: wait for the proxy to come back and ask
again. The proxy returns under a new client id, so re-resolution has to look
the trainer up by app rather than by the id it was first seen under.

  S1. Transient stale handle — the first call raises "Method expired or not
      found", the proxy re-resolves the handle and the retry succeeds on the
      fresh one. The caller sees a normal return value.
  S2. Re-resolution is deferred — while the replacement replica has not
      registered yet, get_service itself raises. The proxy stays inside its
      recovery window and keeps trying rather than giving up.
  S3. A non-stale error is a real failure — it propagates on the first
      occurrence with no retry and no re-resolution, so a genuinely broken
      trainer still drops out of the round promptly.
  S4. The recovery window is bounded — a handle that never comes back raises
      once the window closes instead of hanging the round forever.
  S5. Concurrent callers share one re-resolution rather than each resolving
      their own handle.
  S6. A dropped Hypha websocket ("Client disconnected") is treated as the same
      recoverable condition. A network flap takes the proxy's connection down
      without touching the entry deployment, so the round survives it.
  S7. Connection loss is matched as a vocabulary, not as fixed phrases, and
      trainer-side errors are still fatal on the first occurrence.
  S8. Re-resolution asks for the client-agnostic id. A reconnected proxy comes
      back under a new client id, so looking the old fully-qualified id up
      again would never find the trainer. The derived RTC id follows the
      client we actually resolved.

Runs in seconds — no Hypha connection, no Ray, no aiortc. Reuses the module
stubs from test_rtc_reconnect_unit so both files load the shipped
orchestrator.py the same way.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from test_rtc_reconnect_unit import FlowerClientProxy, mod  # noqa: E402

_STALE = "RemoteError:Method expired or not found: ws:services.trainer.get_fit_status"


class FakeHandle:
    """One generation of the WebSocket handle.

    ``stale`` handles raise the way Hypha does once the client that registered
    them is gone.
    """

    def __init__(self, tag, stale=False, error=None, client="fake-worker-a1"):
        # Real ids are workspace/client:app, and the client half changes when
        # the proxy reconnects.
        self.id = f"chiron-platform/{client}:trainer"
        self.tag = tag
        self.stale = stale
        self.error = error
        self.calls = []

    async def get_fit_status(self):
        self.calls.append("get_fit_status")
        if self.error is not None:
            raise self.error
        if self.stale:
            raise RuntimeError(_STALE)
        return {"status": "COMPLETED", "handle": self.tag}


class FakeHyphaClient:
    """Hands out handle generations in order, or raises when the replacement
    replica has not registered with Hypha yet."""

    def __init__(self, generations):
        self._generations = list(generations)
        self.get_service_calls = 0
        self.requested_ids = []

    async def get_service(self, service_id):
        self.get_service_calls += 1
        self.requested_ids.append(service_id)
        nxt = self._generations.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def _proxy(handle, client):
    p = FlowerClientProxy.__new__(FlowerClientProxy)
    p.ws_service = handle
    p.cid = handle.id
    p._hypha_client = client
    p.artifact_id = "chiron-platform/scgpt-trainer"
    p.check_interval = 10.0
    p.transport = "websocket"
    p._ws_lookup_id = mod._client_agnostic_service_id(p.cid)
    p._rtc_service_id = f"{p.cid}-rtc"
    p._rtc_pc = None
    p._rtc_service = None
    p._rtc_lock = asyncio.Lock()
    p._ws_lock = asyncio.Lock()
    return p


async def test_transient_stale_handle_recovers():
    dead = FakeHandle("gen0", stale=True)
    fresh = FakeHandle("gen1")
    p = _proxy(dead, FakeHyphaClient([fresh]))

    result = await p._call_ws("get_fit_status")

    assert result["handle"] == "gen1", result
    assert p.ws_service is fresh
    assert dead.calls == ["get_fit_status"], dead.calls
    assert fresh.calls == ["get_fit_status"], fresh.calls
    print("  ✓ stale handle re-resolved, retry lands on the fresh one")


async def test_waits_for_the_replacement_replica():
    dead = FakeHandle("gen0", stale=True)
    fresh = FakeHandle("gen1")
    # First re-resolution attempt fails: no replica has registered yet.
    client = FakeHyphaClient([RuntimeError("Service not found: trainer"), fresh])
    p = _proxy(dead, client)

    result = await p._call_ws("get_fit_status")

    assert result["handle"] == "gen1", result
    assert client.get_service_calls == 2, client.get_service_calls
    print("  ✓ stays in the window while the replacement replica registers")


async def test_dropped_connection_recovers():
    # What a host network flap actually produces: the trainer's proxy loses its
    # Hypha websocket and every call through the cached handle reports the peer
    # as gone.
    dropped = RuntimeError(
        "RemoteError:Client disconnected: chiron-platform/fake-worker-a1"
    )
    dead = FakeHandle("gen0", error=dropped)
    fresh = FakeHandle("gen1", client="fake-worker-b2")
    p = _proxy(dead, FakeHyphaClient([fresh]))

    result = await p._call_ws("get_fit_status")

    assert result["handle"] == "gen1", result
    print("  ✓ a dropped Hypha connection is recovered, not fatal")


async def test_reresolves_without_pinning_the_client():
    dead = FakeHandle("gen0", stale=True, client="fake-worker-a1")
    # The replacement registers under a different client id.
    fresh = FakeHandle("gen1", client="fake-worker-b2")
    client = FakeHyphaClient([fresh])
    p = _proxy(dead, client)

    await p._call_ws("get_fit_status")

    assert client.requested_ids == ["chiron-platform/*:trainer"], client.requested_ids
    assert p._rtc_service_id == "chiron-platform/fake-worker-b2:trainer-rtc", (
        p._rtc_service_id
    )
    print("  ✓ re-resolves by app, and the RTC id follows the new client")


async def test_real_failure_propagates_immediately():
    boom = ValueError("dataset column 'cell_type' is missing")
    broken = FakeHandle("gen0", error=boom)
    client = FakeHyphaClient([])
    p = _proxy(broken, client)

    try:
        await p._call_ws("get_fit_status")
    except ValueError as e:
        assert e is boom
    else:
        raise AssertionError("a non-stale error must not be retried")

    assert client.get_service_calls == 0, "no handle re-resolution for a real failure"
    assert broken.calls == ["get_fit_status"], broken.calls
    print("  ✓ a real trainer error propagates on the first attempt")


async def test_recovery_window_is_bounded():
    # Shrink the window so the test does not sit for three minutes.
    window = mod._STALE_HANDLE_RECOVERY_SECONDS
    backoff = mod._STALE_HANDLE_RETRY_BACKOFF_SECONDS
    mod._STALE_HANDLE_RECOVERY_SECONDS = 0.3
    mod._STALE_HANDLE_RETRY_BACKOFF_SECONDS = 0.1
    try:
        never = [FakeHandle(f"gen{i}", stale=True) for i in range(1, 20)]
        p = _proxy(FakeHandle("gen0", stale=True), FakeHyphaClient(never))
        try:
            await p._call_ws("get_fit_status")
        except RuntimeError as e:
            assert "Method expired or not found" in str(e), e
        else:
            raise AssertionError("the window must close on a handle that never returns")
    finally:
        mod._STALE_HANDLE_RECOVERY_SECONDS = window
        mod._STALE_HANDLE_RETRY_BACKOFF_SECONDS = backoff
    print("  ✓ recovery window closes instead of hanging the round")


async def test_concurrent_callers_share_one_reresolution():
    dead = FakeHandle("gen0", stale=True)
    fresh = FakeHandle("gen1")
    client = FakeHyphaClient([fresh])
    p = _proxy(dead, client)

    results = await asyncio.gather(
        p._call_ws("get_fit_status"),
        p._call_ws("get_fit_status"),
    )

    assert [r["handle"] for r in results] == ["gen1", "gen1"], results
    assert client.get_service_calls == 1, client.get_service_calls
    print("  ✓ two concurrent callers share a single re-resolution")


async def test_connection_loss_vocabulary_is_classified():
    """The classifier is matched against messages Hypha actually produced.

    Both strings below came from the same cause (a host network flap) minutes
    apart in one run, worded differently, and the second wording defeated an
    earlier exact-phrase list and killed a healthy round. They are pinned here
    so a future narrowing of the pattern fails loudly.
    """
    recoverable = [
        "RemoteError:Target peer chiron-platform/i5uXb-59748b8a is not connected",
        "Client disconnected: chiron-platform/i5uXb-59748b8a",
        "RemoteError:Method expired or not found: ws:services.trainer.get_fit_status",
        "Service not found: chiron-platform/*:orange-cake-2261",
        "Connection is closed",
        "The connection has already been closed",
    ]
    # Trainer-side failures must still end the round on the first occurrence.
    fatal = [
        "dataset column 'cell_type' is missing",
        "CUDA out of memory. Tried to allocate 2.00 GiB",
        "KeyError: 'gene_ids'",
        "ValueError: model_family mismatch: image is scgpt, artifact says tabula",
    ]

    for message in recoverable:
        assert mod._is_stale_handle(RuntimeError(message)), message
    for message in fatal:
        assert not mod._is_stale_handle(RuntimeError(message)), message
    print("  ✓ connection-loss wording recovers, trainer errors stay fatal")


async def main():
    print("FlowerClientProxy WebSocket stale-handle recovery unit tests")
    print()
    for t in [
        test_transient_stale_handle_recovers,
        test_waits_for_the_replacement_replica,
        test_dropped_connection_recovers,
        test_connection_loss_vocabulary_is_classified,
        test_reresolves_without_pinning_the_client,
        test_real_failure_propagates_immediately,
        test_recovery_window_is_bounded,
        test_concurrent_callers_share_one_reresolution,
    ]:
        print(f"── {t.__name__}")
        await t()
    print()
    print("╭─────────────────────────────────────────────╮")
    print("│  ✅ stale-handle recovery tests PASS        │")
    print("╰─────────────────────────────────────────────╯")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or 0)
