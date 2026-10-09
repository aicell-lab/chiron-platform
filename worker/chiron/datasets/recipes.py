"""Declared preprocessing recipes: stages, parameters, and the chain rule.

One data server prepares one site's data for whichever foundation model is
going to train on it, and each model needs a different preparation of the same
raw counts. This module holds the machinery for saying what those preparations
are, which parts of them a human is allowed to adjust, and when a stored result
is still valid.

Three ideas, and they are all the same idea seen from different sides.

**A stage is identified by what produced it, not by the fact that it exists.**
A stage's fingerprint is a digest of its name, its code version and the
parameters it was run with. Finding the output keys on a store proves something
ran; comparing the fingerprint proves the right thing ran. The difference
matters the moment a parameter becomes adjustable, because from then on two
different quality-control filters write the same two keys.

**A stage is only as valid as the stages it was computed from.** Tabula selects
1,200 highly variable genes from what survives quality control, so an HVG
ranking computed behind one filter is wrong behind another, even though the HVG
step itself has no parameters and its own fingerprint never changed. A missing
or changed prerequisite therefore invalidates the stage and everything after
it, which is what :func:`plan` implements.

**Not every number is a preference.** Tabula's 1,200 genes and its 50 value bins
are properties of a pretrained model: change them and the checkpoint no longer
fits its own input. The cell and gene thresholds are genuinely a site's call.
Only the second kind is declared adjustable, and :func:`resolve_params` refuses
an attempt to set the first kind rather than silently ignoring it.

No zarr and no numpy here on purpose. The machinery is pure data, so it can be
tested without a store and read by anyone trying to understand what the server
will do before it does it.
"""

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

#: Marker for a stage that declined to run on this store, as opposed to one
#: that failed. A refusal is a statement about the data, carries a reason, and
#: is not an error.
REFUSED = "refused"


@dataclass(frozen=True)
class Param:
    """One number a recipe exposes, and whether a human may change it.

    ``adjustable=False`` is not decoration. A fixed parameter still enters the
    fingerprint, so changing it in the code recomputes every affected store,
    but an organiser cannot set it from the UI and an attempt to is an error
    rather than a no-op.
    """

    name: str
    default: float
    label: str
    description: str
    unit: str = ""
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    integer: bool = True
    adjustable: bool = True

    def coerce(self, value: Any) -> float:
        """``value`` as this parameter's type, or raise ValueError."""
        try:
            return int(value) if self.integer else float(value)
        except (TypeError, ValueError):
            kind = "whole number" if self.integer else "number"
            raise ValueError(f"{self.name} must be a {kind}, got {value!r}")

    def validate(self, value: float) -> None:
        """Raise ValueError when ``value`` is outside this parameter's range."""
        if self.minimum is not None and value < self.minimum:
            raise ValueError(
                f"{self.name} is {value}, below the minimum {self.minimum}"
            )
        if self.maximum is not None and value > self.maximum:
            raise ValueError(
                f"{self.name} is {value}, above the maximum {self.maximum}"
            )

    def describe(self) -> Dict[str, Any]:
        """This parameter as the manager and the frontend see it."""
        return {
            "name": self.name,
            "default": self.default,
            "label": self.label,
            "description": self.description,
            "unit": self.unit,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "integer": self.integer,
            "adjustable": self.adjustable,
        }


@dataclass(frozen=True)
class Stage:
    """One step of a recipe, and what it depends on.

    ``run`` is called as ``run(zarr_path, params, logger)`` and returns a
    :class:`StageResult`. ``params`` holds only this stage's own parameters,
    already resolved and validated, so a stage never reads a global.
    """

    name: str
    version: int
    label: str
    description: str
    run: Callable[..., "StageResult"]
    requires: Tuple[str, ...] = ()
    params: Tuple[Param, ...] = ()
    #: Where this stage writes, as ``container/key`` paths. Reported to the UI
    #: so an operator can see what a stage puts on their data, and used by
    #: nothing else: validity is decided by the fingerprint, never by whether a
    #: key happens to be present.
    outputs: Tuple[str, ...] = ()

    def param(self, name: str) -> Optional[Param]:
        for p in self.params:
            if p.name == name:
                return p
        return None

    def fingerprint(self, resolved: Mapping[str, Any]) -> str:
        """Digest of this stage's identity and the values it would run with.

        Only this stage's own parameters enter it. A sibling stage's parameter
        changing must not restamp this one, because then nothing could tell
        "recomputed because its own inputs changed" from "restamped because
        something unrelated moved", and the chain rule below needs that
        distinction to decide what is genuinely stale.
        """
        payload = {
            "stage": self.name,
            "version": self.version,
            "params": {p.name: resolved.get(p.name) for p in sorted(
                self.params, key=lambda q: q.name
            )},
        }
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class StageResult:
    """What a stage did.

    Three outcomes, and they are not two. ``wrote`` means the artifact is on
    disk and the stage is satisfied. ``refused`` means the stage looked at the
    data and decided it does not apply, which leaves it unsatisfied and so
    blocks everything downstream, but is not a failure and carries a reason a
    human can act on. A raised exception is the third, and the caller turns it
    into a failure.
    """

    wrote: bool
    stats: Dict[str, Any] = field(default_factory=dict)
    refused: Optional[str] = None

    @property
    def satisfied(self) -> bool:
        return self.wrote and self.refused is None


