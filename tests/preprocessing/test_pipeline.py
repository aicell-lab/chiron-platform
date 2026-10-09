"""The recipes applied to real zarr stores.

test_recipes.py proves the machinery decides correctly. This proves the data
server then does what was decided, on disk, where the things that actually go
wrong live: a stage that writes but is not recorded, a recompute that leaves
the old artifact behind, one model's preprocessing stepping on another's, and a
re-apply that silently reverts to defaults.

Two fixtures. ``synthetic_store`` is built from scratch and is enough for
everything about Tabula and about the chain rule. ``cellxgene_store`` is a
subset of a real CELLxGENE download and is the only one Geneformer can use,
because its gene set is its own vocabulary and synthetic gene ids match
nothing; those tests skip when the download is absent.
"""

import hashlib
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

import anndata as ad  # noqa: E402
import scipy.sparse as sp  # noqa: E402
import zarr  # noqa: E402

ad.settings.zarr_write_format = 3

from chiron.datasets.__main__ import (  # noqa: E402
    GENEFORMER_GROUP,
    PREP_ATTR_PREFIX,
    PREP_REQUEST_PREFIX,
    PREP_STATUS_PREFIX,
    RECIPES,
    apply_recipe,
    convert_anndata_to_zarr,
)
from chiron.datasets.recipes import resolve_params  # noqa: E402

CELLXGENE_H5AD = Path("/home/nmechtel/gf-val/entorhinal.h5ad")

try:  # pragma: no cover - import shape only
    from bioengine.utils import create_logger

    LOG = create_logger("test-preprocessing")
except Exception:  # pragma: no cover
    import logging

    LOG = logging.getLogger("test-preprocessing")


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


def _write_synthetic(path: Path, n_cells=1500, n_genes=4000, seed=0):
    """A raw-counts store calibrated so every threshold in these tests bites.

    Wider than the model's 1,200-gene input on purpose: a store at or below
    that width is already a selected panel, the guard says so, and every stage
    would refuse, which would make these tests pass for the wrong reason.

    Both axes are deliberately uneven, and both have to be. Per-gene detection
    rates spread so that moving the gene filter changes which genes survive;
    per-cell sequencing depth spread so that moving the cell filter changes
    which cells do. A fixture uniform on either axis would let a test that
    changed that threshold pass while measuring nothing, because the before and
    after would be identical.

    At the published defaults this keeps roughly 1,357 of 1,500 cells and 2,413
    of 4,000 genes, which leaves more genes than the model's input width, so
    the selection is a real selection rather than "whatever survived".
    """
    rng = np.random.default_rng(seed)
    rates = rng.uniform(0.10, 0.90, size=n_genes)        # per-gene detection
    depth = 10 ** rng.uniform(-1.0, 0.0, size=n_cells)   # per-cell depth
    probability = np.clip(rates[None, :] * depth[:, None], 0.0, 1.0)
    dense = (rng.random((n_cells, n_genes)) < probability).astype(np.float32)
    dense *= rng.integers(1, 40, size=(n_cells, n_genes)).astype(np.float32)
    adata = ad.AnnData(X=sp.csr_matrix(dense))
    adata.var_names = [f"GENE{i:05d}" for i in range(n_genes)]
    adata.obs_names = [f"CELL{i:05d}" for i in range(n_cells)]
    if path.exists():
        shutil.rmtree(path)
    adata.write_zarr(path)
    return path


@pytest.fixture
def synthetic_store(tmp_path):
    return _write_synthetic(tmp_path / "synthetic.zarr")


@pytest.fixture
def cellxgene_store(tmp_path):
    if not CELLXGENE_H5AD.exists():
        pytest.skip(f"{CELLXGENE_H5AD} not present")
    adata = ad.read_h5ad(CELLXGENE_H5AD)
    # 400 cells is enough to exercise every path and keeps the file small.
    subset = adata[:400].copy()
    path = tmp_path / "cellxgene.zarr"
    subset.write_zarr(path)
    return path


# --------------------------------------------------------------------------
# Snapshot helpers
# --------------------------------------------------------------------------


