"""The Chiron data server.

Scans a site's data directory, converts AnnData files to zarr, and precomputes
the artifacts the dataset card and the trainers read. Model-agnostic on
purpose: it is installed into chiron-base and therefore ends up in every model
image, so it must not import any foundation model's code.

Run as `python -m chiron.datasets --data-dir /data`.
"""

import argparse
import os
import sys
import threading
import time
from pathlib import Path

import anndata as ad
import numpy as np
import zarr
from bioengine.datasets.proxy_server import start_proxy_server
from bioengine.utils import create_logger

# Set zarr format to v3
ad.settings.zarr_write_format = 3

ZARR_POLL_INTERVAL = 30  # seconds

# The model's input sequence length, read once at process startup. The binned
# layer and the HVG selection mask are both cut to this width, so it is the one
# number this server has to share with whatever model is going to train on the
# result.
#
# It arrives as an environment variable rather than being read out of a model's
# config file, because this package is model-agnostic and lives in a different
# repository from any model. The image that ships a model sets it (see the
# CHIRON_HVG_IN_FEATURE ENV in each model's Dockerfile) and is responsible for
# keeping it equal to what that model declares. chiron-tabula asserts it against
# tabula/framework.yaml at build time so the two cannot drift apart silently.
#
# To change the width without leaving stale zarrs on disk:
#   1. Change it in the model image and rebuild.
#   2. Bump HVG_VERSION and BINNING_VERSION below so existing zarrs are
#      re-cut on the next scan (otherwise the version idempotence check
#      skips them and the on-disk binned layer keeps the old width).
#   3. Restart every Chiron worker.
MODEL_IN_FEATURE_ENV = "CHIRON_HVG_IN_FEATURE"
MODEL_IN_FEATURE_DEFAULT = 1200


def _read_model_in_feature() -> int:
    raw = os.environ.get(MODEL_IN_FEATURE_ENV)
    if not raw:
        return MODEL_IN_FEATURE_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        return MODEL_IN_FEATURE_DEFAULT
    # A non-positive width would silently produce an empty binned layer, which
    # reads downstream as "this dataset has no genes" rather than as a
    # misconfiguration. Prefer the default and let the log say so.
    return value if value > 0 else MODEL_IN_FEATURE_DEFAULT


MODEL_IN_FEATURE = _read_model_in_feature()

# Every artifact this server writes is namespaced. The names used to carry a
# `tabula_` prefix, from when this code lived in the tabula package, and
# datasets prepared at every institution still carry them on disk. Renaming
# without a fallback would invalidate all of that, so writes use the current
# prefix and every read accepts either, current name first. Nothing has to be
# re-prepared, and a dataset that is recomputed for an unrelated reason drops
# its legacy keys on the way through.
KEY_PREFIX = "chiron_"
LEGACY_KEY_PREFIX = "tabula_"


def _legacy_key(name: str) -> str:
    """The pre-rename name for one of this module's keys."""
    if name.startswith(KEY_PREFIX):
        return LEGACY_KEY_PREFIX + name[len(KEY_PREFIX):]
    return name


def _read_attr(root, name, default=None):
    """A root attribute, falling back to its pre-rename name."""
    if name in root.attrs:
        return root.attrs[name]
    return root.attrs.get(_legacy_key(name), default)


def _find_key(root, container: str, name: str):
    """The name under `root[container]` that holds `name`, or None.

    Prefers the current name and falls back to the pre-rename one, so a zarr
    written by an older data server reads without being recomputed. Returns
    None when the container itself is absent, which is the common case for a
    dataset that has not been through this server yet.
    """
    if container not in root:
        return None
    group = root[container]
    if name in group:
        return name
    legacy = _legacy_key(name)
    return legacy if legacy in group else None


def _drop_legacy_key(root, container: str, name: str) -> None:
    """Remove the pre-rename copy of a key we have just rewritten.

    Called only on the recompute path. Leaving it would give the zarr two
    versions of the same artifact, and readers prefer the current name, so the
    stale one would never be noticed until somebody read it directly.
    """
    legacy = _legacy_key(name)
    if legacy == name or container not in root:
        return
    group = root[container]
    if legacy in group:
        try:
            del group[legacy]
        except Exception:
            pass

