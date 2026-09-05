"""Mock Chiron trainers, for exercising the federation at more than one site.

Every federated run this platform has ever recorded had exactly one trainer in
it, and FedAvg over one client returns that client's weights unchanged. So the
aggregation, the round barrier that waits for N clients, the sample-weighted
metric average and the per-trainer config override have never actually done
anything in production. They are the part of the orchestrator a single-site run
cannot reach.

A mock trainer is the cheapest way to reach them, and also the most exact. A
real trainer's weights come out of a stochastic optimiser, so an assertion
against them can only ever be "this looks plausible". A mock returns whatever
weights it is told to, with whatever sample count it is told to report, so the
expected FedAvg output is a number this test can compute independently and
compare elementwise. That is a check no real run can give you.

The mocks register as ordinary Hypha services rather than as BioEngine
deployments. The orchestrator reaches a trainer purely over Hypha RPC, so from
its side there is no difference, and this way N sites cost no GPU and no
container. What they do NOT cover is anything below the RPC boundary: real
weight transport of a real state dict, and the training page's trainer list,
which intersects the orchestrator's registrations with the worker's own
deployment list and so will not show a trainer that no worker deployed. Those
need real trainers, which is what the companion two-site run is for.

Usage:

    async with MockFederation(server, artifact_id, sites=[...]) as fed:
        for sid in fed.service_ids:
            await orch.add_trainer(trainer_service_id=sid, ...)
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np


@dataclass
class SiteSpec:
    """One mock site's fixed answers.

    ``weights`` is what this site returns from every fit, regardless of what
    global parameters it was sent. Returning a constant rather than perturbing
    the input is deliberate: it makes the expected aggregate a closed-form
    weighted mean of the site constants, so the assertion does not have to
    model the broadcast to know what the answer should be. What the site
    received is recorded separately in ``seen_fit_parameters``, so the
    broadcast is checked on its own rather than folded into the aggregate.

    ``num_examples`` is the FedAvg weight. Give the sites unequal counts, or
    the weighted mean and the plain mean coincide and the test cannot tell a
    correct implementation from one that ignores the weighting.
    """

    name: str
    weights: List[np.ndarray]
    num_examples: int
    eval_examples: int
    fit_loss: float
    eval_loss: float
    # Seconds to stall inside fit before reporting COMPLETED. Used to make the
    # round barrier real (every site finishing instantly proves nothing about
    # whether the orchestrator waits) and, at a large enough value, to drive
    # the straggler path in fit_clients.
    fit_delay: float = 0.0
    # When set, fit reports FAILED with this message instead of completing.
    # Drives the partial-failure path where some sites succeed and others do
    # not.
    fail_fit_with: Optional[str] = None
    # Whether cancel_fit cuts the remaining fit_delay short. True mirrors a
    # real trainer, which stops at the next batch boundary and hands back the
    # weights it has, so the orchestrator's "collect partial weights after a
    # graceful stop" branch gets something to collect. False models a site
    # that has stopped answering altogether, which is the branch that has to
    # drop the site from the round instead of waiting on it forever.
    honour_cancel: bool = True


@dataclass
class MockTrainer:
    """A single mock trainer service.

    Implements the trainer half of the uniform Chiron trainer API, which is
    what ``FlowerClientProxy`` and ``ChironOrchestrator.add_trainer`` call. The
    method set is taken from ``_chiron_trainer_base/trainer.py``: anything the
    orchestrator may call has to exist here or registration fails.
    """

    spec: SiteSpec
    artifact_id: str
    shared_keys: List[str]
    max_batch_size: int = 32
    default_batch_size: int = 32

    # Recorded call history, which is what the assertions read.
    seen_fit_parameters: List[List[np.ndarray]] = field(default_factory=list)
    seen_fit_configs: List[Dict[str, Any]] = field(default_factory=list)
    seen_fit_batch_sizes: List[Optional[int]] = field(default_factory=list)
    seen_eval_parameters: List[List[np.ndarray]] = field(default_factory=list)
    seen_eval_configs: List[Dict[str, Any]] = field(default_factory=list)
    cancel_fit_calls: int = 0
    fit_started_at: List[float] = field(default_factory=list)
    fit_finished_at: List[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._fit_status = "NOT_STARTED"
        self._fit_message = ""
        self._fit_result: Any = None
        self._eval_status = "NOT_STARTED"
        self._eval_message = ""
        self._eval_result: Any = None
        self._registered_to: Optional[str] = None
        self._session_active = False
        self._fit_task: Optional[asyncio.Task] = None
        self._fit_cancelled = False
        self._cancel_event = asyncio.Event()
        self._fit_generation = 0

    # ── Registration and liveness ───────────────────────────────────────

    async def ping(self) -> bool:
        return True

    async def is_busy(self) -> bool:
        return self._session_active

    async def get_registered_orchestrator(self) -> Optional[str]:
        return self._registered_to

    async def register_to_orchestrator(self, orchestrator_service_id: str) -> Dict[str, Any]:
        self._registered_to = orchestrator_service_id
        return {"success": True, "message": "registered"}

    async def unregister_from_orchestrator(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        self._registered_to = None
        self._session_active = False
        return {"success": True, "message": "unregistered"}

    async def set_session_active(
        self,
        active: bool,
        orchestrator_service_id: str = "",
        per_round_timeout: Optional[float] = None,
        aggregation_buffer: float = 300.0,
    ) -> None:
        self._session_active = bool(active)

    # ── Identity ────────────────────────────────────────────────────────

    async def get_properties(self) -> Dict[str, Any]:
        # add_trainer rejects a trainer whose artifact_id does not match the
        # one the orchestrator was deployed against, so this has to echo the
        # real trainer artifact rather than name itself.
        return {
            "client_name": self.spec.name,
            "artifact_id": self.artifact_id,
            "max_batch_size": self.max_batch_size,
            "default_batch_size": self.default_batch_size,
            "num_train_samples": self.spec.num_examples,
            "num_val_samples": self.spec.eval_examples,
            "datasets": [{"id": f"mock-{self.spec.name}", "name": f"Mock {self.spec.name}"}],
            "shared_weight_scope": "the mock's shared trunk",
            "hyperparameters": {
                "fit": {
                    "learning_rate": {
                        "type": "float",
                        "default": 0.001,
                        "description": "Mock learning rate.",
                        "advanced": True,
                    }
                },
                "evaluate": {},
            },
        }

    async def get_shared_keys(self) -> List[str]:
        return list(self.shared_keys)

    async def get_transformer_keys(self) -> List[str]:
        return list(self.shared_keys)

    async def get_shared_spec(self) -> Dict[str, Any]:
        return {
            "names": list(self.shared_keys),
            "shapes": [list(w.shape) for w in self.spec.weights],
            "dtypes": [str(w.dtype) for w in self.spec.weights],
            "fingerprint": f"mock-{self.spec.name}",
        }

    # ── Weights ─────────────────────────────────────────────────────────

    async def get_parameters(self) -> List[np.ndarray]:
        return [np.array(w, copy=True) for w in self.spec.weights]

    async def load_pretrained_weights(self, *args: Any, **kwargs: Any) -> Dict[str, str]:
        return {"success": "true", "message": "mock load"}

    async def save_model_weights(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        return {"success": True, "artifact_id": f"mock/{self.spec.name}"}

    async def save_local_model(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        return {"success": True, "path": f"/tmp/mock-{self.spec.name}"}

    async def list_local_model_weights(self, *args: Any, **kwargs: Any) -> List[Any]:
        return []

    async def clear_local_model_weights(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        return {"success": True}

    async def list_weight_checkpoints(self, *args: Any, **kwargs: Any) -> List[Any]:
        return []

    async def reset_training_state(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        self._fit_status = "NOT_STARTED"
        self._eval_status = "NOT_STARTED"
        self._fit_result = None
        self._eval_result = None
        return {"success": True, "message": "reset"}

    # ── Fit ─────────────────────────────────────────────────────────────

    async def start_fit(
        self,
        parameters: List[np.ndarray],
        batch_size: Optional[int] = None,
        config: Optional[Dict[str, Any]] = None,
        limit_train_batches: Optional[int] = None,
        server_round: int = 1,
        orchestrator_service_id: str = "",
        session_id: str = "",
    ) -> Dict[str, Any]:
        self.seen_fit_parameters.append([np.array(p, copy=True) for p in parameters])
        self.seen_fit_configs.append(dict(config or {}))
        self.seen_fit_batch_sizes.append(batch_size)
        self.fit_started_at.append(asyncio.get_running_loop().time())

        # A trainer runs one fit at a time. Without this, a site that the
        # orchestrator gave up on in round N keeps running here, and its late
        # completion overwrites round N+1's status with round N's weights —
        # which reads on the orchestrator side as a dropped site quietly
        # rejoining. That is an artefact of mocking a trainer as a coroutine,
        # not something a real trainer can do, so the mock must not produce
        # it. The generation counter makes the abandoned task's writes no-ops
        # even in the window before the cancellation lands.
        if self._fit_task is not None and not self._fit_task.done():
            self._fit_task.cancel()
        self._fit_generation += 1
        self._fit_status = "RUNNING"
        self._fit_message = ""
        self._fit_result = None
        self._fit_cancelled = False
        self._cancel_event = asyncio.Event()
        self._fit_task = asyncio.create_task(self._run_fit(self._fit_generation))
        return {"success": True, "message": "fit started"}

    async def _run_fit(self, generation: int) -> None:
        def current() -> bool:
            return generation == self._fit_generation

        try:
            if self.spec.fit_delay:
                # Sleeping outright would make cancel_fit unobservable: the
                # task is already inside the sleep by the time the cancel
                # arrives, so shortening the configured delay would change
                # nothing. Waiting on the event instead lets a cancel end the
                # delay early, which is what a real trainer's next-batch stop
                # looks like from the orchestrator's side.
                try:
                    await asyncio.wait_for(
                        self._cancel_event.wait(), timeout=self.spec.fit_delay
                    )
                except asyncio.TimeoutError:
                    pass
                if self._cancel_event.is_set() and not self.spec.honour_cancel:
                    # Deaf to the cancel. Keep occupying the round until the
                    # orchestrator gives up on this site.
                    await asyncio.sleep(self.spec.fit_delay)
            if not current():
                return
            if self.spec.fail_fit_with:
                self._fit_status = "FAILED"
                self._fit_message = self.spec.fail_fit_with
                return
            self._fit_result = [
                [np.array(w, copy=True) for w in self.spec.weights],
                self.spec.num_examples,
                {"loss": self.spec.fit_loss},
            ]
            self._fit_status = "COMPLETED"
        except asyncio.CancelledError:
            if current():
                self._fit_status = "CANCELLED"
            raise
        finally:
            self.fit_finished_at.append(asyncio.get_running_loop().time())

    async def get_fit_status(self) -> Dict[str, Any]:
        return {
            "status": self._fit_status,
            "message": self._fit_message,
            "result": self._fit_result,
            "current_batch": 0 if self._fit_status == "NOT_STARTED" else 1,
            "total_batches": 0 if self._fit_status == "NOT_STARTED" else 1,
            "progress": 0.0 if self._fit_status != "COMPLETED" else 1.0,
        }

    async def cancel_fit(self, orchestrator_service_id: str = "") -> Dict[str, str]:
        # A real trainer stops cooperatively at the next batch boundary and
        # still returns the partial weights it has. The mock mirrors that: it
        # completes with its configured result rather than dying, so
        # fit_clients' "collect partial weights after graceful stop" branch
        # gets a result to collect.
        self._fit_cancelled = True
        self.cancel_fit_calls += 1
        self._cancel_event.set()
        return {"success": "true", "message": "cancel requested"}

    # ── Evaluate ────────────────────────────────────────────────────────

    async def start_evaluate(
        self,
        parameters: List[np.ndarray],
        batch_size: Optional[int] = None,
        config: Optional[Dict[str, Any]] = None,
        limit_val_batches: Optional[int] = None,
        server_round: int = 1,
        orchestrator_service_id: str = "",
        session_id: str = "",
    ) -> Dict[str, Any]:
        self.seen_eval_parameters.append([np.array(p, copy=True) for p in parameters])
        self.seen_eval_configs.append(dict(config or {}))
        self._eval_status = "COMPLETED"
        self._eval_message = ""
        self._eval_result = [
            self.spec.eval_loss,
            self.spec.eval_examples,
            {"loss": self.spec.eval_loss},
        ]
        return {"success": True, "message": "evaluate done"}

    async def get_evaluate_status(self) -> Dict[str, Any]:
        return {
            "status": self._eval_status,
            "message": self._eval_message,
            "result": self._eval_result,
            "current_batch": 0 if self._eval_status == "NOT_STARTED" else 1,
            "total_batches": 0 if self._eval_status == "NOT_STARTED" else 1,
            "progress": 0.0 if self._eval_status != "COMPLETED" else 1.0,
        }

    async def cancel_evaluate(self, orchestrator_service_id: str = "") -> Dict[str, str]:
        return {"success": "true", "message": "cancel requested"}

    # ── Service registration ────────────────────────────────────────────

    def service_config(self, service_name: str) -> Dict[str, Any]:
        """The dict handed to ``server.register_service``.

        ``visibility`` is public because the orchestrator's pre-flight
        availability check goes through the Hypha HTTP gateway rather than the
        websocket, and a protected service is not reachable that way with the
        orchestrator's own token.
        """
        return {
            "id": service_name,
            "name": f"Mock Chiron Trainer ({self.spec.name})",
            "description": "Mock trainer for multi-site federation tests.",
            "config": {"visibility": "public", "require_context": False},
            "ping": self.ping,
            "is_busy": self.is_busy,
            "get_registered_orchestrator": self.get_registered_orchestrator,
            "register_to_orchestrator": self.register_to_orchestrator,
            "unregister_from_orchestrator": self.unregister_from_orchestrator,
            "set_session_active": self.set_session_active,
            "get_properties": self.get_properties,
            "get_shared_keys": self.get_shared_keys,
            "get_transformer_keys": self.get_transformer_keys,
            "get_shared_spec": self.get_shared_spec,
            "get_parameters": self.get_parameters,
            "load_pretrained_weights": self.load_pretrained_weights,
            "save_model_weights": self.save_model_weights,
            "save_local_model": self.save_local_model,
            "list_local_model_weights": self.list_local_model_weights,
            "clear_local_model_weights": self.clear_local_model_weights,
            "list_weight_checkpoints": self.list_weight_checkpoints,
            "reset_training_state": self.reset_training_state,
            "start_fit": self.start_fit,
            "get_fit_status": self.get_fit_status,
            "cancel_fit": self.cancel_fit,
            "start_evaluate": self.start_evaluate,
            "get_evaluate_status": self.get_evaluate_status,
            "cancel_evaluate": self.cancel_evaluate,
        }


def expected_fedavg(specs: List[SiteSpec], contributing: Optional[List[str]] = None) -> List[np.ndarray]:
    """The sample-weighted mean of the contributing sites' weights.

    Computed here from the specs alone, with no reference to anything the
    orchestrator did, so comparing against it is an independent check rather
    than a restatement of the implementation.
    """
    chosen = [s for s in specs if contributing is None or s.name in contributing]
    total = sum(s.num_examples for s in chosen)
    if total == 0:
        raise ValueError("no contributing sites")
    return [
        sum(s.num_examples * s.weights[i].astype(np.float64) for s in chosen) / total
        for i in range(len(chosen[0].weights))
    ]


def expected_weighted_loss(specs: List[SiteSpec], which: str) -> float:
    """The orchestrator's ``weighted_average`` over the same sites.

    Mirrors the two-line implementation in the orchestrator: losses weighted by
    num_examples for fit, by eval_examples for evaluate.
    """
    if which == "fit":
        pairs = [(s.num_examples, s.fit_loss) for s in specs]
    else:
        pairs = [(s.eval_examples, s.eval_loss) for s in specs]
    total = sum(n for n, _ in pairs)
    return sum(n * v for n, v in pairs) / total


class MockFederation:
    """Registers a set of mock trainers and cleans them up afterwards."""

    def __init__(self, server: Any, artifact_id: str, specs: List[SiteSpec], shared_keys: List[str]):
        self._server = server
        self._artifact_id = artifact_id
        self._specs = specs
        self._shared_keys = shared_keys
        self.trainers: Dict[str, MockTrainer] = {}
        self.service_ids: List[str] = []

    async def __aenter__(self) -> "MockFederation":
        for spec in self._specs:
            trainer = MockTrainer(
                spec=spec, artifact_id=self._artifact_id, shared_keys=self._shared_keys
            )
            # Each mock needs its own service NAME, not merely its own client
            # id. The orchestrator keys every trainer by the client-agnostic
            # form workspace/*:<service-name>, so two mocks sharing a name
            # would collapse onto one key and the federation would look like
            # one site again, which is exactly the failure this test exists to
            # rule out.
            service_name = f"mock-trainer-{spec.name}"
            info = await self._server.register_service(trainer.service_config(service_name))
            self.trainers[spec.name] = trainer
            self.service_ids.append(info["id"])
        return self

    async def __aexit__(self, *exc: Any) -> None:
        for sid in self.service_ids:
            try:
                await self._server.unregister_service(sid)
            except Exception:
                # Teardown is best effort. A left-behind registration expires
                # with the client connection and must not mask a test failure.
                pass
