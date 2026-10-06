"""The Chiron data server.

Scans a site's data directory, converts AnnData files to zarr, and precomputes
the artifacts the dataset card and the trainers read. Model-agnostic on
purpose: it is installed into chiron-base and therefore ends up in every model
image, so it must not import any foundation model's code.

Run as `python -m chiron.datasets --data-dir /data`.
"""

import argparse
import hashlib
import os
import pickle
import sys
import tempfile
import threading
import time
import urllib.request
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


# AnnData encodes var/ as a dataframe, and a dataframe group lists its columns
# in a `column-order` attribute. Arrays written into var/ by raw zarr calls are
# not in that list, and each column is also expected to carry the two encoding
# attributes below. Without both, `adata.var` does not show the column at all:
# the data is on disk and invisible to anyone who opens the store the ordinary
# way. These are the values AnnData's own writer uses for a plain numeric or
# boolean column.
_ANNDATA_COLUMN_ENCODING = {
    "encoding-type": "array",
    "encoding-version": "0.2.0",
}


def _register_var_columns(root, names, logger) -> bool:
    """Make raw arrays under var/ visible as columns of `adata.var`.

    The trainer reads these through raw zarr access and does not need them
    registered, which is why they were written as standalone arrays. But that
    left every prepared dataset with an HVG mask that nobody could see from
    anndata, so inspecting a dataset outside Chiron meant reaching into the
    zarr by hand.

    Registers whichever of `names` is present, under its current or pre-rename
    name, and returns True only when something actually changed, so the
    conversion loop can skip the metadata rewrite on the common no-op pass.
    """
    if "var" not in root:
        return False
    var_group = root["var"]
    order = list(var_group.attrs.get("column-order", []))
    registered = []

    for name in names:
        key = _find_key(root, "var", name)
        if key is None:
            continue
        column = var_group[key]
        changed = False
        for attr, value in _ANNDATA_COLUMN_ENCODING.items():
            if column.attrs.get(attr) != value:
                column.attrs[attr] = value
                changed = True
        if key not in order:
            order.append(key)
            changed = True
        if changed:
            registered.append(key)

    if registered:
        var_group.attrs["column-order"] = order
        logger.info("registered var columns: " + ", ".join(registered))
    return bool(registered)


def _ensure_var_columns_visible(zarr_path: Path, logger) -> bool:
    """Pipeline step: register the HVG arrays as var columns.

    Separate from `_ensure_hvg_rank` rather than folded into it, because the
    ranking is idempotent on HVG_VERSION and every dataset already prepared is
    at the current version. Folding this in would fix new datasets only and
    leave every existing one unreadable, for a change that costs no recompute.
    """
    try:
        root = zarr.open_group(str(zarr_path), mode="a")
    except Exception as e:
        logger.warning(f"Cannot open {zarr_path.name} to register var columns: {e}")
        return False

    if not _register_var_columns(
        root, (HVG_RANK_KEY, HVG_SCORE_KEY, HVG_SELECTED_KEY), logger
    ):
        return False

    try:
        zarr.consolidate_metadata(root.store)
    except Exception as e:
        logger.warning(
            f"{zarr_path.name}: consolidate_metadata failed after registering var "
            f"columns, so anndata readers may still not see the HVG mask: {e}"
        )
    return True


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
# Quality control, stage 2 of the manuscript's pipeline and the step that has
# to run before HVG selection rather than after it. The Methods are explicit
# about the order: "we identified 1,200 highly variable genes (HVGs) within
# each dataset after quality control".
#
# Masks only. Writing a filtered copy of X would make this server's output
# specific to one model's preprocessing, which is the thing the per-model
# design exists to avoid. A mask costs one bit per cell and per gene, leaves
# the source readable by a model that wants the full panel, and lets a reader
# see what was excluded instead of only what survived.
QC_VERSION = 1
QC_MIN_GENES_PER_CELL = 250
QC_MIN_CELLS_PER_GENE = 250
QC_CELL_MASK_KEY = "chiron_qc_cell_mask"  # bool, length n_obs, under obs/
QC_GENE_MASK_KEY = "chiron_qc_gene_mask"  # bool, length n_vars, under var/

# A store can arrive already reduced to some model's gene panel, and the
# pipeline below must not treat it as raw. The failure mode is silent rather
# than loud, which is why this is detected explicitly rather than left to
# whoever reads the numbers afterwards.
#
# "Drop cells with fewer than 250 detected genes" is defined against a full
# panel of roughly 20,000 genes, where it removes empty droplets and degraded
# cells. Against a store already cut to 1,200 highly variable genes the same
# threshold removes most of the real cells: measured on the blood shard of the
# 1M corpus it drops 178,970 of 250,000, or 71.6 per cent. The manuscript's
# order is quality control first and HVG selection second, so a store that has
# already been reduced is past the point where the cell filter means anything.
#
# The same applies to selecting 1,200 HVGs out of 1,200 genes, which is a
# no-op that would nonetheless overwrite an upstream selection with one scored
# on a different matrix.
UPSTREAM_REDUCED_KEY = "chiron_upstream_reduced"
UPSTREAM_REDUCED_WHY_KEY = "chiron_upstream_reduced_reason"


def _detect_upstream_reduction(root, n_vars: int):
    """Why this store already looks reduced to a model panel, or None if raw.

    Any one signal is sufficient. They are checked in descending order of how
    directly they say "a selection has already happened here", and the first
    match is returned so the recorded reason names the strongest evidence
    rather than an incidental one.
    """
    if _find_key(root, "var", "highly_variable") is not None:
        return "var/highly_variable is present, so a selection was already applied upstream"
    if "layers" in root and _find_key(root, "layers", "X_binned") is not None:
        return "layers/X_binned is present, so values were already discretised upstream"
    if n_vars <= MODEL_IN_FEATURE:
        return (
            f"n_vars={n_vars} is not above the model panel width "
            f"{MODEL_IN_FEATURE}, so this store is already a selected panel "
            "rather than a full gene set"
        )
    return None


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