def _digest(node):
    value = np.asarray(node[...])
    # An object-dtype array's buffer holds pointers, so hashing it compares
    # heap addresses and calls two identical string columns different.
    if value.dtype == object or value.dtype.kind in "USO":
        payload = repr(value.astype(str).tolist()).encode()
    else:
        payload = np.ascontiguousarray(value).tobytes()
    return hashlib.sha256(payload).hexdigest()[:16]


def _walk(group, prefix=""):
    out = {}
    for name in sorted(group):
        node = group[name]
        path = f"{prefix}{name}"
        if isinstance(node, zarr.Group):
            out.update(_walk(node, path + "/"))
        else:
            out[path] = _digest(node)
    return out


def snapshot(path):
    """Every array in the store, by path, as a content digest."""
    return _walk(zarr.open_group(str(path), mode="r"))


def attrs(path):
    return dict(zarr.open_group(str(path), mode="r").attrs)


def state(path, family):
    return attrs(path).get(f"{PREP_ATTR_PREFIX}{family}") or {}


def tabula_keys(snap):
    return {
        k: v
        for k, v in snap.items()
        if GENEFORMER_GROUP not in k and "chiron_" in k
    }


def geneformer_keys(snap):
    return {k: v for k, v in snap.items() if GENEFORMER_GROUP in k}


def source_keys(snap):
    return {
        k: v
        for k, v in snap.items()
        if GENEFORMER_GROUP not in k and "chiron_" not in k
    }


# --------------------------------------------------------------------------
# A fresh store
# --------------------------------------------------------------------------


def test_a_fresh_store_gets_the_whole_tabula_chain(synthetic_store):
    result = apply_recipe(synthetic_store, RECIPES["tabula"], None, LOG)

    assert result["changed"] is True
    stages = result["stages"]
    assert set(stages) == {s.name for s in RECIPES["tabula"].stages}
    for name in ("quality_control", "hvg_ranking", "binning"):
        assert stages[name]["satisfied"], f"{name}: {stages[name].get('reason')}"

    snap = snapshot(synthetic_store)
    assert "obs/chiron_qc_cell_mask" in snap
    assert "var/chiron_qc_gene_mask" in snap
    assert "var/chiron_hvg_selected" in snap
    assert "layers/chiron_binned" in snap


def test_the_recorded_parameters_are_the_ones_that_ran(synthetic_store):
    apply_recipe(synthetic_store, RECIPES["tabula"], {"min_cells_per_gene": 111}, LOG)
    recorded = state(synthetic_store, "tabula")
    assert recorded["params"]["min_cells_per_gene"] == 111
    assert recorded["stages"]["quality_control"]["params"]["min_cells_per_gene"] == 111
    # And the store's own quality-control attrs agree with the recipe's record,
    # so there is no way for the two to drift and both look right.
    assert attrs(synthetic_store)["chiron_qc_min_cells_per_gene"] == 111


def test_a_second_apply_writes_nothing_and_changes_nothing(synthetic_store):
    apply_recipe(synthetic_store, RECIPES["tabula"], None, LOG)
    before = snapshot(synthetic_store)
    before_attrs = attrs(synthetic_store)

    result = apply_recipe(synthetic_store, RECIPES["tabula"], None, LOG)

    assert result["changed"] is False
    assert snapshot(synthetic_store) == before
    assert attrs(synthetic_store) == before_attrs


# --------------------------------------------------------------------------
# The chain rule, on disk
# --------------------------------------------------------------------------