# The HVG ranking is written into each zarr's var/ group so the trainer
# and the Chiron UI can both reason about gene variability. The rank covers
# all n_vars genes, computed on the full expression matrix. On top of the
# full rank we also write a boolean selection mask that picks the top
# MODEL_IN_FEATURE genes: this is the contract the trainer reads against the
# pre-cut binned layer, and it lets the data server reproduce the
# manuscript's 1200-HVG preprocessing without giving operators a knob they
# could tune. Whatever cell- or gene-level quality control the site operator
# applies upstream of Chiron is preserved untouched.
HVG_VERSION = 4  # bumped 3 -> 4: HVG scored on full matrix, no internal QC filter
# Plain over-dispersion: variance / mean. For NB-distributed counts (raw single
# cell) a value > 1 means the gene varies more than Poisson noise predicts,
# which is the classical "highly variable" signal. Works on raw counts and on
# the binned/normalised matrices Chiron training feeds the model. Library-size
# normalisation (CP10k) was tried first but its rescaling washes out the
# biological signal of genes whose expression covaries with library depth.
HVG_METHOD = "dispersion_var_over_mean"
HVG_RANK_KEY = "chiron_hvg_rank"
HVG_SCORE_KEY = "chiron_hvg_score"
HVG_SELECTED_KEY = "chiron_hvg_selected"  # bool, length n_vars, under var/

# Compressed histogram of HVG scores so the dataset card can render a sparkline
# without sending one float per gene. 20 log-spaced bins is enough to see the
# long-tail shape; covers >0 scores only (the data-server zeros out all-zero
# genes so they never enter the histogram).
HVG_HIST_VERSION = 2  # bumped: counts are now a root attr, not a compressed chunked array
HVG_HIST_KEY = "chiron_hvg_histogram_counts"  # legacy var/ name kept for cleanup of older zarrs
HVG_HIST_BINS = 20

# Streaming IncrementalPCA -> UMAP gives the dataset card a 2-D embedding the
# data-server can compute on first read with bounded memory regardless of
# dataset size. PCA acts as a denoiser + dimensionality reducer so the UMAP
# step only ever sees n_cells x N_PC instead of n_cells x n_vars. The PCA +
# UMAP run on the pre-cut binned layer (all cells x top MODEL_IN_FEATURE
# HVGs), so the dataset card shows the operator exactly the matrix the
# trainer consumes.
UMAP_VERSION = 3  # bumped 2 -> 3: binned layer now covers all cells (no internal QC)
UMAP_METHOD = "incrementalpca50+umap"
UMAP_COORDS_KEY = "chiron_umap_coords"
UMAP_INDICES_KEY = "chiron_umap_indices"
UMAP_N_NEIGHBORS = 15
UMAP_RANDOM_STATE = 0
UMAP_MAX_SAMPLES = 50_000
PCA_N_COMPONENTS = 50
PCA_BATCH_BYTES_BUDGET = 256 * 1024 * 1024   # 256 MB / batch is generous

# Per-cell value binning. Each cell's non-zero expression values are sorted and
# assigned a bin index 1..BINNING_N_BINS by equal-frequency quantiles; zeros
# stay at bin 0. The binned layer is pre-cut to (n_cells, n_selected_genes)
# where n_selected_genes = min(MODEL_IN_FEATURE, n_vars), giving the trainer
# the same model-ready matrix shape the manuscript's value-binning + 1200-HVG
# preprocessing produces. Cell-level filtering is left to whatever the site
# operator does upstream.
BINNING_VERSION = 3  # bumped 2 -> 3: layer covers all cells (no internal QC)
BINNING_N_BINS = 50
BINNING_LAYER_KEY = "chiron_binned"  # under layers/


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="BioEngine Datasets - Privacy-Preserved Data Streaming Service",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Start datasets service (scans for a free port starting from 39527)
  %(prog)s --data-dir /shared/data

  # Explicit port
  %(prog)s --data-dir /shared/data --server-port 39527