# ---------------------------------------------------------------------------
# Geneformer rank-value preprocessing
# ---------------------------------------------------------------------------
#
# Geneformer does not read expression values at all. It reads an ORDER: a cell
# is the list of genes it expresses, sorted by that gene's count divided by the
# gene's median across Geneformer's reference corpus. Dividing by the median is
# what makes the order comparable between cells and between sequencing depths,
# because a gene ranks early when it is high *for that gene* rather than high
# in absolute terms.
#
# Nothing in Tabula's pipeline is a step toward that and nothing here is a step
# toward Tabula's. Tabula bins values over a fixed 1,200-gene panel, Geneformer
# throws the values away and keeps an order over a variable-length gene set, and
# neither output can be derived from the other. That is the whole reason the two
# are written to different places in the store and share no key: coexistence has
# to be structural, not a convention somebody remembers to follow.
#
# What is precomputed here is the normalisation and the ordering, and
# deliberately not the tokens. The order is stored as column indices into var,
# so the trainer still maps through its own token dictionary and still truncates
# to whatever input width the checkpoint it is about to train declares. One
# stored artifact therefore serves both Geneformer generations' input widths,
# and the vocabulary stays where the model is.
#
# The dictionaries are model *data*, not model code, so fetching them does not
# cross the line this module's docstring draws. They are pinned by revision and
# verified by digest before unpickling, because pickle.load executes arbitrary
# code and the digest is the only thing between a tampered download and this
# process. Never relax that to a size or mtime check.
#
# These pins are deliberately identical to the ones in the Geneformer trainer's
# apps/geneformer_trainer/dataset.py. If the two ever drift, the server
# precomputes an order against one corpus and the trainer trains against
# another, which produces no error anywhere and which FedAvg cannot see.
GENEFORMER_VERSION = 1
GENEFORMER_REVISION = "04c2b2e84da7c0f385c3f9ad8f3ec24bab6650e5"
GENEFORMER_DICTIONARY_SET = "gc104M"
GENEFORMER_DICTIONARIES = {
    "token_dictionary_gc104M.pkl":
        "67c445f4385127adfc48dcc072320cd65d6822829bf27dd38070e6e787bc597f",
    "gene_median_dictionary_gc104M.pkl":
        "a51c53f6a771d64508dfaf61529df70e394c53bd20856926117ae5d641a24bf5",
}
GENEFORMER_HF_URL = (
    "https://huggingface.co/ctheodoris/Geneformer/resolve/{revision}/geneformer/{name}"
)

# The widest input any Geneformer checkpoint accepts: 4,096 positions for
# V2-104M, 2,048 for V1-10M, and the trainer's collate spends two of them on
# <cls> and <eos>. Storing this many ranks per cell therefore bounds the
# artifact without ever being the binding constraint, so the trainer's own
# truncation stays the only one that decides a sequence's length.
GENEFORMER_MAX_RANKS = 4096

# One group under uns/ per dictionary set, because the median dictionary is
# what fixes the order and V1's gc30M medians differ from V2's gc104M. Two
# generations prepared on one store therefore land in two groups rather than
# overwriting each other, which is the same property the recipe id below gives
# over time.
#
# uns/ and not a top-level group: everything this server writes lives in an
# AnnData-legal container (layers/, var/, obs/, obsm/) so a prepared store is
# still a store anndata can open, and a top-level group breaks anndata.read_zarr
# outright. uns/ is AnnData's free-form namespace and is the only one that
# accepts a ragged array. The cost is that anndata.read_zarr materialises uns
# eagerly, so a local inspection of a prepared store pulls the ranking into
# memory. Nothing in Chiron reads these stores that way: the data server opens
# them with zarr directly, and so does the trainer.
GENEFORMER_GROUP = f"chiron_geneformer_{GENEFORMER_DICTIONARY_SET}"
GENEFORMER_INDPTR_KEY = "rank_indptr"
GENEFORMER_INDICES_KEY = "rank_indices"

# Everything that changes the stored order, in one string. Idempotence is
# checked against this and not against the version alone, so repinning the
# dictionaries or widening the cap recomputes rather than silently leaving an
# order that was built from something else.
GENEFORMER_RECIPE = (
    f"geneformer-{GENEFORMER_DICTIONARY_SET}-{GENEFORMER_REVISION[:12]}"
    f"-top{GENEFORMER_MAX_RANKS}-v{GENEFORMER_VERSION}"
)

GENEFORMER_RECIPE_ATTR = "chiron_geneformer_recipe"
GENEFORMER_VERSION_ATTR = "chiron_geneformer_version"
GENEFORMER_UNSUITABLE_KEY = "chiron_geneformer_unsuitable"
GENEFORMER_UNSUITABLE_WHY_KEY = "chiron_geneformer_unsuitable_reason"

# Off by default. This step costs roughly one int per stored expression value
# on disk, and most sites train one model, so making every site pay for every
# model's preprocessing is the opposite of what the per-model design is for.
# A site that trains Geneformer turns it on, the same way the image sets
# CHIRON_HVG_IN_FEATURE for Tabula.
#
# The scan loop is not the intended trigger. _ensure_geneformer_ranks is
# written to be called directly, which is what the on-demand path will do when
# a Geneformer trainer asks for a dataset it has not prepared yet. Until that
# lands, this switch is how an operator gets the artifact.
GENEFORMER_PREP_ENV = "CHIRON_GENEFORMER_PREP"

# How many stored values to look at when deciding whether X holds raw counts.
# A sample and not the whole array: the question is "has this matrix been
# normalised", and a normalised matrix is fractional essentially everywhere,
# so a spread sample answers it at a fraction of the cost. The stride below
# spreads the sample across the array rather than reading a prefix, because a
# prefix would only see the first few cells.
GENEFORMER_COUNT_CHECK_SAMPLE = 200_000


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