def test_changing_the_gene_filter_reselects_the_gene_panel(synthetic_store):
    """The defect the chain rule exists to prevent, measured.

    The HVG stage has no parameters, so a presence check would leave its
    output alone and the store would carry a panel selected behind one filter
    while recording another. Here the panel has to actually change.
    """
    apply_recipe(synthetic_store, RECIPES["tabula"], {"min_cells_per_gene": 60}, LOG)
    loose_selected = np.asarray(
        zarr.open_group(str(synthetic_store), mode="r")["var"]["chiron_hvg_selected"][:]
    )
    loose_genes = int(attrs(synthetic_store)["chiron_qc_n_genes_kept"])

    apply_recipe(synthetic_store, RECIPES["tabula"], {"min_cells_per_gene": 400}, LOG)
    strict_selected = np.asarray(
        zarr.open_group(str(synthetic_store), mode="r")["var"]["chiron_hvg_selected"][:]
    )
    strict_genes = int(attrs(synthetic_store)["chiron_qc_n_genes_kept"])

    assert strict_genes < loose_genes, "a stricter filter must keep fewer genes"
    assert not np.array_equal(loose_selected, strict_selected), (
        "the gene panel did not move when the filter it is selected from did, "
        "which is exactly the silent failure the chain rule is for"
    )
    # No gene the filter excluded can be in the panel.
    gene_mask = np.asarray(
        zarr.open_group(str(synthetic_store), mode="r")["var"]["chiron_qc_gene_mask"][:]
    )
    assert not (strict_selected & ~gene_mask).any()


def test_changing_the_gene_filter_reruns_everything_downstream(synthetic_store):
    apply_recipe(synthetic_store, RECIPES["tabula"], {"min_cells_per_gene": 60}, LOG)
    before = snapshot(synthetic_store)

    apply_recipe(synthetic_store, RECIPES["tabula"], {"min_cells_per_gene": 400}, LOG)
    after = snapshot(synthetic_store)

    for key in (
        "var/chiron_qc_gene_mask",
        "var/chiron_hvg_score",
        "var/chiron_hvg_selected",
        "layers/chiron_binned",
    ):
        assert before[key] != after[key], f"{key} was not recomputed"


def test_the_cell_filter_decides_which_cells_the_panel_is_scored_across(
    synthetic_store,
):
    """The Methods order, measured rather than asserted from a comment."""
    apply_recipe(synthetic_store, RECIPES["tabula"], {"min_genes_per_cell": 0}, LOG)
    all_cells = snapshot(synthetic_store)["var/chiron_hvg_score"]
    n_all = int(attrs(synthetic_store)["chiron_hvg_n_cells_scored"])

    apply_recipe(synthetic_store, RECIPES["tabula"], {"min_genes_per_cell": 600}, LOG)
    some_cells = snapshot(synthetic_store)["var/chiron_hvg_score"]
    n_some = int(attrs(synthetic_store)["chiron_hvg_n_cells_scored"])

    assert n_some < n_all, "a cell filter that drops nothing proves nothing here"
    assert all_cells != some_cells, (
        "variability was scored across the same cells before and after a cell "
        "filter changed, so quality control is not in front of it"
    )


def test_a_bad_parameter_raises_and_leaves_the_store_alone(synthetic_store):
    apply_recipe(synthetic_store, RECIPES["tabula"], None, LOG)
    before = snapshot(synthetic_store)

    with pytest.raises(ValueError, match="n_hvg is fixed"):
        apply_recipe(synthetic_store, RECIPES["tabula"], {"n_hvg": 42}, LOG)

    assert snapshot(synthetic_store) == before