For detailed documentation, visit: https://github.com/aicell-lab/bioengine-worker
""",
    )

    parser.add_argument(
        "--data-dir",
        type=str,
        metavar="PATH",
        required=True,
        help="Directory containing dataset subdirectories. Each must have a manifest.yaml "
        "with at minimum an 'id' and 'authorized_users' field. AnnData .h5ad files are "
        "automatically converted to Zarr format on first start and re-checked every 30 s.",
    )
    parser.add_argument(
        "--server-ip",
        type=str,
        metavar="IP_ADDRESS",
        help="IP address for the local file-serving HTTP server.",
    )
    parser.add_argument(
        "--server-port",
        type=int,
        metavar="PORT",
        help="Port for the local HTTP server. Defaults to scanning from 39527.",
    )
    parser.add_argument(
        "--authentication-server-url",
        type=str,
        metavar="URL",
        default="https://hypha.aicell.io",
        help="URL of the Hypha server used for token validation (default: https://hypha.aicell.io).",
    )
    parser.add_argument(
        "--log-file",
        type=str,
        metavar="PATH",
        help="Path to the log file. Pass 'off' for console-only logging.",
    )

    return parser


def _compute_per_cell_binning(X, n_bins: int = BINNING_N_BINS) -> np.ndarray:
    """Equal-frequency per-cell quantile binning into n_bins discrete levels.

    For each cell (row of X):
      - zero values are assigned bin 0 (no expression)
      - non-zero values are sorted and assigned bins 1..n_bins by rank
    Tied values share the same bin. Returns a uint8 array with the same shape
    as X. n_bins must be <= 254 so all values fit in uint8 (bin 0 stays
    reserved for zero expression).
    """
    if n_bins >= 255:
        raise ValueError(f"n_bins must be < 255 to fit in uint8 (got {n_bins})")
    if hasattr(X, "toarray"):
        X = X.toarray()
    X = np.asarray(X)
    if X.ndim != 2:
        raise ValueError(f"Expected 2D matrix, got shape {X.shape}")
    n_cells, n_vars = X.shape
    out = np.zeros((n_cells, n_vars), dtype=np.uint8)
    for i in range(n_cells):
        row = X[i]
        nonzero_idx = np.flatnonzero(row > 0)
        if nonzero_idx.size == 0:
            continue
        values = row[nonzero_idx].astype(np.float64)
        order = np.argsort(values, kind="stable")
        ranks = np.empty_like(order)
        ranks[order] = np.arange(values.size)
        # Map rank 0..size-1 onto 1..n_bins (equal-frequency).
        bin_idx = (ranks * n_bins // values.size).clip(0, n_bins - 1) + 1
        out[i, nonzero_idx] = bin_idx.astype(np.uint8)
    return out


def _ensure_binning(zarr_path: Path, logger) -> bool:
    """Write layers/chiron_binned into the zarr.

    Shape is (n_cells, n_selected_genes) where n_selected_genes =
    min(MODEL_IN_FEATURE, n_vars). This is the trainer-ready view of the
    data so the trainer can stream a row at a time and feed it straight
    into the model without any column or row reshaping. Requires the HVG
    selection mask to have been written first; cell-level filtering is
    left to whatever the site operator did upstream.

    Idempotent on BINNING_VERSION. Returns True if a write occurred.
    """
    try:
        root = zarr.open_group(str(zarr_path), mode="r+")
    except Exception as e:
        logger.warning(f"Cannot open {zarr_path.name} for binning: {e}")
        return False

    existing_version = _read_attr(root, "chiron_binning_version")
    has_binned = _find_key(root, "layers", BINNING_LAYER_KEY) is not None
    if existing_version == BINNING_VERSION and has_binned:
        return False

    # Need HVG selection upstream of binning.
    selected_key = _find_key(root, "var", HVG_SELECTED_KEY)
    if selected_key is None:
        logger.warning(
            f"{zarr_path.name}: HVG selection mask missing; binning skipped "
            f"(run HVG rank first)"
        )
        return False

    try:
        adata = ad.read_zarr(zarr_path)
    except Exception as e:
        logger.warning(f"{zarr_path.name}: cannot read as AnnData for binning: {e}")
        return False
    if adata.n_obs == 0 or adata.n_vars == 0:
        return False

    selected_mask = root["var"][selected_key][:]
    if not selected_mask.any():
        logger.warning(
            f"{zarr_path.name}: HVG selection is empty; binning skipped"
        )
        return False

    # All cells, top-n_selected genes. Densification happens inside
    # _compute_per_cell_binning if X is sparse.
    sub_X = adata[:, selected_mask].X
    binned = _compute_per_cell_binning(sub_X, n_bins=BINNING_N_BINS)

    layers_group = root["layers"] if "layers" in root else root.create_group("layers")
    arr = layers_group.create_array(
        BINNING_LAYER_KEY,
        shape=binned.shape,
        dtype=binned.dtype,
        overwrite=True,
    )
    arr[:] = binned
    _drop_legacy_key(root, "layers", BINNING_LAYER_KEY)
    root.attrs["chiron_binning_version"] = BINNING_VERSION
    root.attrs["chiron_binning_n_bins"] = BINNING_N_BINS
    root.attrs["chiron_binning_n_cells"] = int(binned.shape[0])
    root.attrs["chiron_binning_n_genes"] = int(binned.shape[1])

    try:
        zarr.consolidate_metadata(root.store)
    except Exception as e:
        logger.warning(f"{zarr_path.name}: consolidate_metadata failed after binning: {e}")

    logger.info(
        f"{zarr_path.name}: wrote per-cell {BINNING_N_BINS}-bin discretisation "
        f"({binned.shape[0]} cells x {binned.shape[1]} selected HVGs)"
    )
    return True


def _compute_hvg_score(X) -> np.ndarray:
    """Per-gene over-dispersion score (variance / mean) for ranking.

    Dependency-free (numpy only). For Poisson-distributed counts the expected
    variance equals the mean, so variance / mean ≈ 1 for baseline genes and
    > 1 for genes that vary more than chance. Genes with all-zero counts get
    score 0 (they rank last; safe to filter or ignore downstream).

    Higher score = more variable.

    Args:
        X: (n_cells, n_genes) array-like. May be scipy.sparse or numpy. Will be
           densified into a float64 working copy.

    Returns:
        float32 array of length n_genes.
    """
    if hasattr(X, "toarray"):
        X = X.toarray()
    X = np.asarray(X, dtype=np.float64)
    if X.ndim != 2:
        raise ValueError(f"Expected 2D expression matrix, got shape {X.shape}")
    if X.shape[0] == 0 or X.shape[1] == 0:
        return np.zeros(X.shape[1], dtype=np.float32)

    means = X.mean(axis=0)
    vars_ = X.var(axis=0)
    score = np.where(means > 1e-12, vars_ / (means + 1e-12), 0.0)
    return score.astype(np.float32)


def _ensure_hvg_rank(zarr_path: Path, logger) -> bool:
    """Add var/chiron_hvg_rank + var/chiron_hvg_score to an existing zarr if missing.

    Idempotent: if the rank arrays already exist with the same HVG_VERSION,
    do nothing. Writes directly via the zarr API to avoid rewriting X.

    Returns True if a write occurred, False if skipped.
    """
    try:
        root = zarr.open_group(str(zarr_path), mode="r+")
    except Exception as e:
        logger.warning(f"Cannot open {zarr_path.name} for HVG ranking: {e}")
        return False

    if "var" not in root:
        logger.warning(
            f"{zarr_path.name}: no var/ group; HVG ranking skipped"
        )
        return False

    var_group = root["var"]
    existing_version = _read_attr(root, "chiron_hvg_version")
    has_selected = _find_key(root, "var", HVG_SELECTED_KEY) is not None
    has_rank = _find_key(root, "var", HVG_RANK_KEY) is not None
    if has_rank and existing_version == HVG_VERSION and has_selected:
        return False  # already ranked at the current version

    # Load X (or X_binned fallback) into memory. AnnData's read_zarr handles the
    # var/obs dataframe metadata properly; pulling X via raw zarr also works but
    # would need the same densify logic.
    try:
        adata = ad.read_zarr(zarr_path)
    except Exception as e:
        logger.warning(f"{zarr_path.name}: cannot read as AnnData for HVG: {e}")
        return False

    if adata.n_vars == 0:
        return False

    # Per-gene over-dispersion (variance / mean) across the full expression
    # matrix. Whatever cell- or gene-level filtering the site operator wants
    # to apply is expected upstream of the data-server.
    score = _compute_hvg_score(adata.X)

    # rank 0 = most variable, n_vars-1 = least
    rank = (-score).argsort().argsort().astype(np.int32)

    # Direct zarr writes into var/. We use create_array so the arrays are
    # standalone (not registered in var's pandas-dataframe column index) —
    # the trainer reads them via raw zarr access, which is exactly what we want.
    rank_arr = var_group.create_array(
        HVG_RANK_KEY,
        shape=rank.shape,
        dtype=rank.dtype,
        overwrite=True,
    )
    rank_arr[:] = rank
    score_arr = var_group.create_array(
        HVG_SCORE_KEY,
        shape=score.shape,
        dtype=score.dtype,
        overwrite=True,
    )
    score_arr[:] = score

    # Selection mask the trainer reads to derive per-column gene IDs against
    # the pre-cut binned layer. Picks the top-n_selected genes by rank, where
    # n_selected = min(MODEL_IN_FEATURE, n_vars). All-zero genes have score 0
    # and the highest rank values, so they are deprioritised naturally.
    n_selected = int(min(MODEL_IN_FEATURE, adata.n_vars))
    selected_mask = np.zeros(adata.n_vars, dtype=np.bool_)
    if n_selected > 0:
        selected_mask = (rank < n_selected).astype(np.bool_)
    sel_arr = var_group.create_array(
        HVG_SELECTED_KEY,
        shape=selected_mask.shape,
        dtype=selected_mask.dtype,
        overwrite=True,
    )
    sel_arr[:] = selected_mask

    for key in (HVG_RANK_KEY, HVG_SCORE_KEY, HVG_SELECTED_KEY):
        _drop_legacy_key(root, "var", key)

    root.attrs["chiron_hvg_version"] = HVG_VERSION
    root.attrs["chiron_hvg_method"] = HVG_METHOD
    root.attrs["chiron_hvg_in_feature"] = int(MODEL_IN_FEATURE)
    root.attrs["chiron_hvg_n_selected"] = int(selected_mask.sum())

    # Rebuild the zarr-v3 consolidated metadata so the newly-written arrays
    # appear in subsequent opens. AnnData's writer leaves a consolidated
    # block listing only its own columns; without this call the trainer
    # would not see chiron_hvg_rank/score in var.keys().
    try:
        zarr.consolidate_metadata(root.store)
    except Exception as e:
        logger.warning(
            f"{zarr_path.name}: consolidate_metadata failed; rank arrays may be "
            f"invisible to readers that rely on consolidated metadata: {e}"
        )

    logger.info(
        f"{zarr_path.name}: ranked {len(rank)} genes by HVG ({HVG_METHOD})"
    )
    return True


def _ensure_hvg_histogram(zarr_path: Path, logger) -> bool:
    """Write a 20-bin log-scaled histogram of HVG scores into var/.

    Idempotent on HVG_HIST_VERSION. Requires that _ensure_hvg_rank has already
    run (so var/chiron_hvg_score exists). Stores bin edges as a group attr so
    the UI can render the histogram without re-deriving them.

    Returns True if a write occurred, False if skipped.
    """
    try:
        root = zarr.open_group(str(zarr_path), mode="r+")
    except Exception as e:
        logger.warning(f"Cannot open {zarr_path.name} for HVG histogram: {e}")
        return False

    score_key = _find_key(root, "var", HVG_SCORE_KEY)
    if score_key is None:
        # Score wasn't computed yet (data was empty, or rank step failed).
        return False

    existing = _read_attr(root, "chiron_hvg_histogram_version")
    # Counts live as a root attr since HVG_HIST_VERSION 2, so the version attr
    # alone is the source of truth. (Pre-v2 stored counts under var/, but that
    # path is cleaned up below the first time v2 runs.)
    if existing == HVG_HIST_VERSION:
        return False

    score = root["var"][score_key][:]
    positive = score[score > 0]
    if positive.size == 0:
        # Pathological: every gene has zero score. Skip silently — there's
        # nothing meaningful to histogram.
        return False

    # log10 of positive scores, then equal-width bins between min and max.
    # This concentrates resolution where the bulk of genes live.
    log_scores = np.log10(positive)
    lo, hi = float(log_scores.min()), float(log_scores.max())
    if hi - lo < 1e-9:
        # All positive scores identical — degenerate. Put everything in one bin.
        hi = lo + 1e-9
    edges = np.linspace(lo, hi, HVG_HIST_BINS + 1)
    counts, _ = np.histogram(log_scores, bins=edges)
    counts = counts.astype(np.int32)

    # The histogram is just 20 ints — store it as a JSON-encoded root attribute
    # rather than a chunked zarr array. Attributes ride along in the zarr.json
    # the chiron-manager fetches anyway, so no extra HTTP round-trip and no
    # zstd-chunk-decompression dance on the reader side.
    root.attrs["chiron_hvg_histogram_counts"] = counts.tolist()
    root.attrs["chiron_hvg_histogram_version"] = HVG_HIST_VERSION
    root.attrs["chiron_hvg_histogram_edges_log10"] = edges.astype(np.float32).tolist()

    # Clean up any legacy compressed array from HVG_HIST_VERSION 1, under
    # either the current name or the pre-rename one.
    var_group = root["var"]
    if HVG_HIST_KEY in var_group:
        try:
            del var_group[HVG_HIST_KEY]
        except Exception:
            pass
    _drop_legacy_key(root, "var", HVG_HIST_KEY)

    try:
        zarr.consolidate_metadata(root.store)
    except Exception as e:
        logger.warning(
            f"{zarr_path.name}: consolidate_metadata failed after HVG histogram: {e}"
        )

    logger.info(
        f"{zarr_path.name}: wrote {HVG_HIST_BINS}-bin HVG score histogram"
    )
    return True


def _read_binned_node(root):
    """Return (zarr_array, n_cells, n_selected) for layers/chiron_binned.

    The UMAP step runs on the pre-cut binned layer so the embedding reflects
    exactly what the trainer consumes (all cells x top-MODEL_IN_FEATURE HVGs
    in 0..50 quantile bins). Returns (None, 0, 0) when the layer is missing.
    """
    key = _find_key(root, "layers", BINNING_LAYER_KEY)
    if key is not None:
        candidate = root["layers"][key]
        if isinstance(candidate, zarr.Array):
            return candidate, candidate.shape[0], candidate.shape[1]
    return None, 0, 0


def _streaming_pca_then_umap(zarr_path: Path, root, logger):
    """Inner helper for _ensure_umap_embedding: stream X through IncrementalPCA,
    take a deterministic subsample if n_cells > UMAP_MAX_SAMPLES, run UMAP on
    that subsample.

    Returns (coords float32[m,2], indices int32[m] or None if all cells used),
    or raises if the dataset is too small / a dep is missing.
    """
    # Soft dep — keep the image lean for sites that don't need the embedding.
    try:
        import umap  # noqa: F401  (umap-learn package)
    except ImportError as e:
        raise RuntimeError(
            "umap-learn not installed; UMAP embedding skipped. "
            "Install with: pip install umap-learn"
        ) from e
    from sklearn.decomposition import IncrementalPCA

    x_node, n_cells, n_vars = _read_binned_node(root)
    if x_node is None or n_cells < UMAP_N_NEIGHBORS + 1 or n_vars < 2:
        raise RuntimeError(
            f"Dataset too small for UMAP "
            f"(binned shape n_cells={n_cells}, n_selected={n_vars})"
        )

    # Compute a streaming batch size that respects the byte budget and the
    # IncrementalPCA constraint n_components <= batch_size.
    bytes_per_cell = max(1, n_vars * 4)
    target_batch = max(PCA_N_COMPONENTS + 1, PCA_BATCH_BYTES_BUDGET // bytes_per_cell)
    batch_size = int(min(n_cells, max(PCA_N_COMPONENTS + 1, target_batch)))
    n_components = min(PCA_N_COMPONENTS, n_vars, n_cells - 1)

    logger.info(
        f"{zarr_path.name}: streaming PCA on the binned layer "
        f"(n_cells={n_cells}, n_selected={n_vars}, batch={batch_size}, components={n_components})"
    )

    ipca = IncrementalPCA(n_components=n_components)
    for start in range(0, n_cells, batch_size):
        stop = min(start + batch_size, n_cells)
        if stop - start < n_components:
            # Tail batch can be smaller than n_components; IncrementalPCA would
            # raise. Pad by re-using the previous start.
            start = max(0, n_cells - n_components)
            stop = n_cells
        batch = np.asarray(x_node[start:stop, :], dtype=np.float64)
        ipca.partial_fit(batch)
        if stop == n_cells:
            break

    # Choose the subsample for UMAP.
    rng = np.random.default_rng(UMAP_RANDOM_STATE)
    if n_cells > UMAP_MAX_SAMPLES:
        indices = np.sort(rng.choice(n_cells, size=UMAP_MAX_SAMPLES, replace=False))
    else:
        indices = None  # use all cells

    # Transform subsample (or full) through the PCA fit, in the same batches.
    def transform_indices(idx_array):
        # Reading arbitrary fancy indices from zarr is slow; chunk by contiguous
        # ranges keyed on the sorted indices.
        out = np.empty((len(idx_array), n_components), dtype=np.float32)
        i = 0
        while i < len(idx_array):
            j = i + batch_size
            chunk_idx = idx_array[i:j]
            block = np.asarray(x_node.get_orthogonal_selection((chunk_idx, slice(None))), dtype=np.float64)
            out[i:j] = ipca.transform(block).astype(np.float32)
            i = j
        return out

    if indices is None:
        idx_for_transform = np.arange(n_cells, dtype=np.int64)
    else:
        idx_for_transform = indices
    pca_matrix = transform_indices(idx_for_transform)

    # UMAP. n_neighbors capped at sample_size - 1.
    import umap as _umap_module
    n_neighbors = min(UMAP_N_NEIGHBORS, pca_matrix.shape[0] - 1)
    reducer = _umap_module.UMAP(
        n_components=2,
        n_neighbors=n_neighbors,
        random_state=UMAP_RANDOM_STATE,
        verbose=False,
    )
    embedding = reducer.fit_transform(pca_matrix).astype(np.float32)
    return embedding, (None if indices is None else indices.astype(np.int32))


def _ensure_umap_embedding(zarr_path: Path, logger) -> bool:
    """Write a 2-D UMAP embedding into obsm/, computed on layers/chiron_binned.

    Operates on the pre-cut binned layer (all cells x top-MODEL_IN_FEATURE
    HVGs in 0..50 quantile bins) so the dataset-card UMAP matches what the
    trainer consumes. Requires _ensure_binning to have run first.

    Idempotent on UMAP_VERSION. Computes coordinates only on a deterministic
    subsample if n_cells > UMAP_MAX_SAMPLES so memory stays bounded;
    otherwise uses every cell. Soft-fails if umap-learn isn't installed.

    Stores:
      obsm/chiron_umap_coords  float32 (m, 2)   m = min(n_cells, UMAP_MAX_SAMPLES)
      obsm/chiron_umap_indices int32   (m,)     row indices into chiron_binned,
                                                only present if subsampled
      root attrs: chiron_umap_version, chiron_umap_method, chiron_umap_n_sampled

    Returns True if a write occurred, False if skipped, raises only for
    truly unexpected zarr errors.
    """
    try:
        root = zarr.open_group(str(zarr_path), mode="r+")
    except Exception as e:
        logger.warning(f"Cannot open {zarr_path.name} for UMAP: {e}")
        return False

    existing = _read_attr(root, "chiron_umap_version")
    has_coords = _find_key(root, "obsm", UMAP_COORDS_KEY) is not None
    if existing == UMAP_VERSION and has_coords:
        return False

    try:
        coords, indices = _streaming_pca_then_umap(zarr_path, root, logger)
    except RuntimeError as e:
        # Includes umap-learn-not-installed and "too small" cases — log once
        # and move on. The HVG rank already covers the trainer's needs; UMAP
        # is purely cosmetic for the dataset card.
        logger.warning(f"{zarr_path.name}: UMAP skipped: {e}")
        return False
    except Exception as e:
        logger.warning(f"{zarr_path.name}: UMAP failed: {type(e).__name__}: {e}")
        return False

    # Make sure obsm exists.
    if "obsm" not in root:
        root.create_group("obsm")
    obsm_group = root["obsm"]
    coords_arr = obsm_group.create_array(
        UMAP_COORDS_KEY, shape=coords.shape, dtype=coords.dtype, overwrite=True,
    )
    coords_arr[:] = coords
    if indices is not None:
        idx_arr = obsm_group.create_array(
            UMAP_INDICES_KEY, shape=indices.shape, dtype=indices.dtype, overwrite=True,
        )
        idx_arr[:] = indices
        _drop_legacy_key(root, "obsm", UMAP_INDICES_KEY)
    else:
        # Coords now cover all cells, so any previous indices array is stale,
        # under either the current name or the pre-rename one.
        if UMAP_INDICES_KEY in obsm_group:
            del obsm_group[UMAP_INDICES_KEY]
        _drop_legacy_key(root, "obsm", UMAP_INDICES_KEY)
    _drop_legacy_key(root, "obsm", UMAP_COORDS_KEY)

    root.attrs["chiron_umap_version"] = UMAP_VERSION
    root.attrs["chiron_umap_method"] = UMAP_METHOD
    root.attrs["chiron_umap_n_sampled"] = int(coords.shape[0])
    root.attrs["chiron_umap_n_neighbors"] = int(UMAP_N_NEIGHBORS)
    root.attrs["chiron_umap_random_state"] = int(UMAP_RANDOM_STATE)

    try:
        zarr.consolidate_metadata(root.store)
    except Exception as e:
        logger.warning(
            f"{zarr_path.name}: consolidate_metadata failed after UMAP: {e}"
        )

    logger.info(
        f"{zarr_path.name}: wrote UMAP embedding "
        f"({coords.shape[0]} cells {'(subsampled)' if indices is not None else '(all cells)'}, "
        f"{UMAP_METHOD})"
    )
    return True


def convert_anndata_to_zarr(data_dir: str, log_file: str = None):
    """
    Scan the data directory for AnnData files and convert them to Zarr format,
    then ensure every zarr has an HVG ranking written to its var/ group.

    For each .h5ad file found inside a dataset folder (identified by the presence
    of a manifest.yaml), a .zarr file with the same stem is written alongside it.
    For every zarr (newly-converted or already-existing), an HVG ranking is added
    if missing so the trainer can pick the top-K most variable genes when the
    model's input width is smaller than the dataset's n_vars. The original manifest
    and X matrix are not modified.

    Args:
        data_dir (str): Path to the root data directory to scan for AnnData files.
        log_file (str): Optional path to a log file.
    """
    logger = create_logger("AnnDataToZarrConverter", log_file=log_file)
    _data_dir = Path(data_dir)
    for dataset_dir in _data_dir.iterdir():
        if not (dataset_dir / "manifest.yaml").exists():
            continue

        # 1) Convert any new .h5ad files
        for anndata_file in dataset_dir.glob("*.h5ad"):
            zarr_file = dataset_dir / (anndata_file.stem + ".zarr")
            if not zarr_file.exists():
                logger.info(
                    f"Dataset {dataset_dir.name} - Converting {anndata_file.name} to {zarr_file.name}..."
                )
                adata = ad.read_h5ad(anndata_file)
                adata.write_zarr(zarr_file)

        # 2) Apply Chiron's preprocessing pipeline to every zarr in this
        #    dataset folder. Steps run in dependency order — HVG ranking
        #    first because value binning + UMAP both consume the selection
        #    mask — and each step is independently idempotent on its own
        #    version attr, so re-running this loop only does the missing
        #    work. Cell- and gene-level QC is left to whatever the site
        #    operator does upstream of Chiron.
        for zarr_path in sorted(dataset_dir.glob("*.zarr")):
            for fn, label in (
                (_ensure_hvg_rank,      "HVG ranking"),
                (_ensure_hvg_histogram, "HVG histogram"),
                (_ensure_binning,       "value binning"),
                (_ensure_umap_embedding, "UMAP embedding"),
            ):
                try:
                    fn(zarr_path, logger)
                except Exception as e:
                    logger.warning(
                        f"{label} failed for {zarr_path.name}: "
                        f"{type(e).__name__}: {e}"
                    )


def _zarr_conversion_loop(data_dir: str, log_file: str = None, stop_event: threading.Event = None):
    """Background thread that re-runs convert_anndata_to_zarr every ZARR_POLL_INTERVAL seconds."""
    while not (stop_event and stop_event.is_set()):
        time.sleep(ZARR_POLL_INTERVAL)
        try:
            convert_anndata_to_zarr(data_dir, log_file=log_file)
        except Exception as e:
            logger = create_logger("AnnDataToZarrConverter", log_file=log_file)
            logger.warning(f"Zarr conversion poll failed: {e}")


def _check_environment() -> None:
    """Detect common misconfiguration and fail with a clear message."""
    home = os.environ.get("HOME", "")
    if home.startswith('"') or home.startswith("'"):
        print(
            f"ERROR: HOME environment variable contains a literal quote character: HOME={home!r}\n"
            "       This usually means the docker-compose environment list used quoted values,\n"
            "       e.g.  - HOME=\"/home\"  which sets HOME to the string \"/home\" (with quotes).\n"
            "       Fix: use  - HOME=/home  (no quotes) in the environment: section."
        )
        sys.exit(1)


if __name__ == "__main__":
    _check_environment()
    try:
        parser = create_parser()
        args = parser.parse_args()
        kwargs = {k: v for k, v in vars(args).items() if v is not None}

        log_file = kwargs.get("log_file")
        zarr_log_file = None if log_file == "off" else log_file

        # Initial conversion pass
        convert_anndata_to_zarr(kwargs["data_dir"], log_file=zarr_log_file)

        # Background thread re-checks every 30 s for new .h5ad files
        stop_event = threading.Event()
        t = threading.Thread(
            target=_zarr_conversion_loop,
            args=(kwargs["data_dir"], zarr_log_file, stop_event),
            daemon=True,
        )
        t.start()

        start_proxy_server(**kwargs)

    except Exception as e:
        msg = str(e)
        print(f"Failed to start BioEngine Datasets proxy server: {e}")
        if '"' in msg or "'" in msg:
            home = os.environ.get("HOME", "")
            if home.startswith('"') or home.startswith("'"):
                print(
                    f"Hint: HOME={home!r} contains a literal quote — see the check above."
                )
        sys.exit(1)
