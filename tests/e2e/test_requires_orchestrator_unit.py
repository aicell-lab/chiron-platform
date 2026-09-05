"""In-process test for the trainer's @requires_orchestrator authorisation guard.

The guard is the only thing standing between an arbitrary Hypha caller and
a site's private training data, and it is invisible in review when it
misbehaves: a wrong read of the incoming arguments either rejects every
legitimate round (loud) or waves every caller through (silent).

The subtlety it has to survive is that nothing reaches a BioEngine app
method the way the caller wrote it. ``@bioengine.method`` wraps every
method with ``hypha_rpc.utils.schema.schema_method``, whose wrapper runs
``fill_missing_args_and_kwargs`` first and hands the real function
positional arguments regardless of how the orchestrator called it. So the
tests below drive the guard through that same wrapper rather than calling
it directly.

  G1. Keyword call through schema_method — the orchestrator's own shape
      (``start_fit(parameters=..., orchestrator_service_id=...)``).
  G2. Positional call through schema_method — the same call after
      normalisation, and the shape a WebRTC proxy can produce.
  G3. Missing orchestrator_service_id is rejected.
  G4. Empty orchestrator_service_id is rejected. A Field default of ""
      must not read as "authorised".
  G5. A caller that is not the registered orchestrator gets
      PermissionError, and the wrapped body never runs.
  G6. session_id reaches _set_session, and a non-string one degrades to ""
      instead of propagating into the checkpoint directory name.
  G7. The published schema is unchanged by the decorator: every declared
      parameter still appears, so the Chiron UI and the orchestrator's
      _read_schema see the same surface as an undecorated method.

Runs in seconds. No Hypha connection, no Ray, no torch.
"""

import asyncio
import sys
import types
from pathlib import Path

import numpy as np
from hypha_rpc.utils.schema import schema_method
from pydantic import Field


# ── Stubs ─────────────────────────────────────────────────────────────────
#
# chiron_trainer_base/trainer.py imports the full BioEngine + torch runtime
# at module load. Stub the parts a bare Python process cannot provide; the
# decorator under test touches none of them.

def _stub_module(name, attrs=None):
    m = types.ModuleType(name)
    for k, v in (attrs or {}).items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