def test_a_store_already_reduced_is_refused_and_blocks_the_rest():
    """Refusal propagates, so no stage downstream produces a confident wrong
    answer on data its input never got applied to."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        # 800 genes, below the 1,200-gene input width, so this is a panel and
        # not a transcriptome.
        path = _write_synthetic(Path(tmp) / "reduced.zarr", n_cells=300, n_genes=800)
        result = apply_recipe(path, RECIPES["tabula"], None, LOG)

        stages = result["stages"]
        assert stages["quality_control"]["refused"] is True
        assert "already a selected panel" in stages["quality_control"]["reason"]
        for name in ("hvg_ranking", "binning", "umap"):
            assert not stages[name]["satisfied"]
            assert stages[name].get("blocked") is True
        assert result["complete"] is False
        # And nothing was written.
        assert "layers/chiron_binned" not in snapshot(path)


# --------------------------------------------------------------------------
# Two models on one store
# --------------------------------------------------------------------------


def test_geneformer_leaves_every_tabula_artifact_alone(cellxgene_store):
    apply_recipe(cellxgene_store, RECIPES["tabula"], None, LOG)
    before = snapshot(cellxgene_store)
    before_tabula = tabula_keys(before)
    before_source = source_keys(before)

    result = apply_recipe(cellxgene_store, RECIPES["geneformer"], None, LOG)
    assert result["stages"]["rank_ordering"]["satisfied"], result["stages"]

    after = snapshot(cellxgene_store)
    assert tabula_keys(after) == before_tabula
    assert source_keys(after) == before_source
    assert geneformer_keys(after), "the ordering was not written"


def test_tabula_leaves_the_geneformer_ordering_alone(cellxgene_store):
    apply_recipe(cellxgene_store, RECIPES["geneformer"], None, LOG)
    before = geneformer_keys(snapshot(cellxgene_store))
    before_state = state(cellxgene_store, "geneformer")

    apply_recipe(cellxgene_store, RECIPES["tabula"], None, LOG)

    assert geneformer_keys(snapshot(cellxgene_store)) == before
    assert state(cellxgene_store, "geneformer") == before_state


def test_the_two_recipes_share_no_key(cellxgene_store):
    """Structural, not conventional. If this holds, no ordering of the two can
    make one overwrite the other, whatever either does later."""
    apply_recipe(cellxgene_store, RECIPES["tabula"], None, LOG)
    apply_recipe(cellxgene_store, RECIPES["geneformer"], None, LOG)

    snap = snapshot(cellxgene_store)
    assert not (set(tabula_keys(snap)) & set(geneformer_keys(snap)))

    tabula_attrs = {k for k in attrs(cellxgene_store) if k.startswith("chiron_")
                    and "geneformer" not in k}
    gene_attrs = {k for k in attrs(cellxgene_store) if "geneformer" in k}
    assert not (tabula_attrs & gene_attrs)


def test_changing_tabula_s_filter_does_not_touch_geneformer(cellxgene_store):
    apply_recipe(cellxgene_store, RECIPES["geneformer"], None, LOG)
    apply_recipe(cellxgene_store, RECIPES["tabula"], {"min_cells_per_gene": 60}, LOG)
    before = geneformer_keys(snapshot(cellxgene_store))

    apply_recipe(cellxgene_store, RECIPES["tabula"], {"min_cells_per_gene": 150}, LOG)

    assert geneformer_keys(snapshot(cellxgene_store)) == before


def test_geneformer_is_idempotent_under_this_protocol(cellxgene_store):
    """The request's own wording: a dataset preprocessed with this protocol
    before should not be processed again."""
    apply_recipe(cellxgene_store, RECIPES["geneformer"], None, LOG)
    before, before_attrs = snapshot(cellxgene_store), attrs(cellxgene_store)

    result = apply_recipe(cellxgene_store, RECIPES["geneformer"], None, LOG)

    assert result["changed"] is False
    assert snapshot(cellxgene_store) == before
    assert attrs(cellxgene_store) == before_attrs


def test_geneformer_s_cell_floor_changes_the_ordering(cellxgene_store):
    apply_recipe(cellxgene_store, RECIPES["geneformer"], None, LOG)
    before = geneformer_keys(snapshot(cellxgene_store))
    empty_before = attrs(cellxgene_store)["chiron_geneformer_n_cells_empty"]

    apply_recipe(
        cellxgene_store,
        RECIPES["geneformer"],
        {"geneformer_min_genes_per_cell": 400},
        LOG,
    )

    assert geneformer_keys(snapshot(cellxgene_store)) != before
    assert attrs(cellxgene_store)["chiron_geneformer_n_cells_empty"] > empty_before


# --------------------------------------------------------------------------
# The request path
# --------------------------------------------------------------------------


def _data_dir_with(tmp_path, store_builder, dataset_id="demo"):
    """A data directory shaped the way the data server expects one."""
    data_dir = tmp_path / "data"
    dataset_dir = data_dir / dataset_id
    dataset_dir.mkdir(parents=True)
    (dataset_dir / "manifest.yaml").write_text(
        f"id: {dataset_id}\nname: Demo\nauthorized_users:\n- '*'\n"
    )
    store_builder(dataset_dir / "demo.zarr")
    return data_dir, dataset_dir


def _write_request(data_dir, dataset_id, family, params, request_id="req-1"):
    """What the manager writes through bioengine's /save endpoint."""
    user_dir = data_dir / "saved" / "someone"
    user_dir.mkdir(parents=True, exist_ok=True)
    name = f"{PREP_REQUEST_PREFIX}{dataset_id}-{family}.json"
    (user_dir / name).write_text(
        json.dumps(
            {
                "request_id": request_id,
                "dataset_id": dataset_id,
                "model_family": family,
                "params": params,
            }
        )
    )
    return user_dir / (PREP_STATUS_PREFIX + name[len(PREP_REQUEST_PREFIX):])