class _SparseX:
    """A compressed sparse ``X``, read from the store's own three arrays.

    Carries the attribute names scipy's sparse matrices use, so anything that
    duck-types on ``format`` / ``data`` / ``indices`` / ``indptr`` works against
    it unchanged. Holding it costs the stored values, not cells times genes.
    """

    def __init__(self, group) -> None:
        self.shape = tuple(int(v) for v in group.attrs["shape"])
        encoding = str(group.attrs.get("encoding-type", "csr_matrix"))
        self.format = "csc" if encoding.startswith("csc") else "csr"
        self.data = np.asarray(group["data"][:])
        self.indices = np.asarray(group["indices"][:])
        self.indptr = np.asarray(group["indptr"][:]).astype(np.int64)


def _open_x(root, zarr_path: Path, logger):
    """Read ``X`` out of an opened store, or None if it cannot be read.

    Deliberately not via ``anndata.read_zarr``. Binning writes its layer at the
    width of the selected panel, which on a full gene panel is far narrower
    than ``var``, and anndata refuses to load a layer whose shape disagrees
    with ``var``. Going through it would mean a store could be prepared once
    and then never re-read, so raising any version below would silently do
    nothing on exactly the datasets that matter. Nothing here wants the
    dataframe machinery anndata exists to provide.

    Args:
        root: the opened zarr group.
        zarr_path: only for log messages.
        logger: the caller's logger.

    Returns:
        A :class:`_SparseX`, a 2D numpy array for a dense store, or None.
    """
    if "X" not in root:
        logger.warning(f"{zarr_path.name}: no X in the store")
        return None

    x = root["X"]
    try:
        if isinstance(x, zarr.Group):
            return _SparseX(x)
        return np.asarray(x[:])
    except Exception as e:
        logger.warning(f"{zarr_path.name}: cannot read X: {e}")
        return None


def _select_columns_dense(X, mask: np.ndarray) -> np.ndarray:
    """The selected columns of ``X`` as a dense array, ``(n_cells, mask.sum())``.

    Only the selected panel is materialised, so the width is the panel's and
    not the store's. Rows are filled a block at a time, because the row index
    of every stored value is one int64 per value and on a large store that
    array on its own is larger than the result.

    Args:
        X: a :class:`_SparseX` or a dense 2D array.
        mask: boolean array over the store's genes.

    Returns:
        2D array of ``X``'s dtype.
    """
    if not isinstance(X, _SparseX):
        return np.asarray(X)[:, mask]

    n_rows, n_cols = X.shape
    picked = np.flatnonzero(mask)
    out = np.zeros((n_rows, len(picked)), dtype=X.data.dtype)

    if X.format == "csc":
        # A column is one contiguous run, so take the selected ones directly.
        for position, column in enumerate(picked):
            lo, hi = int(X.indptr[column]), int(X.indptr[column + 1])
            out[X.indices[lo:hi], position] = X.data[lo:hi]
        return out

    # CSR. -1 marks a gene that was not selected.
    remap = np.full(n_cols, -1, dtype=np.int64)
    remap[picked] = np.arange(len(picked))
    block = 8192
    for start in range(0, n_rows, block):
        stop = min(n_rows, start + block)
        lo, hi = int(X.indptr[start]), int(X.indptr[stop])
        if hi <= lo:
            continue
        columns = remap[X.indices[lo:hi]]
        keep = columns >= 0
        rows = np.repeat(
            np.arange(start, stop), np.diff(X.indptr[start : stop + 1])
        )
        out[rows[keep], columns[keep]] = X.data[lo:hi][keep]
    return out


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

    X = _open_x(root, zarr_path, logger)
    if X is None:
        return False
    if X.shape[0] == 0 or X.shape[1] == 0:
        return False

    selected_mask = np.asarray(root["var"][selected_key][:], dtype=np.bool_)
    if not selected_mask.any():
        logger.warning(
            f"{zarr_path.name}: HVG selection is empty; binning skipped"
        )
        return False

    # All cells, top-n_selected genes. Only the selected panel is made dense,
    # so the working copy is as wide as the panel and not as wide as the store.
    sub_X = _select_columns_dense(X, selected_mask)
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


def _sparse_column_ids(X):
    """The column each stored value of a sparse ``X`` belongs to, or None.

    Duck-typed rather than isinstance-checked so this module keeps importing
    numpy and nothing else. Returns None for anything that is not a compressed
    sparse matrix, which the caller then treats as dense.

    Args:
        X: candidate expression matrix.

    Returns:
        int array of length nnz, aligned with ``X.data``, or None.
    """
    fmt = getattr(X, "format", None)
    if fmt not in ("csr", "csc"):
        return None
    if not all(hasattr(X, member) for member in ("data", "indices", "indptr")):
        return None

    if fmt == "csr":
        # CSR indices are already column indices.
        return np.asarray(X.indices, dtype=np.intp)

    # CSC groups values by column, so the column is the position in indptr.
    # X.indices holds row indices here and is not what we want.
    indptr = np.asarray(X.indptr, dtype=np.intp)
    return np.repeat(np.arange(len(indptr) - 1, dtype=np.intp), np.diff(indptr))