class _FakeLogger:
    def info(self, msg): pass
    def debug(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass


def _passthrough(*dargs, **dkwargs):
    if len(dargs) == 1 and callable(dargs[0]) and not dkwargs:
        return dargs[0]

    def wrapper(fn):
        return fn
    return wrapper


if "torch" not in sys.modules:
    try:
        import torch  # noqa: F401
    except ImportError:
        _stub_module("torch", {
            "Tensor": type("Tensor", (), {}),
            "device": lambda *a, **k: None,
            "no_grad": _passthrough,
            "load": lambda *a, **k: {},
            "save": lambda *a, **k: None,
            "from_numpy": lambda x: x,
        })
        _stub_module("torch.nn", {"Module": object})
        _stub_module("torch.utils", {})
        _stub_module("torch.utils.data", {
            "DataLoader": object, "Dataset": object, "Subset": object,
        })
        sys.modules["torch"].nn = sys.modules["torch.nn"]
        sys.modules["torch"].utils = sys.modules["torch.utils"]
        sys.modules["torch"].utils.data = sys.modules["torch.utils.data"]

try:
    import pytorch_lightning  # noqa: F401
except ImportError:
    _stub_module("pytorch_lightning", {
        "LightningModule": object,
        "Trainer": object,
        "Callback": object,
        "LightningDataModule": object,
    })
    _stub_module("pytorch_lightning.callbacks", {"Callback": object})
    _stub_module("pytorch_lightning.utilities", {})
    sys.modules["pytorch_lightning"].callbacks = sys.modules["pytorch_lightning.callbacks"]

_stub_module("bioengine", {
    "logger": _FakeLogger(),
    "MissingDataServerError": type("MDS", (Exception,), {}),
    "app": _passthrough,
    "method": _passthrough,
    "async_init": _passthrough,
    "smoke_test": _passthrough,
    "health_check": _passthrough,
})
_stub_module("bioengine.datasets", {"ping_data_server": lambda: None})

# Import the scaffold as a package. trainer.py uses relative imports, so it
# cannot be exec'd standalone the way orchestrator.py can.
sys.path.insert(0, "/data/nmechtel/tabula/apps")
from _chiron_trainer_base import trainer as mod  # noqa: E402

requires_orchestrator = mod.requires_orchestrator


# ── A trainer of the same shape as TabulaTrainer.start_fit ───────────────

REGISTERED = "chiron-platform/worker-XYZ-de681410:orchestrator-app"


class FakeTrainer:
    """The slice of BaseChironTrainer the guard touches."""

    def __init__(self, registered=REGISTERED):
        self._registered_orchestrator_id = registered
        self._ping_fail_count = 7
        self.sessions = []
        self.body_calls = []

    _validate_orchestrator = mod.BaseChironTrainer._validate_orchestrator

    def _set_session(self, session_id, orchestrator_service_id):
        self.sessions.append((session_id, orchestrator_service_id))

    @schema_method
    @requires_orchestrator
    async def start_fit(
        self,
        parameters: list = Field(..., description="Model weights"),
        batch_size: int = Field(32, description="Batch size"),
        server_round: int = Field(1, description="INTERNAL: server round"),
        orchestrator_service_id: str = Field(
            ..., description="INTERNAL: Service ID of the calling orchestrator."
        ),
        session_id: str = Field("", description="INTERNAL: Session token."),
    ) -> dict:
        """Start fitting the model to the training data."""
        self.body_calls.append({
            "parameters": parameters,
            "batch_size": batch_size,
            "server_round": server_round,
            "orchestrator_service_id": orchestrator_service_id,
            "session_id": session_id,
        })
        return {"started": True}


WEIGHTS = [np.zeros(3, dtype=np.float32)]


# ── The tests ─────────────────────────────────────────────────────────────

async def test_keyword_call_is_authorised():
    """The orchestrator's own call shape.

    FlowerClientProxy.fit does start_fit(parameters=..., server_round=...,
    **config), where config carries orchestrator_service_id and session_id.
    """
    t = FakeTrainer()
    result = await t.start_fit(
        parameters=WEIGHTS,
        batch_size=64,
        server_round=3,
        orchestrator_service_id=REGISTERED,
        session_id="abc123",
    )
    assert result == {"started": True}
    assert len(t.body_calls) == 1, "the wrapped body must run exactly once"
    assert t.body_calls[0]["orchestrator_service_id"] == REGISTERED
    assert t.body_calls[0]["batch_size"] == 64
    assert t.body_calls[0]["server_round"] == 3
    assert t._ping_fail_count == 0, "a live orchestrator call resets the ping counter"
    print("  ✓ keyword call through schema_method is authorised and reaches the body")


async def test_positional_call_is_authorised():
    """The same call after hypha-rpc normalisation.

    fill_missing_args_and_kwargs turns declared keyword parameters into
    positional arguments before the real function is invoked, so the guard
    has to bind rather than read kwargs. This is the exact regression that
    made every round fail with "must be called with a keyword
    'orchestrator_service_id' argument".
    """
    t = FakeTrainer()
    result = await t.start_fit(WEIGHTS, 64, 3, REGISTERED, "abc123")
    assert result == {"started": True}
    assert len(t.body_calls) == 1
    assert t.body_calls[0]["orchestrator_service_id"] == REGISTERED
    assert t.sessions == [("abc123", REGISTERED)]
    print("  ✓ fully positional call is authorised and reaches the body")


async def test_missing_orchestrator_id_is_rejected():
    t = FakeTrainer()
    try:
        await t.start_fit(parameters=WEIGHTS, batch_size=32)
    except RuntimeError as e:
        assert "orchestrator_service_id" in str(e), f"unhelpful message: {e}"
    else:
        raise AssertionError("a call without orchestrator_service_id must be rejected")
    assert not t.body_calls, "the body must not run for an unauthorised call"
    print("  ✓ missing orchestrator_service_id is rejected before the body")


async def test_empty_orchestrator_id_is_rejected():
    """An empty string is not an identity. Field defaults are "" in several
    places in this signature, so "" must never read as authorised."""
    t = FakeTrainer()
    try:
        await t.start_fit(
            parameters=WEIGHTS, orchestrator_service_id="", session_id="abc123"
        )
    except RuntimeError as e:
        assert "orchestrator_service_id" in str(e), f"unhelpful message: {e}"
    else:
        raise AssertionError("an empty orchestrator_service_id must be rejected")
    assert not t.body_calls
    print("  ✓ empty orchestrator_service_id is rejected before the body")


async def test_wrong_orchestrator_is_rejected():
    t = FakeTrainer()
    try:
        await t.start_fit(
            parameters=WEIGHTS,
            orchestrator_service_id="chiron-platform/someone-else:orchestrator",
        )
    except PermissionError as e:
        assert REGISTERED in str(e), f"message should name the registered id: {e}"
    else:
        raise AssertionError("a stranger must get PermissionError")
    assert not t.body_calls, "the body must not run for a stranger"
    assert not t.sessions, "a stranger must not activate a session directory"
    print("  ✓ an unregistered caller gets PermissionError and the body never runs")


async def test_unregistered_trainer_is_rejected():
    t = FakeTrainer(registered=None)
    try:
        await t.start_fit(parameters=WEIGHTS, orchestrator_service_id=REGISTERED)
    except RuntimeError as e:
        assert "not registered" in str(e), f"unhelpful message: {e}"
    else:
        raise AssertionError("a trainer registered to nobody must reject training calls")
    assert not t.body_calls
    print("  ✓ a trainer registered to no orchestrator rejects training calls")


async def test_session_id_degrades_to_empty_string():
    """session_id names the checkpoint directory. A non-string (a leaked
    FieldInfo, a None from an older orchestrator) must become "" rather than
    reach _set_session and land in a path."""
    t = FakeTrainer()
    await t.start_fit(
        parameters=WEIGHTS, orchestrator_service_id=REGISTERED, session_id=None
    )
    assert t.sessions == [("", REGISTERED)], f"got {t.sessions}"
    print("  ✓ a non-string session_id degrades to \"\"")


async def test_published_schema_is_unchanged():
    """functools.wraps sets __wrapped__, so inspect.signature follows through
    the guard and schema_method publishes the real parameters. The Chiron UI
    and orchestrator._read_schema both parse this."""
    schema = FakeTrainer.start_fit.__schema__
    properties = schema["parameters"]["properties"]
    expected = {
        "parameters", "batch_size", "server_round",
        "orchestrator_service_id", "session_id",
    }
    assert set(properties) == expected, (
        f"the guard changed the published schema: {sorted(properties)}"
    )
    assert schema["name"] == "start_fit"
    assert "Start fitting" in (schema["description"] or ""), (
        f"the docstring did not survive: {schema['description']!r}"
    )
    assert "INTERNAL:" in properties["orchestrator_service_id"]["description"], (
        "the INTERNAL: prefix is a UI contract and must survive the guard"
    )
    print("  ✓ the published schema is identical to an undecorated method's")


# ── Runner ────────────────────────────────────────────────────────────────

async def main():
    print("@requires_orchestrator authorisation guard unit tests")
    print()
    for t in [
        test_keyword_call_is_authorised,
        test_positional_call_is_authorised,
        test_missing_orchestrator_id_is_rejected,
        test_empty_orchestrator_id_is_rejected,
        test_wrong_orchestrator_is_rejected,
        test_unregistered_trainer_is_rejected,
        test_session_id_degrades_to_empty_string,
        test_published_schema_is_unchanged,
    ]:
        print(f"── {t.__name__}")
        await t()
    print()
    print("╭─────────────────────────────────────────────╮")
    print("│  ✅ orchestrator guard tests PASS           │")
    print("╰─────────────────────────────────────────────╯")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or 0)