def test_a_request_is_applied_and_its_status_written(tmp_path):
    data_dir, dataset_dir = _data_dir_with(tmp_path, _write_synthetic)
    status_file = _write_request(data_dir, "demo", "tabula", {"min_cells_per_gene": 40})

    convert_anndata_to_zarr(str(data_dir))

    assert status_file.exists(), "the data server wrote no status back"
    status = json.loads(status_file.read_text())
    assert status["state"] == "done", status
    assert status["request_id"] == "req-1"
    assert status["fingerprint"]
    assert "demo.zarr" in status["stores"]

    store = dataset_dir / "demo.zarr"
    assert attrs(store)["chiron_qc_min_cells_per_gene"] == 40


def test_a_handled_request_is_not_applied_twice(tmp_path):
    data_dir, _ = _data_dir_with(tmp_path, _write_synthetic)
    status_file = _write_request(data_dir, "demo", "tabula", {"min_cells_per_gene": 40})

    convert_anndata_to_zarr(str(data_dir))
    first = status_file.read_text()
    convert_anndata_to_zarr(str(data_dir))

    assert status_file.read_text() == first


def test_the_periodic_scan_does_not_revert_a_requested_threshold(tmp_path):
    """The scan runs every thirty seconds. If it re-applied defaults it would
    undo an organiser's setting within half a minute, and the store would look
    correct the whole time."""
    data_dir, dataset_dir = _data_dir_with(tmp_path, _write_synthetic)
    _write_request(data_dir, "demo", "tabula", {"min_cells_per_gene": 40})

    convert_anndata_to_zarr(str(data_dir))
    store = dataset_dir / "demo.zarr"
    after_request = snapshot(store)

    convert_anndata_to_zarr(str(data_dir))  # the next poll
    convert_anndata_to_zarr(str(data_dir))  # and the one after that

    assert attrs(store)["chiron_qc_min_cells_per_gene"] == 40
    assert snapshot(store) == after_request


def test_a_request_for_an_unknown_dataset_reports_why(tmp_path):
    data_dir, _ = _data_dir_with(tmp_path, _write_synthetic)
    status_file = _write_request(data_dir, "nope", "tabula", {})

    convert_anndata_to_zarr(str(data_dir))

    status = json.loads(status_file.read_text())
    assert status["state"] == "error"
    assert "no dataset 'nope'" in status["error"]
    assert "demo" in status["error"], "it should say what the site does hold"


def test_a_request_with_a_bad_parameter_reports_why(tmp_path):
    data_dir, _ = _data_dir_with(tmp_path, _write_synthetic)
    status_file = _write_request(data_dir, "demo", "tabula", {"n_hvg": 10})

    convert_anndata_to_zarr(str(data_dir))

    status = json.loads(status_file.read_text())
    assert status["state"] == "error"
    assert "n_hvg is fixed" in status["error"]


def test_a_request_for_an_unknown_model_reports_why(tmp_path):
    data_dir, _ = _data_dir_with(tmp_path, _write_synthetic)
    status_file = _write_request(data_dir, "demo", "scgpt", {})

    convert_anndata_to_zarr(str(data_dir))

    status = json.loads(status_file.read_text())
    assert status["state"] == "error"
    assert "scgpt" in status["error"]