def _compute_qc_masks(X):
    """Which cells and which genes survive the manuscript's quality control.

    Two filters, from the Methods: "we filtered cells with fewer than 250
    detected genes to exclude potential empty droplets, non-viable cells, or
    severely degraded cells. Concurrently, we also removed genes detected in
    fewer than 250 cells to mitigate the influence of lowly expressed or rare
    transcripts."

    Note what the gene filter counts. It is the number of CELLS in which a gene
    is detected, not that gene's total counts. The two differ sharply for a
    gene that is highly expressed in a handful of cells, which this filter is
    meant to remove and a counts threshold would keep.

    Both masks are computed against the ORIGINAL matrix and returned together,
    which is what "concurrently" asks for. Applying one and then recomputing
    the other would make the result depend on which went first, and the counts
    would differ from the manuscript's.

    Nothing is deleted here. The caller stores these as masks so the source
    stays intact for a second model whose preprocessing needs the full panel.

    Sparse input is read through its stored structure alone: the per-cell
    detected count is the row length, and the per-gene cell count is how often
    a column id appears. Neither needs the values and neither builds a dense
    matrix, so cost is proportional to stored entries rather than cells x genes.

    Args:
        X: (n_cells, n_genes) array-like, raw counts.

    Returns:
        (cell_mask, gene_mask) as bool arrays of length n_cells and n_genes.
        True means keep.
    """
    n_cells, n_genes = int(X.shape[0]), int(X.shape[1])
    columns = _sparse_column_ids(X)

    if columns is not None and getattr(X, "format", None) == "csr":
        # One pass each, both off the CSR structure.
        detected_per_cell = np.diff(np.asarray(X.indptr, dtype=np.intp))
        cells_per_gene = np.bincount(columns, minlength=n_genes)
    elif columns is not None:
        # CSC: column ids are derived, so the per-gene count is still a
        # bincount, but the per-cell count has to come from the row indices.
        rows = np.asarray(X.indices, dtype=np.intp)
        detected_per_cell = np.bincount(rows, minlength=n_cells)
        cells_per_gene = np.bincount(columns, minlength=n_genes)
    else:
        dense = np.asarray(X)
        nonzero = dense > 0
        detected_per_cell = nonzero.sum(axis=1)
        cells_per_gene = nonzero.sum(axis=0)

    cell_mask = np.asarray(detected_per_cell) >= QC_MIN_GENES_PER_CELL
    gene_mask = np.asarray(cells_per_gene) >= QC_MIN_CELLS_PER_GENE
    return cell_mask.astype(bool), gene_mask.astype(bool)


def _compute_hvg_score(X) -> np.ndarray:
    """Per-gene over-dispersion score (variance / mean) for ranking.

    Dependency-free (numpy only). For Poisson-distributed counts the expected
    variance equals the mean, so variance / mean ≈ 1 for baseline genes and
    > 1 for genes that vary more than chance. Genes with all-zero counts get
    score 0 (they rank last; safe to filter or ignore downstream).

    Higher score = more variable.

    A sparse X is scored from its stored values alone, without ever building the
    dense matrix. Both moments the score needs are per-column sums, and an
    implicit zero adds nothing to either one, only to the divisor. That makes
    the cost proportional to the stored values rather than to cells x genes,
    which is the difference between preparing a real full-panel store on a
    normal machine and not being able to prepare it at all. The numbers are the
    same ones the dense path produced, so nothing already ranked needs redoing.

    Args:
        X: (n_cells, n_genes) array-like. A scipy CSR or CSC matrix is read
           through its stored arrays; anything else is treated as dense.

    Returns:
        float32 array of length n_genes.
    """
    columns = _sparse_column_ids(X)
    if columns is not None:
        n_cells, n_genes = int(X.shape[0]), int(X.shape[1])
        if n_cells == 0 or n_genes == 0:
            return np.zeros(n_genes, dtype=np.float32)

        # float64 throughout: the stored values are float32, and E[X^2] on a
        # count matrix is large enough that accumulating it at float32 would
        # lose digits the subtraction below then depends on.
        values = np.asarray(X.data, dtype=np.float64)
        total = np.bincount(columns, weights=values, minlength=n_genes)
        total_sq = np.bincount(columns, weights=values * values, minlength=n_genes)

        means = total / n_cells
        # Population variance (ddof=0), matching what np.var returned here.
        # Rounding can push an all-equal column a hair below zero.
        vars_ = np.maximum(total_sq / n_cells - means * means, 0.0)
    else:
        X = np.asarray(X, dtype=np.float64)
        if X.ndim != 2:
            raise ValueError(f"Expected 2D expression matrix, got shape {X.shape}")
        if X.shape[0] == 0 or X.shape[1] == 0:
            return np.zeros(X.shape[1], dtype=np.float32)

        means = X.mean(axis=0)
        vars_ = X.var(axis=0)

    score = np.where(means > 1e-12, vars_ / (means + 1e-12), 0.0)
    return score.astype(np.float32)