#: A stage that did nothing because its result was already correct. Distinct
#: from a refusal: the stage is satisfied, it simply had no work.
UNCHANGED = StageResult(wrote=True)


@dataclass(frozen=True)
class Recipe:
    """Every stage one model family needs, in dependency order."""

    model_family: str
    version: int
    label: str
    description: str
    stages: Tuple[Stage, ...]

    def stage(self, name: str) -> Optional[Stage]:
        for s in self.stages:
            if s.name == name:
                return s
        return None

    @property
    def params(self) -> Tuple[Param, ...]:
        """Every parameter across every stage, in stage order.

        Two stages may not declare the same parameter name. They would appear
        to an organiser as one field and behave as two, which is the kind of
        thing nobody notices until the numbers disagree. :func:`check_recipe`
        rejects it at import time.
        """
        return tuple(p for s in self.stages for p in s.params)

    def fingerprint(self, resolved: Mapping[str, Any]) -> str:
        """Digest of the whole recipe as it would run with these parameters.

        This is what two sites of one federation compare. If it differs they
        prepared their data differently, and averaging models trained on
        differently filtered data produces no error anywhere.
        """
        blob = json.dumps(
            {
                "recipe": self.model_family,
                "version": self.version,
                "stages": [s.fingerprint(resolved) for s in self.stages],
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(blob.encode()).hexdigest()[:16]

    def describe(self) -> Dict[str, Any]:
        """The whole recipe as the manager and the frontend see it."""
        return {
            "model_family": self.model_family,
            "version": self.version,
            "label": self.label,
            "description": self.description,
            "stages": [
                {
                    "name": s.name,
                    "version": s.version,
                    "label": s.label,
                    "description": s.description,
                    "requires": list(s.requires),
                    "outputs": list(s.outputs),
                    "params": [p.describe() for p in s.params],
                }
                for s in self.stages
            ],
            "params": [p.describe() for p in self.params],
            "defaults": {p.name: p.default for p in self.params},
        }


def check_recipe(recipe: Recipe) -> None:
    """Raise ValueError if a recipe cannot mean what it says.

    Called at import time rather than at first use, so a malformed recipe stops
    the data server at startup instead of on whichever store happens to be
    scanned first.
    """
    seen_stages: set = set()
    seen_params: Dict[str, str] = {}
    for stage in recipe.stages:
        if stage.name in seen_stages:
            raise ValueError(
                f"{recipe.model_family}: two stages are called {stage.name!r}"
            )
        for required in stage.requires:
            # Forward references are rejected, not just unknown ones. The stage
            # list IS the execution order, so a stage requiring a later one
            # could never be satisfied and the chain rule would silently block
            # it on every run.
            if required not in seen_stages:
                raise ValueError(
                    f"{recipe.model_family}: stage {stage.name!r} requires "
                    f"{required!r}, which is not an earlier stage"
                )
        for param in stage.params:
            if param.name in seen_params:
                raise ValueError(
                    f"{recipe.model_family}: parameter {param.name!r} is "
                    f"declared by both {seen_params[param.name]!r} and "
                    f"{stage.name!r}"
                )
            if (
                param.minimum is not None
                and param.maximum is not None
                and param.minimum > param.maximum
            ):
                raise ValueError(
                    f"{recipe.model_family}: parameter {param.name!r} has "
                    f"minimum {param.minimum} above maximum {param.maximum}"
                )
            param.validate(param.default)
            seen_params[param.name] = stage.name
        seen_stages.add(stage.name)


def resolve_params(
    recipe: Recipe, requested: Optional[Mapping[str, Any]] = None
) -> Dict[str, Any]:
    """Every parameter of ``recipe``, defaults filled in and overrides checked.

    Rejects rather than ignores. An unknown name is usually a typo, and
    silently dropping it would run the defaults while the operator believes
    they changed something. Setting a parameter the recipe declares fixed is
    refused for the same reason, and the message says why it is fixed rather
    than only that it is.

    Raises:
        ValueError: on an unknown name, a fixed parameter, a wrong type, or a
            value outside the declared range. The message names the parameter.
    """
    resolved = {p.name: p.default for p in recipe.params}
    if not requested:
        return resolved

    by_name = {p.name: p for p in recipe.params}
    for name, value in requested.items():
        param = by_name.get(name)
        if param is None:
            known = ", ".join(sorted(by_name)) or "nothing"
            raise ValueError(
                f"{recipe.model_family} preprocessing has no parameter "
                f"{name!r}. It accepts: {known}"
            )
        if not param.adjustable:
            raise ValueError(
                f"{param.name} is fixed at {param.default} for "
                f"{recipe.model_family} and cannot be changed per run. "
                f"{param.description}"
            )
        coerced = param.coerce(value)
        param.validate(coerced)
        resolved[name] = coerced
    return resolved


@dataclass(frozen=True)
class StageAction:
    """What :func:`plan` decided about one stage, and why."""

    stage: Stage
    #: "run", "skip" or "blocked".
    action: str
    fingerprint: str
    reason: str = ""

    @property
    def should_run(self) -> bool:
        return self.action == "run"


def plan(
    recipe: Recipe,
    resolved: Mapping[str, Any],
    recorded: Optional[Mapping[str, Any]] = None,
) -> List[StageAction]:
    """Decide, per stage, whether to run it, skip it, or block it.

    The chain rule, stated once:

    - A stage whose prerequisites are not satisfied is **blocked**, and so is
      everything that depends on it. Nothing downstream of a missing input can
      be trusted, so nothing downstream is attempted.
    - A stage is **stale** when its own fingerprint differs from what the store
      records, meaning its code or its parameters changed.
    - A stage is also stale when anything it depends on is going to run, even
      if its own fingerprint is untouched. This is the case that a presence
      check cannot see and that makes the whole mechanism necessary: Tabula's
      HVG step has no parameters, so its fingerprint never moves, but lowering
      the gene filter changes which genes it should have ranked.
    - Anything else is **skipped**.

    Args:
        recipe: the recipe to plan.
        resolved: output of :func:`resolve_params`.
        recorded: this store's recorded stage state, ``{name: {...}}`` with at
            least ``fingerprint`` and ``satisfied`` per entry. Empty or None
            means a store nothing has run on.

    Returns:
        One :class:`StageAction` per stage, in recipe order.
    """
    recorded = recorded or {}
    satisfied: set = set()
    dirty: set = set()
    actions: List[StageAction] = []

    for stage in recipe.stages:
        fingerprint = stage.fingerprint(resolved)
        missing = [r for r in stage.requires if r not in satisfied]
        if missing:
            actions.append(
                StageAction(
                    stage,
                    "blocked",
                    fingerprint,
                    reason=(
                        f"{', '.join(missing)} did not complete, and "
                        f"{stage.name} is computed from it"
                    ),
                )
            )
            # A blocked stage is itself a changed input for anything after it.
            dirty.add(stage.name)
            continue

        previous = recorded.get(stage.name) or {}
        upstream = sorted(r for r in stage.requires if r in dirty)
        if upstream:
            reason = (
                f"{', '.join(upstream)} is being recomputed, and {stage.name} "
                f"is computed from it"
            )
        elif not previous.get("satisfied"):
            reason = "not computed on this store yet"
        elif previous.get("fingerprint") != fingerprint:
            reason = "the settings or the code behind this step changed"
        else:
            actions.append(StageAction(stage, "skip", fingerprint, "already current"))
            satisfied.add(stage.name)
            continue

        actions.append(StageAction(stage, "run", fingerprint, reason))
        dirty.add(stage.name)
        # Optimistic: the executor removes it again if the stage refuses, which
        # is what blocks the rest of the chain.
        satisfied.add(stage.name)

    return _reblock(recipe, actions)


def _reblock(recipe: Recipe, actions: Sequence[StageAction]) -> List[StageAction]:
    """Propagate blocking downstream after the optimistic first pass.

    :func:`plan` marks a stage satisfied as soon as it decides to run it,
    because at planning time it cannot know whether the stage will refuse. A
    stage that is *blocked*, though, is known not to be satisfied right away,
    and everything downstream of it has to become blocked too. Done as a second
    pass so the rule lives in one place rather than being threaded through the
    loop above.
    """
    blocked = {a.stage.name for a in actions if a.action == "blocked"}
    if not blocked:
        return list(actions)

    out: List[StageAction] = []
    for action in actions:
        if action.action != "blocked":
            upstream = sorted(r for r in action.stage.requires if r in blocked)
            if upstream:
                blocked.add(action.stage.name)
                out.append(
                    StageAction(
                        action.stage,
                        "blocked",
                        action.fingerprint,
                        reason=(
                            f"{', '.join(upstream)} did not complete, and "
                            f"{action.stage.name} is computed from it"
                        ),
                    )
                )
                continue
        out.append(action)
    return out


def blank_state(recipe: Recipe, resolved: Mapping[str, Any]) -> Dict[str, Any]:
    """The recorded block for a store nothing has run on."""
    return {
        "recipe_version": recipe.version,
        "fingerprint": recipe.fingerprint(resolved),
        "params": dict(resolved),
        "stages": {},
    }