def test_a_fresh_scan_prepares_tabula_by_default(tmp_path):
    """What this server did before recipes existed, and what every site's
    prepared data already expects."""
    data_dir, dataset_dir = _data_dir_with(tmp_path, _write_synthetic)

    convert_anndata_to_zarr(str(data_dir))

    store = dataset_dir / "demo.zarr"
    assert state(store, "tabula")["stages"]["quality_control"]["satisfied"]
    assert not state(store, "geneformer")


def test_the_schema_the_manager_will_serve_is_json_safe():
    for recipe in RECIPES.values():
        described = recipe.describe()
        json.dumps(described)  # raises if anything is not serialisable
        assert described["defaults"] == resolve_params(recipe)


# --------------------------------------------------------------------------
# Regressions found by review
#
# Every test below corresponds to a defect the suite above did not catch. They
# are grouped rather than scattered because what they have in common is the
# point: each one was invisible to a test that looked like it covered the area.
# --------------------------------------------------------------------------


def test_the_rescan_keeps_a_prepared_store_current(tmp_path, monkeypatch):
    """A prepared store must keep tracking the code, not freeze.

    The recorded parameter block holds EVERY parameter, including the ones the
    recipe declares fixed, and the rescan feeds that block back in to re-apply
    at the settings the store was prepared with. Rejecting a fixed name
    unconditionally made that round trip fail, so from the second scan onward
    every prepared store errored and silently stopped being updated. The store
    still looked prepared, which is worse than looking unprepared.

    "Does not revert a threshold" cannot see this, because a refresh that never
    runs also never reverts anything.
    """
    from chiron.datasets import __main__ as server

    data_dir, dataset_dir = _data_dir_with(tmp_path, _write_synthetic)
    _write_request(data_dir, "demo", "tabula", {"min_cells_per_gene": 40})
    convert_anndata_to_zarr(str(data_dir))
    store = dataset_dir / "demo.zarr"
    before = state(store, "tabula")["stages"]["binning"]["fingerprint"]

    # The code moves, the way a version bump moves it.
    bumped = tuple(
        server.Stage(
            name=s.name,
            version=s.version + 1 if s.name == "binning" else s.version,
            label=s.label,
            description=s.description,
            run=s.run,
            requires=s.requires,
            params=s.params,
            outputs=s.outputs,
        )
        for s in server.RECIPES["tabula"].stages
    )
    monkeypatch.setitem(
        server.RECIPES,
        "tabula",
        server.Recipe(
            model_family="tabula",
            version=server.TABULA_RECIPE.version,
            label="Tabula",
            description="",
            stages=bumped,
        ),
    )

    convert_anndata_to_zarr(str(data_dir))

    after = state(store, "tabula")["stages"]["binning"]["fingerprint"]
    assert after != before, (
        "the rescan did not recompute a stage whose version moved, so a "
        "prepared store has stopped tracking the code"
    )
    # And the organiser's threshold is still the one in force.
    assert attrs(store)["chiron_qc_min_cells_per_gene"] == 40