def _ensure_qc(zarr_path: Path, logger) -> bool:
    """Write obs/chiron_qc_cell_mask and var/chiron_qc_gene_mask.

    Stage 2 of the manuscript's pipeline, and the step HVG selection has to run
    behind. Idempotent on QC_VERSION. Returns True if a write occurred.

    Refuses on a store that was already reduced upstream, which is not a
    conservative default but a correctness one. The cell filter counts detected
    genes against the full panel it was defined on. Applied to a store already
    cut to 1,200 highly variable genes it removes most real cells rather than
    empty droplets: on the blood shard of the 1M corpus, 178,970 of 250,000.
    """
    try:
        root = zarr.open_group(str(zarr_path), mode="r+")
    except Exception as e:
        logger.warning(f"Cannot open {zarr_path.name} for QC: {e}")
        return False

    if "var" not in root or "obs" not in root:
        logger.warning(f"{zarr_path.name}: no var/ or obs/ group; QC skipped")
        return False

    var_group, obs_group = root["var"], root["obs"]
    try:
        var_index = _find_key(root, "var", "_index") or "_index"
        n_vars = int(var_group[var_index].shape[0])
    except Exception as e:
        logger.warning(f"{zarr_path.name}: cannot size var/ for QC: {e}")
        return False

    reason = _detect_upstream_reduction(root, n_vars)
    if reason is not None:
        if _read_attr(root, UPSTREAM_REDUCED_KEY) is not True:
            root.attrs[UPSTREAM_REDUCED_KEY] = True
            root.attrs[UPSTREAM_REDUCED_WHY_KEY] = reason
        logger.info(f"{zarr_path.name}: QC skipped, already reduced ({reason})")
        return False

    has_cell = _find_key(root, "obs", QC_CELL_MASK_KEY) is not None
    has_gene = _find_key(root, "var", QC_GENE_MASK_KEY) is not None
    if has_cell and has_gene and _read_attr(root, "chiron_qc_version") == QC_VERSION:
        return False

    X = _open_x(root, zarr_path, logger)
    if X is None:
        return False

    cell_mask, gene_mask = _compute_qc_masks(X)

    obs_group.create_array(
        QC_CELL_MASK_KEY, shape=cell_mask.shape, dtype=cell_mask.dtype, overwrite=True
    )[:] = cell_mask
    var_group.create_array(
        QC_GENE_MASK_KEY, shape=gene_mask.shape, dtype=gene_mask.dtype, overwrite=True
    )[:] = gene_mask

    n_cells_kept, n_genes_kept = int(cell_mask.sum()), int(gene_mask.sum())
    root.attrs["chiron_qc_version"] = QC_VERSION
    root.attrs["chiron_qc_min_genes_per_cell"] = QC_MIN_GENES_PER_CELL
    root.attrs["chiron_qc_min_cells_per_gene"] = QC_MIN_CELLS_PER_GENE
    root.attrs["chiron_qc_n_cells_kept"] = n_cells_kept
    root.attrs["chiron_qc_n_genes_kept"] = n_genes_kept
    root.attrs["chiron_qc_n_cells_total"] = int(cell_mask.size)
    root.attrs["chiron_qc_n_genes_total"] = int(gene_mask.size)

    # These stores carry consolidated metadata, so an array written after the
    # fact is invisible to any reader that goes through the consolidated index,
    # including a plain zarr.open_group. Without this the masks are on disk and
    # unreadable, which is the quietest possible way for this step to fail.
    try:
        zarr.consolidate_metadata(root.store)
    except Exception as e:
        logger.warning(
            f"{zarr_path.name}: consolidate_metadata failed after QC, so the "
            f"masks may be invisible to readers using consolidated metadata: {e}"
        )

    logger.info(
        f"{zarr_path.name}: QC kept {n_cells_kept:,}/{cell_mask.size:,} cells and "
        f"{n_genes_kept:,}/{gene_mask.size:,} genes"
    )
    return True


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

    # Refuse before measuring anything, not after. A store that arrives already
    # reduced to a model panel is recorded as such and left alone: re-scoring
    # HVGs on an upstream selection would silently replace it with a ranking
    # computed over a different matrix, and the quality-control step that will
    # sit in front of this one would discard most of the cells. See
    # UPSTREAM_REDUCED_KEY for the measured consequence.
    n_vars = None
    try:
        index_key = _find_key(root, "var", "_index") or "_index"
        n_vars = int(var_group[index_key].shape[0])
    except Exception:
        pass
    reason = _detect_upstream_reduction(root, n_vars) if n_vars is not None else None
    if reason is not None:
        if _read_attr(root, UPSTREAM_REDUCED_KEY) is not True:
            root.attrs[UPSTREAM_REDUCED_KEY] = True
            root.attrs[UPSTREAM_REDUCED_WHY_KEY] = reason
            logger.info(
                f"{zarr_path.name}: already reduced upstream ({reason}). "
                f"Leaving the gene panel as it is."
            )
        return False

    existing_version = _read_attr(root, "chiron_hvg_version")
    has_selected = _find_key(root, "var", HVG_SELECTED_KEY) is not None
    has_rank = _find_key(root, "var", HVG_RANK_KEY) is not None
    if has_rank and existing_version == HVG_VERSION and has_selected:
        return False  # already ranked at the current version

    X = _open_x(root, zarr_path, logger)
    if X is None:
        return False

    n_vars = int(X.shape[1])
    if n_vars == 0:
        return False

    # Per-gene over-dispersion (variance / mean) across the full expression
    # matrix. Whatever cell- or gene-level filtering the site operator wants
    # to apply is expected upstream of the data-server.
    score = _compute_hvg_score(X)

    # rank 0 = most variable, n_vars-1 = least
    rank = (-score).argsort().argsort().astype(np.int32)

    # Direct zarr writes into var/, because the trainer reads these through raw
    # zarr access. `_ensure_var_columns_visible` then registers them in var's
    # dataframe column index, in a step of its own so that datasets already
    # ranked at the current HVG_VERSION get registered without a recompute.
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
    n_selected = int(min(MODEL_IN_FEATURE, n_vars))
    selected_mask = np.zeros(n_vars, dtype=np.bool_)
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


