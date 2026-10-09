"""The recipe machinery: parameters, fingerprints and the chain rule.

Pure tests. ``chiron.datasets.recipes`` imports nothing but the standard
library, so none of this needs a zarr store, a data server or a GPU, and the
whole file runs in well under a second. The parts that do touch a store are in
test_pipeline.py.

What is being protected here is mostly one property, stated three ways: a
stage's result is only valid if the stages it was computed from are. Everything
else in this file exists to make that property hard to break by accident.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from chiron.datasets.recipes import (  # noqa: E402
    Param,
    Recipe,
    Stage,
    StageResult,
    check_recipe,
    plan,
    resolve_params,
)


def _noop(zarr_path, params, logger):
    return StageResult(True)


def _stage(name, requires=(), params=(), version=1):
    return Stage(
        name=name,
        version=version,
        label=name,
        description=name,
        run=_noop,
        requires=tuple(requires),
        params=tuple(params),
    )


FILTER = Param(
    name="min_cells_per_gene",
    default=250,
    label="Minimum cells per gene",
    description="A gene detected in fewer cells than this is excluded.",
    minimum=0,
    maximum=1_000_000,
)
FIXED_WIDTH = Param(
    name="n_hvg",
    default=1200,
    label="Genes the model reads",
    description="The model's input width.",
    adjustable=False,
)


def chain() -> Recipe:
    """A three-stage chain shaped like Tabula's: a parameterised filter, a
    selection computed from it, and a discretisation computed from that."""
    return Recipe(
        model_family="toy",
        version=1,
        label="Toy",
        description="A chain",
        stages=(
            _stage("quality_control", params=(FILTER,)),
            _stage("selection", requires=("quality_control",), params=(FIXED_WIDTH,)),
            _stage("discretisation", requires=("selection",)),
        ),
    )


def actions_by_name(recipe, resolved, recorded=None):
    return {a.stage.name: a for a in plan(recipe, resolved, recorded)}


def satisfied_state(recipe, resolved):
    """The recorded block for a store where every stage has run and succeeded."""
    return {
        s.name: {"satisfied": True, "fingerprint": s.fingerprint(resolved)}
        for s in recipe.stages
    }


# --------------------------------------------------------------------------
# Parameters
# --------------------------------------------------------------------------


def test_defaults_fill_in():
    recipe = chain()
    assert resolve_params(recipe) == {"min_cells_per_gene": 250, "n_hvg": 1200}


def test_override_is_applied_and_coerced():
    resolved = resolve_params(chain(), {"min_cells_per_gene": "100"})
    assert resolved["min_cells_per_gene"] == 100
    assert isinstance(resolved["min_cells_per_gene"], int)


def test_unknown_parameter_is_rejected_not_ignored():
    # Silently dropping it would run the defaults while the operator believes
    # they changed something, which is the failure this is here to prevent.
    with pytest.raises(ValueError, match="has no parameter 'min_cells'"):
        resolve_params(chain(), {"min_cells": 100})


def test_fixed_parameter_cannot_be_set():
    with pytest.raises(ValueError, match="n_hvg is fixed"):
        resolve_params(chain(), {"n_hvg": 900})


def test_fixed_parameter_message_says_why():
    with pytest.raises(ValueError) as excinfo:
        resolve_params(chain(), {"n_hvg": 900})
    assert "input width" in str(excinfo.value)


@pytest.mark.parametrize("value", [-1, 1_000_001])
def test_out_of_range_is_rejected(value):
    with pytest.raises(ValueError, match="min_cells_per_gene"):
        resolve_params(chain(), {"min_cells_per_gene": value})


def test_non_numeric_is_rejected():
    with pytest.raises(ValueError, match="whole number"):
        resolve_params(chain(), {"min_cells_per_gene": "many"})


def test_schema_exposes_which_parameters_are_adjustable():
    described = {p["name"]: p for p in chain().describe()["params"]}
    assert described["min_cells_per_gene"]["adjustable"] is True
    assert described["n_hvg"]["adjustable"] is False
    assert described["min_cells_per_gene"]["minimum"] == 0


# --------------------------------------------------------------------------
# Fingerprints
# --------------------------------------------------------------------------


def test_fingerprint_is_stable_across_calls():
    recipe, resolved = chain(), resolve_params(chain())
    assert recipe.fingerprint(resolved) == recipe.fingerprint(resolved)


def test_fingerprint_moves_when_a_parameter_moves():
    recipe = chain()
    a = recipe.fingerprint(resolve_params(recipe))
    b = recipe.fingerprint(resolve_params(recipe, {"min_cells_per_gene": 100}))
    assert a != b


def test_stage_fingerprint_ignores_another_stage_s_parameters():
    # The chain rule needs to tell "recomputed because its own inputs changed"
    # from "restamped because something unrelated moved". If a sibling's
    # parameter entered this stage's fingerprint it could not.
    recipe = chain()
    selection = recipe.stage("selection")
    a = selection.fingerprint(resolve_params(recipe))
    b = selection.fingerprint(resolve_params(recipe, {"min_cells_per_gene": 100}))
    assert a == b


def test_stage_fingerprint_moves_when_its_version_moves():
    resolved = resolve_params(chain())
    assert _stage("x", version=1).fingerprint(resolved) != _stage(
        "x", version=2
    ).fingerprint(resolved)


# --------------------------------------------------------------------------
# The chain rule
# --------------------------------------------------------------------------


def test_everything_runs_on_a_store_that_records_nothing():
    recipe = chain()
    acts = actions_by_name(recipe, resolve_params(recipe), {})
    assert [a.action for a in acts.values()] == ["run", "run", "run"]
    assert acts["quality_control"].reason == "not computed on this store yet"


def test_nothing_runs_on_a_store_that_is_current():
    recipe = chain()
    resolved = resolve_params(recipe)
    acts = actions_by_name(recipe, resolved, satisfied_state(recipe, resolved))
    assert [a.action for a in acts.values()] == ["skip", "skip", "skip"]


def test_changing_a_threshold_recomputes_the_whole_chain_behind_it():
    """The case the whole mechanism exists for.

    `selection` has no parameters of its own, so its own fingerprint never
    moves. A presence check would see its output on disk and leave it alone,
    producing a selection computed behind one filter and recorded as valid
    behind another. Nothing downstream could detect that.
    """
    recipe = chain()
    before = resolve_params(recipe)
    recorded = satisfied_state(recipe, before)

    after = resolve_params(recipe, {"min_cells_per_gene": 100})
    acts = actions_by_name(recipe, after, recorded)

    assert acts["quality_control"].action == "run"
    assert acts["selection"].action == "run"
    assert acts["discretisation"].action == "run"
    # And it says why, in terms of the stage that moved.
    assert "quality_control" in acts["selection"].reason
    assert "selection" in acts["discretisation"].reason
    # The selection's own fingerprint really is unchanged, which is what makes
    # this test meaningful rather than a tautology.
    assert recipe.stage("selection").fingerprint(after) == recorded["selection"][
        "fingerprint"
    ]


def test_a_stage_that_never_ran_blocks_everything_after_it():
    recipe = chain()
    resolved = resolve_params(recipe)
    recorded = satisfied_state(recipe, resolved)
    # Quality control was never satisfied, the other two claim to be current.
    recorded["quality_control"]["satisfied"] = False

    acts = actions_by_name(recipe, resolved, recorded)
    assert acts["quality_control"].action == "run"
    assert acts["selection"].action == "run"
    assert acts["discretisation"].action == "run"


def test_a_blocked_stage_blocks_everything_after_it():
    """A stage whose prerequisite is absent from the recipe's own run order.

    Built by hand rather than through `chain()`, because `check_recipe` refuses
    a recipe with a forward reference and this is the shape that reaches `plan`
    when a stage refuses at run time.
    """
    recipe = Recipe(
        model_family="toy",
        version=1,
        label="Toy",
        description="",
        stages=(
            _stage("a"),
            _stage("b", requires=("missing",)),
            _stage("c", requires=("b",)),
        ),
    )
    acts = actions_by_name(recipe, {}, {})
    assert acts["a"].action == "run"
    assert acts["b"].action == "blocked"
    assert acts["c"].action == "blocked"
    assert "b" in acts["c"].reason


def test_an_independent_stage_is_untouched_by_a_sibling_chain():
    """Two models on one store must not disturb each other.

    This is the plan-level half of the property; the on-disk half is in
    test_pipeline.py.
    """
    recipe = Recipe(
        model_family="two",
        version=1,
        label="Two",
        description="",
        stages=(
            _stage("quality_control", params=(FILTER,)),
            _stage("selection", requires=("quality_control",)),
            _stage("ordering"),  # no requires: the other model's chain
        ),
    )
    before = resolve_params(recipe)
    recorded = satisfied_state(recipe, before)
    acts = actions_by_name(recipe, resolve_params(recipe, {"min_cells_per_gene": 1}), recorded)

    assert acts["quality_control"].action == "run"
    assert acts["selection"].action == "run"
    assert acts["ordering"].action == "skip"


def test_plan_returns_one_action_per_stage_in_recipe_order():
    recipe = chain()
    acts = plan(recipe, resolve_params(recipe), {})
    assert [a.stage.name for a in acts] == [s.name for s in recipe.stages]


# --------------------------------------------------------------------------
# Malformed recipes
# --------------------------------------------------------------------------


def test_duplicate_stage_name_is_rejected():
    recipe = Recipe("x", 1, "x", "", (_stage("a"), _stage("a")))
    with pytest.raises(ValueError, match="two stages are called"):
        check_recipe(recipe)


def test_forward_reference_is_rejected():
    # It could never be satisfied: the stage list is the execution order, so a
    # stage requiring a later one would be blocked on every single run.
    recipe = Recipe("x", 1, "x", "", (_stage("a", requires=("b",)), _stage("b")))
    with pytest.raises(ValueError, match="not an earlier stage"):
        check_recipe(recipe)


def test_unknown_requirement_is_rejected():
    recipe = Recipe("x", 1, "x", "", (_stage("a", requires=("nope",)),))
    with pytest.raises(ValueError, match="not an earlier stage"):
        check_recipe(recipe)


def test_a_parameter_declared_twice_is_rejected():
    # It would look like one field to an organiser and behave as two.
    recipe = Recipe(
        "x", 1, "x", "", (_stage("a", params=(FILTER,)), _stage("b", params=(FILTER,)))
    )
    with pytest.raises(ValueError, match="declared by both"):
        check_recipe(recipe)


def test_a_default_outside_its_own_bounds_is_rejected():
    bad = Param(
        name="p", default=5, label="p", description="p", minimum=10, maximum=20
    )
    recipe = Recipe("x", 1, "x", "", (_stage("a", params=(bad,)),))
    with pytest.raises(ValueError, match="below the minimum"):
        check_recipe(recipe)


def test_inverted_bounds_are_rejected():
    bad = Param(
        name="p", default=15, label="p", description="p", minimum=20, maximum=10
    )
    recipe = Recipe("x", 1, "x", "", (_stage("a", params=(bad,)),))
    with pytest.raises(ValueError, match="above maximum"):
        check_recipe(recipe)


def test_the_shipped_recipes_are_well_formed():
    """The real ones, not a toy. Imported lazily because this is the only test
    in the file that needs the data server's dependencies."""
    from chiron.datasets.__main__ import RECIPES

    assert set(RECIPES) == {"tabula", "geneformer"}
    for recipe in RECIPES.values():
        check_recipe(recipe)


def test_tabula_exposes_the_two_thresholds_and_fixes_the_rest():
    from chiron.datasets.__main__ import RECIPES

    params = {p.name: p for p in RECIPES["tabula"].params}
    assert params["min_genes_per_cell"].adjustable
    assert params["min_cells_per_gene"].adjustable
    assert not params["n_hvg"].adjustable
    assert not params["n_bins"].adjustable


def test_geneformer_fixes_everything_the_checkpoint_owns():
    from chiron.datasets.__main__ import RECIPES

    params = {p.name: p for p in RECIPES["geneformer"].params}
    assert params["geneformer_min_genes_per_cell"].adjustable
    assert not params["geneformer_max_ranks"].adjustable


def test_tabula_hvg_runs_behind_quality_control():
    """The Methods order, asserted as a dependency rather than as a comment."""
    from chiron.datasets.__main__ import RECIPES

    stages = {s.name: s for s in RECIPES["tabula"].stages}
    assert "quality_control" in stages["hvg_ranking"].requires
    assert "hvg_ranking" in stages["binning"].requires
    assert "quality_control" in stages["umap"].requires