def test_no_gene_quality_control_excluded_is_in_the_panel(tmp_path):
    """Capping the COUNT of selected genes is not constraining membership.

    Excluded genes score zero, and when fewer genes have a strictly positive
    score than there are slots, the ranking fills the rest by tie-breaking
    across the zero-score genes, which are exactly the ones quality control
    removed. The trainer then reads columns of a gene set the filter excluded.

    The store is built to guarantee the condition rather than by hunting for a
    threshold that happens to produce it. A block of genes is expressed ONLY in
    the shallow cells, so those genes pass the gene filter on cell count and
    then have no cell left to be scored across once the cell filter runs.
    """
    # Three blocks of genes, and the ORDER of them is load-bearing.
    #
    # A, at the lowest column indices: detected in only 100 cells, so the gene
    #    filter excludes them. Their score is forced to zero.
    # B: broadly expressed in the deep cells, so they survive and score.
    # C: expressed only in the shallow cells, which the cell filter drops. They
    #    pass the gene filter on cell count and then have no cell left to be
    #    scored across, so their score is zero too.
    #
    # 1,400 genes pass the gene filter, so the cap does not bite and the model
    # asks for 1,200. Only 800 of them can be scored, which leaves 400 slots
    # for the ranking to fill from the zero-score genes. Those ties break by
    # column index, and A sits at the lowest ones, so A wins them.
    rng = np.random.default_rng(7)
    n_excluded, n_scored, n_ghost = 200, 800, 600
    n_shallow, n_deep = 600, 600
    n_cells = n_shallow + n_deep
    n_genes = n_excluded + n_scored + n_ghost
    dense = np.zeros((n_cells, n_genes), dtype=np.float32)
    dense[n_shallow:n_shallow + 100, :n_excluded] = rng.integers(
        1, 30, size=(100, n_excluded)
    )
    dense[n_shallow:, n_excluded:n_excluded + n_scored] = (
        rng.random((n_deep, n_scored)) < 0.9
    ) * rng.integers(1, 30, size=(n_deep, n_scored))
    dense[:n_shallow, n_excluded + n_scored:] = (
        rng.random((n_shallow, n_ghost)) < 0.5
    ) * rng.integers(1, 30, size=(n_shallow, n_ghost))

    adata = ad.AnnData(X=sp.csr_matrix(dense))
    adata.var_names = [f"GENE{i:05d}" for i in range(n_genes)]
    adata.obs_names = [f"CELL{i:05d}" for i in range(n_cells)]
    path = tmp_path / "ghosts.zarr"
    adata.write_zarr(path)

    apply_recipe(path, RECIPES["tabula"], {"min_genes_per_cell": 500}, LOG)
    root = zarr.open_group(str(path), mode="r")
    cell_mask = np.asarray(root["obs"]["chiron_qc_cell_mask"][:], dtype=bool)
    gene_mask = np.asarray(root["var"]["chiron_qc_gene_mask"][:], dtype=bool)
    score = np.asarray(root["var"]["chiron_hvg_score"][:])
    selected = np.asarray(root["var"]["chiron_hvg_selected"][:], dtype=bool)

    assert not cell_mask[:n_shallow].any(), "the shallow cells were not dropped"
    assert int((~gene_mask).sum()) > 0, "the gene filter excluded nothing"
    n_scorable = int((score > 0).sum())
    assert n_scorable < min(1200, int(gene_mask.sum())), (
        "there are at least as many scorable genes as slots, so the ranking "
        "never has to break a zero-score tie and this test proves nothing"
    )

    leaked = int((selected & ~gene_mask).sum())
    assert leaked == 0, (
        f"{leaked} genes quality control excluded are in the model's panel"
    )
    assert selected.sum() > 0, "nothing was selected, so this proves nothing"


def test_the_histogram_edges_are_fixed_and_hold_no_measurement(synthetic_store):
    """A data-derived bin edge is a data point.

    The lowest edge of a data-derived grid IS the exact value of one cell or
    one gene in this dataset, and the highest is another's. Sending only bin
    counts and then sending those two as the axis sends two per-cell
    measurements out of the site under the name of a label.
    """
    from chiron.datasets.__main__ import QC_HIST_EDGES, HVG_SCORE_HIST_EDGES

    apply_recipe(synthetic_store, RECIPES["tabula"], None, LOG)
    a = attrs(synthetic_store)

    assert a["chiron_qc_detected_per_cell_edges"] == list(QC_HIST_EDGES)
    assert a["chiron_qc_cells_per_gene_edges"] == list(QC_HIST_EDGES)

    # The HVG scores get their own grid: over-dispersion sits mostly below 1,
    # so the count grid would clip most genes into the first bin.
    expected_log10 = [float(np.log10(e)) for e in HVG_SCORE_HIST_EDGES]
    recorded = a["chiron_hvg_histogram_edges_log10"]
    assert len(recorded) == len(expected_log10)
    assert np.allclose(recorded, expected_log10)
    assert min(HVG_SCORE_HIST_EDGES) < 1.0, (
        "the score grid starts at or above 1, so it cannot represent the "
        "genes that vary less than Poisson noise"
    )