def _geneformer_prep_enabled() -> bool:
    """Whether the scan loop should precompute Geneformer rank orderings."""
    return os.environ.get(GENEFORMER_PREP_ENV, "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def _geneformer_cache_dir() -> Path:
    """Where the verified dictionaries are kept between restarts."""
    root = os.environ.get("CHIRON_CACHE_DIR") or tempfile.gettempdir()
    path = Path(root) / "geneformer" / GENEFORMER_REVISION[:12]
    path.mkdir(parents=True, exist_ok=True)
    return path


def _fetch_geneformer_dictionary(name: str, logger):
    """One Geneformer dictionary, fetched and digest-verified once.

    Fetched at runtime rather than baked into the image, so this package stays
    model-code-free, and pinned by revision *and* digest so every site ends up
    with a byte-identical corpus. That identity is a correctness requirement
    rather than a convenience: the order this server writes has to be the order
    the trainer would have computed, and a different median dictionary produces
    a different order with no error anywhere.

    The digest is checked before ``pickle.loads`` and never after. Unpickling
    executes arbitrary code, so verifying afterwards verifies nothing.

    Raises:
        RuntimeError: if the download fails or its digest does not match.
    """
    expected = GENEFORMER_DICTIONARIES[name]
    path = _geneformer_cache_dir() / name

    if path.exists():
        payload = path.read_bytes()
        if hashlib.sha256(payload).hexdigest() == expected:
            return pickle.loads(payload)
        logger.warning(f"Cached Geneformer {name} failed its checksum, re-fetching")

    url = GENEFORMER_HF_URL.format(revision=GENEFORMER_REVISION, name=name)
    logger.info(f"Fetching Geneformer dictionary {name}")
    try:
        with urllib.request.urlopen(url, timeout=180) as response:
            payload = response.read()
    except Exception as e:
        raise RuntimeError(
            f"Could not fetch the Geneformer dictionary {name} from {url}. The "
            "rank ordering cannot be computed without it."
        ) from e

    digest = hashlib.sha256(payload).hexdigest()
    if digest != expected:
        raise RuntimeError(
            f"{name} downloaded from {url} has sha256 {digest}, expected "
            f"{expected}. Refusing to unpickle it."
        )

    # Write under a temporary name and rename, so two processes starting at
    # once cannot leave a half-written file for the other to read.
    fd, staged = tempfile.mkstemp(dir=str(_geneformer_cache_dir()))
    with os.fdopen(fd, "wb") as fh:
        fh.write(payload)
    os.replace(staged, path)

    return pickle.loads(payload)


def _load_geneformer_vocabulary(logger):
    """``(token_dictionary, gene_medians)`` for the pinned dictionary set.

    Both, not just the medians. The medians alone decide the order, but they
    cover 42,005 genes against the token dictionary's 20,275, so ranking every
    gene that has a median would order 21,734 genes the model has no token for.
    The trainer drops those, and it does so *after* truncating, so an order
    built on the wider set would hand it a short sequence. Keeping the usable
    set identical to the trainer's is what makes the stored order the one the
    trainer would have produced itself.
    """
    tokens = _fetch_geneformer_dictionary("token_dictionary_gc104M.pkl", logger)
    medians = _fetch_geneformer_dictionary("gene_median_dictionary_gc104M.pkl", logger)
    return tokens, medians


def _sample_nonintegral(X):
    """Why ``X`` does not look like raw counts, or None if it does.

    Geneformer's normalisation divides a raw count by a gene median taken over
    a raw-count corpus. Run against a matrix somebody already library-size
    normalised or log1p-transformed, it produces a confident ordering of the
    wrong quantity, and nothing downstream can tell. Normalisation leaves
    fractional values essentially everywhere, so integrality separates the two
    cases cleanly.

    Sampled across the array with a stride rather than read as a prefix, since
    a prefix only ever sees the first handful of cells.
    """
    values = X.data if hasattr(X, "data") and hasattr(X, "indptr") else np.asarray(X)
    values = np.asarray(values).reshape(-1)
    if values.size == 0:
        return "X holds no stored values"

    stride = max(1, values.size // GENEFORMER_COUNT_CHECK_SAMPLE)
    sample = values[::stride]
    if not np.all(np.isfinite(sample)):
        return "X contains non-finite values, so it is not a count matrix"
    if np.any(sample < 0):
        return (
            "X contains negative values, so it has been centred or scaled "
            "rather than left as counts"
        )
    fractional = int(np.count_nonzero(sample != np.rint(sample)))
    if fractional:
        return (
            f"{fractional:,} of {sample.size:,} sampled values are not whole "
            "numbers, so X has been normalised or log-transformed rather than "
            "left as raw counts"
        )
    return None


def _looks_like_ensembl(values: np.ndarray) -> bool:
    """Whether a var column holds Ensembl gene ids rather than symbols.

    A majority test and not a universal one. Real panels carry spike-ins and
    the occasional hand-added row, and demanding every entry match would reject
    an otherwise perfectly good store over a handful of them.
    """
    if values.size == 0:
        return False
    sample = values[:: max(1, values.size // 2000)]
    hits = sum(
        1
        for value in sample
        if value.startswith("ENS") and any(ch.isdigit() for ch in value)
    )
    return hits >= 0.8 * len(sample)


def _read_ensembl_ids(root, var_group, var_index: str, logger):
    """``(ensembl_ids, source_column)`` for this store, or ``(None, None)``.

    Ensembl ids are the join key between a store and Geneformer's corpus, and
    where they live depends on who staged the data. Chiron-prepared datasets
    carry them in ``var/feature_id``. Data taken straight from CELLxGENE
    carries them in the ``var`` index instead and has no ``feature_id`` column
    at all, which is the common case for a site bringing its own data.

    Both are accepted, ``feature_id`` first, and the fallback is used only when
    the index actually looks like Ensembl ids. The alternative is to trust the
    index blindly and silently rank nothing on a store indexed by gene symbol.
    """
    for key, label in (
        (_find_key(root, "var", "feature_id"), "feature_id"),
        (var_index, var_index),
    ):
        if key is None or key not in var_group:
            continue
        try:
            values = np.asarray(var_group[key][:]).astype(str)
        except Exception as e:
            logger.warning(f"Cannot read var/{key}: {e}")
            continue
        if _looks_like_ensembl(values):
            return values, label
    return None, None


def _detect_geneformer_unsuitable(root, n_vars: int, X):
    """Why this store cannot carry a Geneformer ordering, or None if it can.

    The same refusal the Tabula steps make, for the same reason and against a
    wider set of signals. A store that was already reduced to a model's gene
    panel is not a transcriptome, and Geneformer ranks a cell's transcriptome:
    the order over 1,200 selected genes is a different object from the order
    over 20,000, not a truncation of it. A store whose values were already
    normalised is worse still, because the ranking is then computed against a
    quantity the gene medians were never derived from.

    Refusing is cheap here because it is not fatal. The trainer can still read
    raw X and derive the order itself, which is what it does today, so a
    refused store trains exactly as it does now and simply gains no artifact.
    """
    reduced = _detect_upstream_reduction(root, n_vars)
    if reduced is not None:
        # One detector, two consequences. The signals that say "a selection
        # already happened here" are the same ones Tabula's steps look for, but
        # what follows from them is not, so the consequence is spelled out here
        # rather than inherited from a function that speaks about gene panels.
        return (
            f"{reduced}, and Geneformer ranks a cell's whole transcriptome, so "
            "an order over an already-selected panel is a different object "
            "rather than a truncation of the right one"
        )
    return _sample_nonintegral(X)


def _compute_geneformer_ranks(X, col_to_slot, medians_by_slot, max_ranks, row_block=4096):
    """Each cell's expressed genes as column indices in Geneformer rank order.

    One cell at a time, in row blocks so the per-block temporaries stay small:
    take the row's stored counts, drop the columns Geneformer has no token or
    no median for, divide each remaining count by that gene's median, and sort
    descending.

    Two constant factors of Geneformer's own encoding are omitted on purpose.
    It divides a cell by its total counts and multiplies by a fixed target sum
    before dividing by the median. Both are strictly positive per-cell
    constants, so neither can change the order this returns, and recovering
    them from obs/n_counts would be wrong anyway because those totals refer to
    the full transcriptome and disagree with a gene-subset store.

    The sort is stable, so genes whose normalised value ties keep their column
    order. The trainer's is stable for the same reason, over the same set, so
    the two agree entry for entry and not merely as multisets.

    Args:
        X: a :class:`_SparseX` in CSR form, or a dense 2D array.
        col_to_slot: for each column of X, its position in ``medians_by_slot``,
            or -1 for a column Geneformer cannot use.
        medians_by_slot: the gene median of each usable column.
        max_ranks: keep at most this many genes per cell.
        row_block: cells per pass.

    Returns:
        ``(indptr, indices, stats)``. ``indptr`` is int64 of length n_cells + 1,
        ``indices`` holds the ranked column indices, and ``stats`` counts the
        cells that were truncated and the cells that had nothing usable.
    """
    n_cells = int(X.shape[0])
    n_vars = int(X.shape[1])
    is_sparse = hasattr(X, "indptr") and hasattr(X, "indices")

    # uint16 wherever the panel fits it, which is every store with fewer than
    # 65,536 genes and so every store built on a human or mouse gene panel.
    # Halving this array halves the artifact, and it is the whole artifact.
    index_dtype = np.uint16 if n_vars <= np.iinfo(np.uint16).max else np.int32

    per_cell = []
    n_truncated = 0
    n_empty = 0

    for start in range(0, n_cells, row_block):
        stop = min(start + row_block, n_cells)
        if is_sparse:
            indptr = np.asarray(X.indptr, dtype=np.int64)
            block_rows = [
                (np.asarray(X.indices[indptr[r]:indptr[r + 1]], dtype=np.int64),
                 np.asarray(X.data[indptr[r]:indptr[r + 1]], dtype=np.float64))
                for r in range(start, stop)
            ]
        else:
            dense = np.asarray(X[start:stop])
            block_rows = []
            for row in dense:
                cols = np.flatnonzero(row > 0)
                block_rows.append((cols.astype(np.int64), row[cols].astype(np.float64)))

        for cols, counts in block_rows:
            if cols.size == 0:
                per_cell.append(np.empty(0, dtype=index_dtype))
                n_empty += 1
                continue
            slots = col_to_slot[cols]
            alive = slots >= 0
            if not np.any(alive):
                per_cell.append(np.empty(0, dtype=index_dtype))
                n_empty += 1
                continue
            cols, slots, counts = cols[alive], slots[alive], counts[alive]
            scores = counts / medians_by_slot[slots]
            order = np.argsort(-scores, kind="stable")
            if order.size > max_ranks:
                order = order[:max_ranks]
                n_truncated += 1
            per_cell.append(cols[order].astype(index_dtype))

    lengths = np.fromiter((len(c) for c in per_cell), dtype=np.int64, count=len(per_cell))
    indptr = np.zeros(n_cells + 1, dtype=np.int64)
    np.cumsum(lengths, out=indptr[1:])
    indices = (
        np.concatenate(per_cell) if per_cell else np.empty(0, dtype=index_dtype)
    ).astype(index_dtype)

    return indptr, indices, {"n_truncated": n_truncated, "n_empty": n_empty}


def _ensure_geneformer_ranks(zarr_path: Path, logger) -> bool:
    """Write uns/chiron_geneformer_gc104M/{rank_indptr,rank_indices} if missing.

    Idempotent on the recipe id, which is the guard the request asks for: a
    store already prepared under this protocol is left alone rather than
    recomputed. It is the recipe and not the version that is compared, so
    repinning the dictionaries or changing the rank cap is recomputed too,
    while an unchanged protocol is a no-op forever.

    Touches nothing outside its own group. X, var, obs, layers and obsm are
    read and never written, so running this after Tabula's quality control,
    HVG ranking, binning and UMAP leaves all four byte-identical, and running
    it before them changes nothing they go on to compute.

    Returns True if a write occurred.
    """
    try:
        root = zarr.open_group(str(zarr_path), mode="r+")
    except Exception as e:
        logger.warning(f"Cannot open {zarr_path.name} for Geneformer ranking: {e}")
        return False

    if "var" not in root:
        logger.warning(f"{zarr_path.name}: no var/ group; Geneformer ranking skipped")
        return False

    # Already prepared under this exact protocol. Checked before anything is
    # read off disk, so a second pass over a prepared store costs one attribute
    # lookup.
    uns = root["uns"] if "uns" in root else None
    if (
        uns is not None
        and GENEFORMER_GROUP in uns
        and _read_attr(root, GENEFORMER_RECIPE_ATTR) == GENEFORMER_RECIPE
    ):
        return False

    var_group = root["var"]
    try:
        var_index = _find_key(root, "var", "_index") or "_index"
        n_vars = int(var_group[var_index].shape[0])
    except Exception as e:
        logger.warning(f"{zarr_path.name}: cannot size var/ for Geneformer: {e}")
        return False

    X = _open_x(root, zarr_path, logger)
    if X is None:
        return False
    if getattr(X, "format", "csr") == "csc":
        logger.info(
            f"{zarr_path.name}: Geneformer ranking skipped, X is stored CSC and "
            "ranking reads cells as rows"
        )
        return False

    reason = _detect_geneformer_unsuitable(root, n_vars, X)
    if reason is not None:
        if _read_attr(root, GENEFORMER_UNSUITABLE_KEY) is not True:
            root.attrs[GENEFORMER_UNSUITABLE_KEY] = True
            root.attrs[GENEFORMER_UNSUITABLE_WHY_KEY] = reason
        logger.info(f"{zarr_path.name}: Geneformer ranking skipped ({reason})")
        return False

    n_cols = int(X.shape[1])
    ensembl, feature_key = _read_ensembl_ids(root, var_group, var_index, logger)
    if ensembl is None:
        reason = (
            "neither var/feature_id nor the var index holds Ensembl gene ids, "
            "and Geneformer's corpus is keyed by them, so there is nothing to "
            "join this store's genes against"
        )
        root.attrs[GENEFORMER_UNSUITABLE_KEY] = True
        root.attrs[GENEFORMER_UNSUITABLE_WHY_KEY] = reason
        logger.info(f"{zarr_path.name}: Geneformer ranking skipped ({reason})")
        return False
    if len(ensembl) != n_cols:
        logger.warning(
            f"{zarr_path.name}: var/{feature_key} has {len(ensembl):,} entries but "
            f"X has {n_cols:,} columns; Geneformer ranking skipped"
        )
        return False

    try:
        tokens, medians = _load_geneformer_vocabulary(logger)
    except Exception as e:
        logger.warning(f"{zarr_path.name}: Geneformer ranking skipped, {e}")
        return False

    token_ids = np.array([tokens.get(g, -1) for g in ensembl], dtype=np.int64)
    gene_medians = np.array(
        [medians.get(g, np.nan) for g in ensembl], dtype=np.float64
    )
    usable = (token_ids >= 0) & np.isfinite(gene_medians) & (gene_medians > 0)
    keep = np.flatnonzero(usable)
    if keep.size == 0:
        reason = (
            "not one gene in this store is in Geneformer's vocabulary, so "
            f"var/{feature_key} is probably not Ensembl gene ids"
        )
        root.attrs[GENEFORMER_UNSUITABLE_KEY] = True
        root.attrs[GENEFORMER_UNSUITABLE_WHY_KEY] = reason
        logger.info(f"{zarr_path.name}: Geneformer ranking skipped ({reason})")
        return False

    col_to_slot = np.full(n_cols, -1, dtype=np.int64)
    col_to_slot[keep] = np.arange(keep.size, dtype=np.int64)

    indptr, indices, stats = _compute_geneformer_ranks(
        X, col_to_slot, gene_medians[keep], GENEFORMER_MAX_RANKS
    )

    uns_group = root["uns"] if "uns" in root else root.create_group("uns")
    group = uns_group.create_group(GENEFORMER_GROUP, overwrite=True)
    # AnnData's own encoding markers, so a prepared store still opens with
    # anndata.read_zarr instead of failing on an unannotated group.
    group.attrs["encoding-type"] = "dict"
    group.attrs["encoding-version"] = "0.1.0"
    for name, array in (
        (GENEFORMER_INDPTR_KEY, indptr),
        (GENEFORMER_INDICES_KEY, indices),
    ):
        written = group.create_array(
            name, shape=array.shape, dtype=array.dtype, overwrite=True
        )
        written[:] = array
        written.attrs["encoding-type"] = "array"
        written.attrs["encoding-version"] = "0.2.0"

    root.attrs[GENEFORMER_VERSION_ATTR] = GENEFORMER_VERSION
    root.attrs[GENEFORMER_RECIPE_ATTR] = GENEFORMER_RECIPE
    root.attrs["chiron_geneformer_revision"] = GENEFORMER_REVISION
    root.attrs["chiron_geneformer_dictionary_set"] = GENEFORMER_DICTIONARY_SET
    root.attrs["chiron_geneformer_max_ranks"] = GENEFORMER_MAX_RANKS
    root.attrs["chiron_geneformer_n_cells"] = int(X.shape[0])
    root.attrs["chiron_geneformer_n_genes_usable"] = int(keep.size)
    root.attrs["chiron_geneformer_n_genes_total"] = n_cols
    root.attrs["chiron_geneformer_n_ranked"] = int(indices.size)
    root.attrs["chiron_geneformer_n_cells_truncated"] = stats["n_truncated"]
    root.attrs["chiron_geneformer_n_cells_empty"] = stats["n_empty"]
    # A store refused by an earlier, stricter pin that now passes should not
    # keep advertising a refusal that no longer holds.
    if _read_attr(root, GENEFORMER_UNSUITABLE_KEY) is not None:
        root.attrs[GENEFORMER_UNSUITABLE_KEY] = False
        root.attrs[GENEFORMER_UNSUITABLE_WHY_KEY] = ""

    # These stores carry consolidated metadata, so a group written after the
    # fact is invisible to any reader that goes through the consolidated index.
    # Without this the ordering is on disk and unreadable.
    try:
        zarr.consolidate_metadata(root.store)
    except Exception as e:
        logger.warning(
            f"{zarr_path.name}: consolidate_metadata failed after Geneformer "
            f"ranking, so the ordering may be invisible to readers using "
            f"consolidated metadata: {e}"
        )

    logger.info(
        f"{zarr_path.name}: Geneformer ranked {X.shape[0]:,} cells over "
        f"{keep.size:,}/{n_cols:,} genes in Geneformer's vocabulary, "
        f"{indices.size:,} ranked entries "
        f"({stats['n_truncated']:,} cells truncated at {GENEFORMER_MAX_RANKS}, "
        f"{stats['n_empty']:,} with nothing usable)"
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

        # 2) Apply Chiron's preprocessing to every zarr in this dataset folder.
        #    Each step is independently idempotent on its own version attr, so
        #    re-running this loop only does the missing work, and each refuses
        #    a store that does not suit it rather than producing a confident
        #    wrong answer.
        #
        #    Tabula's chain runs in dependency order: quality control first
        #    because the Methods select HVGs from what survives it, then HVG
        #    ranking, because value binning and UMAP both consume the selection
        #    mask. Geneformer's step is appended rather than interleaved: it
        #    shares no input and no output with any of them, so its position
        #    here cannot change what they produce, and putting it last keeps
        #    the cheap steps ahead of the expensive one.
        steps = [
            (_ensure_qc,            "quality control"),
            (_ensure_hvg_rank,      "HVG ranking"),
            (_ensure_var_columns_visible, "var column registration"),
            (_ensure_hvg_histogram, "HVG histogram"),
            (_ensure_binning,       "value binning"),
            (_ensure_umap_embedding, "UMAP embedding"),
        ]
        if _geneformer_prep_enabled():
            steps.append((_ensure_geneformer_ranks, "Geneformer rank ordering"))

        for zarr_path in sorted(dataset_dir.glob("*.zarr")):
            for fn, label in steps:
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