def test_the_histogram_counts_every_observation(synthetic_store):
    """An edge that overshoots the minimum through floating point drops every
    value tied at it, which on a cells-per-gene distribution is thousands."""
    apply_recipe(synthetic_store, RECIPES["tabula"], None, LOG)
    a = attrs(synthetic_store)
    root = zarr.open_group(str(synthetic_store), mode="r")
    n_vars = int(root["var"]["_index"].shape[0])

    binned = sum(a["chiron_qc_cells_per_gene_counts"])
    zeros = a["chiron_qc_cells_per_gene_zero"]
    assert binned + zeros == n_vars, (
        f"{n_vars - binned - zeros} genes fell outside every bin"
    )


def test_an_artifact_no_reader_can_see_is_not_a_satisfied_stage(
    synthetic_store, monkeypatch
):
    """The one error this pipeline must not swallow.

    A store whose consolidated index could not be rebuilt has its artifact on
    disk and invisible to every reader. Recording that as satisfied leaves the
    store advertising a preparation that is not there.
    """
    import zarr as zarr_module

    def refuse(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(zarr_module, "consolidate_metadata", refuse)
    result = apply_recipe(synthetic_store, RECIPES["tabula"], None, LOG)

    assert not result["stages"]["quality_control"]["satisfied"]
    assert "invisible" in result["stages"]["quality_control"]["reason"]
    assert result["complete"] is False


def test_the_embedding_refuses_rather_than_drawing_excluded_cells(
    synthetic_store,
):
    """A missing mask means quality control did not run, not that it kept
    everything. Empty droplets cluster, so embedding them would show the
    operator a confident blob the run will never see."""
    apply_recipe(synthetic_store, RECIPES["tabula"], None, LOG)
    root = zarr.open_group(str(synthetic_store), mode="r+")
    del root["obs"]["chiron_qc_cell_mask"]
    zarr.consolidate_metadata(root.store)

    from chiron.datasets.__main__ import _ensure_umap_embedding

    result = _ensure_umap_embedding(synthetic_store, {}, LOG)
    assert result.refused and "cell mask" in result.refused


def test_geneformers_cell_floor_works_on_a_dense_store(tmp_path):
    """The only knob the Geneformer recipe exposes assumed a sparse matrix."""
    if not CELLXGENE_H5AD.exists():
        pytest.skip(f"{CELLXGENE_H5AD} not present")
    adata = ad.read_h5ad(CELLXGENE_H5AD)[:150].copy()
    adata.X = np.asarray(adata.X.todense())
    path = tmp_path / "dense.zarr"
    adata.write_zarr(path)

    result = apply_recipe(
        path, RECIPES["geneformer"], {"geneformer_min_genes_per_cell": 400}, LOG
    )
    stage = result["stages"]["rank_ordering"]
    assert stage["satisfied"], stage.get("reason")
    assert stage["stats"]["n_cells_empty"] > 0


def test_a_failed_request_can_be_retried_unchanged(tmp_path):
    """The request id is a digest of what was asked for, so a retry of a
    request that failed for an external reason is the same request. Treating it
    as already handled made it unfixable without changing a parameter the
    operator does not want to change."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    status_file = _write_request(data_dir, "demo", "tabula", {"min_cells_per_gene": 40})

    convert_anndata_to_zarr(str(data_dir))
    assert json.loads(status_file.read_text())["state"] == "error"

    # The operator stages the dataset and presses Apply again, unchanged.
    dataset_dir = data_dir / "demo"
    dataset_dir.mkdir()
    (dataset_dir / "manifest.yaml").write_text(
        "id: demo\nname: Demo\nauthorized_users:\n- '*'\n"
    )
    _write_synthetic(dataset_dir / "demo.zarr")

    convert_anndata_to_zarr(str(data_dir))

    status = json.loads(status_file.read_text())
    assert status["state"] == "done", status
    assert attrs(dataset_dir / "demo.zarr")["chiron_qc_min_cells_per_gene"] == 40
