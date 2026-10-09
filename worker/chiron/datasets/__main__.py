"""The Chiron data server.

Scans a site's data directory, converts AnnData files to zarr, and precomputes
the artifacts the dataset card and the trainers read. Model-agnostic on
purpose: it is installed into chiron-base and therefore ends up in every model
image, so it must not import any foundation model's code.

Run as `python -m chiron.datasets --data-dir /data`.
"""

import argparse
import hashlib
import json
import os
import pickle
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

import anndata as ad
import numpy as np
import zarr
from bioengine.datasets.proxy_server import start_proxy_server
from bioengine.utils import create_logger

from chiron.datasets.recipes import (
    Param,
    Recipe,
    Stage,
    StageResult,
    check_recipe,
    plan,
    resolve_params,
)

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


def _ensure_var_columns_visible(
    zarr_path: Path, params: Mapping[str, Any], logger
) -> StageResult:
    """Pipeline step: register the HVG and quality-control arrays as var columns.

    Separate from the stages that write them, because registration is pure
    metadata: a store already ranked at the current version needs its columns
    registered without paying for a recompute. Keeping it separate is also what
    lets a reader going through anndata see the masks at all.
    """
    root = zarr.open_group(str(zarr_path), mode="a")
    registered = _register_var_columns(
        root,
        (HVG_RANK_KEY, HVG_SCORE_KEY, HVG_SELECTED_KEY, QC_GENE_MASK_KEY),
        logger,
    )
    if registered:
        try:
            zarr.consolidate_metadata(root.store)
        except Exception as e:
            logger.warning(
                f"{zarr_path.name}: consolidate_metadata failed after registering "
                f"var columns, so anndata readers may still not see the masks: {e}"
            )
    # Satisfied either way. "Nothing needed registering" is success, not a
    # refusal, and treating it as one would block every stage behind it.
    return StageResult(True, stats={"registered": bool(registered)})


# The HVG ranking is written into each zarr's var/ group so the trainer
# and the Chiron UI can both reason about gene variability. The rank covers
# all n_vars genes, computed on the full expression matrix. On top of the
# full rank we also write a boolean selection mask that picks the top
# MODEL_IN_FEATURE genes: this is the contract the trainer reads against the
# pre-cut binned layer, and it lets the data server reproduce the
# manuscript's 1200-HVG preprocessing without giving operators a knob they
# could tune. Whatever cell- or gene-level quality control the site operator
# applies upstream of Chiron is preserved untouched.
HVG_VERSION = 5  # bumped 4 -> 5: scored behind the quality-control masks, as
#                  the Methods order it, which changes which genes are selected
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
QC_VERSION = 2  # bumped 1 -> 2: thresholds are parameters, and the two
#                 distributions they cut through are recorded alongside them
QC_MIN_GENES_PER_CELL = 250  # the manuscript's value, and the default
QC_MIN_CELLS_PER_GENE = 250  # the manuscript's value, and the default
QC_CELL_MASK_KEY = "chiron_qc_cell_mask"  # bool, length n_obs, under obs/
QC_GENE_MASK_KEY = "chiron_qc_gene_mask"  # bool, length n_vars, under var/
# The grid the count distributions are binned onto: 1 to 10 million, four bins
# per decade. Fixed rather than derived from the data, so that the per-store
# histograms of one dataset can simply be added together, which is what the UI
# shows. Seven decades covers both quantities with room to spare: detected
# genes per cell tops out around 50,000 and cells per gene around the size of
# the largest store anyone will put on one site.
QC_HIST_BINS = 28
QC_HIST_EDGES = [float(10 ** (i / 4.0)) for i in range(QC_HIST_BINS + 1)]

# A second fixed grid, for the HVG over-dispersion score. It is NOT a count:
# variance over mean sits mostly below 1 and reaches a few thousand in the tail,
# so putting it on the count grid above would clip most genes into the first
# bin. 10^-2 to 10^4 at four bins per decade covers the whole observed range.
#
# Fixed for the same two reasons as the count grid. Per-dataset histograms add
# exactly across a dataset's files, and, more importantly, data-derived edges
# ARE data: the lowest edge is one gene's exact score and the highest is
# another's, which is a per-gene value leaving the site under the name of an
# axis label.
HVG_SCORE_HIST_BINS = 24
HVG_SCORE_HIST_EDGES = [
    float(10 ** (-2 + i / 4.0)) for i in range(HVG_SCORE_HIST_BINS + 1)
]

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


HVG_HIST_VERSION = 3  # bumped 2 -> 3: scores it summarises are now post-QC
HVG_HIST_KEY = "chiron_hvg_histogram_counts"  # legacy var/ name kept for cleanup of older zarrs
HVG_HIST_BINS = 20

# Streaming IncrementalPCA -> UMAP gives the dataset card a 2-D embedding the
# data-server can compute on first read with bounded memory regardless of
# dataset size. PCA acts as a denoiser + dimensionality reducer so the UMAP
# step only ever sees n_cells x N_PC instead of n_cells x n_vars. The PCA +
# UMAP run on the pre-cut binned layer (all cells x top MODEL_IN_FEATURE
# HVGs), so the dataset card shows the operator exactly the matrix the
# trainer consumes.
UMAP_VERSION = 4  # bumped 3 -> 4: embeds the cells that passed quality control
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
BINNING_VERSION = 4  # bumped 3 -> 4: cut to a panel selected behind the QC masks
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

    Ties are broken by position, not shared: equal counts near a bin boundary
    land on either side of it. That is a property of rank binning and not a
    defect, but it does mean two genes with the same count in one cell can
    differ by one bin. Returns a uint8 array with the same shape
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


def _ensure_binning(
    zarr_path: Path, params: Mapping[str, Any], logger
) -> StageResult:
    """Write layers/chiron_binned into the zarr.

    Shape is (n_cells, n_selected_genes), the trainer-ready view: the trainer
    streams a row at a time and feeds it straight into the model with no column
    or row reshaping.

    The layer covers EVERY cell, including the ones quality control dropped, so
    row *i* of the layer is still cell *i* of ``obs``. The cell mask is applied
    by the trainer when it builds its index, not here. Cutting rows out of the
    layer would silently break every reader that joins it back to ``obs`` by
    position, and there is no spare column to carry the old index in.

    The gene panel it is cut to was selected behind the masks, so the binning
    depends on quality control even though it reads no mask itself.
    """
    root = zarr.open_group(str(zarr_path), mode="r+")

    # Need the HVG selection upstream of binning.
    selected_key = _find_key(root, "var", HVG_SELECTED_KEY)
    if selected_key is None:
        return StageResult(
            False,
            refused="the HVG selection mask is absent, so there is no panel to cut to",
        )

    X = _open_x(root, zarr_path, logger)
    if X is None:
        return StageResult(False, refused="X could not be read from this store")
    if X.shape[0] == 0 or X.shape[1] == 0:
        return StageResult(False, refused="this store has no cells or no genes")

    selected_mask = np.asarray(root["var"][selected_key][:], dtype=np.bool_)
    if not selected_mask.any():
        return StageResult(
            False,
            refused=(
                "the HVG selection is empty, so quality control left no gene "
                "the model could be given"
            ),
        )

    # All cells, top-n_selected genes. Only the selected panel is made dense,
    # so the working copy is as wide as the panel and not as wide as the store.
    n_bins = int(params.get("n_bins", BINNING_N_BINS))
    sub_X = _select_columns_dense(X, selected_mask)
    binned = _compute_per_cell_binning(sub_X, n_bins=n_bins)

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

    unreadable = _consolidate(root, zarr_path, "binning", logger)
    if unreadable:
        return StageResult(False, refused=unreadable)

    logger.info(
        f"{zarr_path.name}: wrote per-cell {BINNING_N_BINS}-bin discretisation "
        f"({binned.shape[0]} cells x {binned.shape[1]} selected HVGs)"
    )
    return StageResult(
        True,
        stats={
            "n_bins": BINNING_N_BINS,
            "n_cells": int(binned.shape[0]),
            "n_genes": int(binned.shape[1]),
        },
    )


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


def _compute_qc_masks(X, min_genes_per_cell: int, min_cells_per_gene: int):
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
        min_genes_per_cell: a cell is kept when it has at least this many
            detected genes. The manuscript's value is 250.
        min_cells_per_gene: a gene is kept when it is detected in at least this
            many cells. The manuscript's value is 250.

    Returns:
        ``(cell_mask, gene_mask, detected_per_cell, cells_per_gene)``. The two
        masks are bool, True means keep. The two counts are returned rather
        than discarded because they are what the thresholds were compared
        against, and showing an operator the distribution their threshold cuts
        through is the only way the number means anything to them.
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

    cell_mask = np.asarray(detected_per_cell) >= int(min_genes_per_cell)
    gene_mask = np.asarray(cells_per_gene) >= int(min_cells_per_gene)
    return (
        cell_mask.astype(bool),
        gene_mask.astype(bool),
        np.asarray(detected_per_cell),
        np.asarray(cells_per_gene),
    )


def _log_histogram(values, edges=None):
    """A log-spaced histogram of a per-cell or per-gene count, as plain lists.

    The quantities the thresholds are compared against are heavy-tailed: most
    genes are detected in a handful of cells and a few in nearly all of them. A
    linear histogram puts everything in the first bin and says nothing, which
    is why an operator currently cannot see where their threshold falls.

    The bins are FIXED rather than derived from the data, which matters more
    than it looks. A dataset is a directory of several stores, and the UI shows
    one distribution per dataset, so the per-store histograms have to be added
    together. Data-derived edges differ per store, and adding counts across
    differing edges is not addition, it is a re-binning that invents a
    distribution within each bin. Fixed edges make the merge exact, and the
    cost is a few empty bins at either end.

    Zeros are counted separately rather than dropped. A store's number of
    never-detected genes is worth seeing and log bins have nowhere to put it.

    Returns:
        ``(counts, edges, n_zero)``. Lists, not arrays, because these go
        straight into a zarr root attribute and over the wire as JSON.
    """
    grid = list(QC_HIST_EDGES if edges is None else edges)
    values = np.asarray(values)
    if values.size == 0:
        return [], grid, 0
    n_zero = int(np.count_nonzero(values <= 0))
    positive = values[values > 0]
    if positive.size == 0:
        return [0] * (len(grid) - 1), grid, n_zero

    # Clipped into the end bins rather than dropped. A value outside the grid
    # is a real observation, and losing it would understate the total. Clipping
    # the LOW end also matters: an edge that overshoots the minimum through
    # floating point drops every value tied at it, which on a cells-per-gene
    # distribution can be thousands of genes.
    clipped = np.clip(positive, grid[0], np.nextafter(grid[-1], 0))
    counts, _ = np.histogram(clipped, bins=grid)
    return [int(c) for c in counts], grid, n_zero


def _compute_hvg_score(X, cell_mask: Optional[np.ndarray] = None) -> np.ndarray:
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
    normal machine and not being able to prepare it at all.

    ``cell_mask`` restricts the score to the cells that survived quality
    control, which is where the Methods put it: "we identified 1,200 highly
    variable genes (HVGs) within each dataset after quality control". A gene
    that varies wildly across empty droplets is an artefact of the droplets,
    and scoring it against them is how it ends up in the panel. The mask is
    applied a row block at a time, so excluding cells does not cost the
    full-length row-index array this function exists to avoid.

    Args:
        X: (n_cells, n_genes) array-like. A sparse CSR or CSC matrix is read
           through its stored arrays; anything else is treated as dense.
        cell_mask: optional bool array of length n_cells, True to include.
            None scores every cell.

    Returns:
        float32 array of length n_genes.
    """
    n_cells, n_genes = int(X.shape[0]), int(X.shape[1])
    if n_cells == 0 or n_genes == 0:
        return np.zeros(n_genes, dtype=np.float32)

    if cell_mask is not None:
        cell_mask = np.asarray(cell_mask, dtype=bool)
        if cell_mask.shape[0] != n_cells:
            raise ValueError(
                f"cell_mask has {cell_mask.shape[0]} entries but X has "
                f"{n_cells} rows"
            )
        n_used = int(cell_mask.sum())
        if n_used == 0:
            return np.zeros(n_genes, dtype=np.float32)
    else:
        n_used = n_cells

    columns = _sparse_column_ids(X)
    is_csr = columns is not None and getattr(X, "format", None) == "csr"

    if columns is not None and (cell_mask is None or not is_csr):
        # No mask, or CSC where a row restriction cannot be done blockwise.
        # float64 throughout: the stored values are float32, and E[X^2] on a
        # count matrix is large enough that accumulating it at float32 would
        # lose digits the subtraction below then depends on.
        values = np.asarray(X.data, dtype=np.float64)
        if cell_mask is not None:
            # CSC: X.indices holds row ids, which is exactly the selector.
            keep = cell_mask[np.asarray(X.indices, dtype=np.intp)]
            values, columns = values[keep], columns[keep]
        total = np.bincount(columns, weights=values, minlength=n_genes)
        total_sq = np.bincount(columns, weights=values * values, minlength=n_genes)
    elif columns is not None:
        # CSR with a mask. One row block at a time, so the temporaries are
        # bounded by the block rather than by the number of stored values.
        indptr = np.asarray(X.indptr, dtype=np.int64)
        total = np.zeros(n_genes, dtype=np.float64)
        total_sq = np.zeros(n_genes, dtype=np.float64)
        block = 8192
        for start in range(0, n_cells, block):
            stop = min(n_cells, start + block)
            lo, hi = int(indptr[start]), int(indptr[stop])
            if hi <= lo:
                continue
            rows = np.repeat(
                np.arange(start, stop), np.diff(indptr[start : stop + 1])
            )
            keep = cell_mask[rows]
            if not keep.any():
                continue
            cols = columns[lo:hi][keep]
            vals = np.asarray(X.data[lo:hi], dtype=np.float64)[keep]
            total += np.bincount(cols, weights=vals, minlength=n_genes)
            total_sq += np.bincount(cols, weights=vals * vals, minlength=n_genes)
    else:
        dense = np.asarray(X, dtype=np.float64)
        if dense.ndim != 2:
            raise ValueError(f"Expected 2D expression matrix, got shape {dense.shape}")
        if cell_mask is not None:
            dense = dense[cell_mask]
        means = dense.mean(axis=0)
        vars_ = dense.var(axis=0)
        score = np.where(means > 1e-12, vars_ / (means + 1e-12), 0.0)
        return score.astype(np.float32)

    means = total / n_used
    # Population variance (ddof=0), matching what np.var returned here.
    # Rounding can push an all-equal column a hair below zero.
    vars_ = np.maximum(total_sq / n_used - means * means, 0.0)
    score = np.where(means > 1e-12, vars_ / (means + 1e-12), 0.0)
    return score.astype(np.float32)


def _ensure_qc(zarr_path: Path, params: Mapping[str, Any], logger) -> StageResult:
    """Write obs/chiron_qc_cell_mask and var/chiron_qc_gene_mask.

    Stage 2 of the manuscript's pipeline, and the step HVG selection has to run
    behind. Both thresholds come from ``params`` rather than from a constant,
    because they are the site's call: the manuscript's 250 was chosen against
    datasets far larger than many sites hold, and on a small store "detected in
    at least 250 cells" removes most of the gene panel.

    Whether this needs to run at all is decided by the recipe planner, not
    here. A stage that re-checked its own version attribute would be checking
    the wrong thing, because two different thresholds write the same two keys.

    Refuses on a store that was already reduced upstream, which is not a
    conservative default but a correctness one. The cell filter counts detected
    genes against the full panel it was defined on. Applied to a store already
    cut to 1,200 highly variable genes it removes most real cells rather than
    empty droplets: on the blood shard of the 1M corpus, 178,970 of 250,000.
    """
    min_genes_per_cell = int(params["min_genes_per_cell"])
    min_cells_per_gene = int(params["min_cells_per_gene"])

    root = zarr.open_group(str(zarr_path), mode="r+")
    if "var" not in root or "obs" not in root:
        return StageResult(False, refused="this store has no var/ or obs/ group")

    var_group, obs_group = root["var"], root["obs"]
    var_index = _find_key(root, "var", "_index") or "_index"
    n_vars = int(var_group[var_index].shape[0])

    reason = _detect_upstream_reduction(root, n_vars)
    if reason is not None:
        if _read_attr(root, UPSTREAM_REDUCED_KEY) is not True:
            root.attrs[UPSTREAM_REDUCED_KEY] = True
            root.attrs[UPSTREAM_REDUCED_WHY_KEY] = reason
        logger.info(f"{zarr_path.name}: QC skipped, already reduced ({reason})")
        return StageResult(False, refused=reason)

    X = _open_x(root, zarr_path, logger)
    if X is None:
        return StageResult(False, refused="X could not be read from this store")

    cell_mask, gene_mask, detected_per_cell, cells_per_gene = _compute_qc_masks(
        X, min_genes_per_cell, min_cells_per_gene
    )

    obs_group.create_array(
        QC_CELL_MASK_KEY, shape=cell_mask.shape, dtype=cell_mask.dtype, overwrite=True
    )[:] = cell_mask
    var_group.create_array(
        QC_GENE_MASK_KEY, shape=gene_mask.shape, dtype=gene_mask.dtype, overwrite=True
    )[:] = gene_mask

    n_cells_kept, n_genes_kept = int(cell_mask.sum()), int(gene_mask.sum())
    cell_counts, cell_edges, cell_zero = _log_histogram(detected_per_cell)
    gene_counts, gene_edges, gene_zero = _log_histogram(cells_per_gene)

    stats = {
        "min_genes_per_cell": min_genes_per_cell,
        "min_cells_per_gene": min_cells_per_gene,
        "n_cells_total": int(cell_mask.size),
        "n_cells_kept": n_cells_kept,
        "n_genes_total": int(gene_mask.size),
        "n_genes_kept": n_genes_kept,
        # The distributions the thresholds cut through. Aggregate counts per
        # bin, never a per-cell or per-gene value, so this says what the filter
        # did without saying anything about any one cell.
        "detected_per_cell_counts": cell_counts,
        "detected_per_cell_edges": cell_edges,
        "detected_per_cell_zero": cell_zero,
        "cells_per_gene_counts": gene_counts,
        "cells_per_gene_edges": gene_edges,
        "cells_per_gene_zero": gene_zero,
    }

    root.attrs["chiron_qc_version"] = QC_VERSION
    for key, value in stats.items():
        root.attrs[f"chiron_qc_{key}"] = value

    # These stores carry consolidated metadata, so an array written after the
    # fact is invisible to any reader that goes through the consolidated index,
    # including a plain zarr.open_group. Without this the masks are on disk and
    # unreadable, which is the quietest possible way for this step to fail.
    unreadable = _consolidate(root, zarr_path, "QC", logger)
    if unreadable:
        return StageResult(False, refused=unreadable)

    logger.info(
        f"{zarr_path.name}: QC kept {n_cells_kept:,}/{cell_mask.size:,} cells "
        f"(>= {min_genes_per_cell} detected genes) and "
        f"{n_genes_kept:,}/{gene_mask.size:,} genes "
        f"(detected in >= {min_cells_per_gene} cells)"
    )
    return StageResult(True, stats=stats)


def _consolidate(root, zarr_path: Path, what: str, logger) -> Optional[str]:
    """Rebuild the consolidated metadata index, or say why it could not be.

    Every stage that creates an array has to call this. These stores carry
    consolidated metadata, so an array written after the fact is invisible to
    any reader that goes through the consolidated index, which is every reader
    including a plain ``zarr.open_group``.

    Returns a reason on failure rather than only logging one, and the caller
    turns that into a refusal. A stage whose consolidation failed has written
    an artifact no reader can see, and recording it as satisfied would leave
    the store advertising a preparation that is not there: the attribute says
    the cells were filtered, the mask is on disk, and nothing can read it. That
    is the exact failure this helper exists to prevent, so it is the one error
    here that must not be swallowed.

    Returns:
        None when the index was rebuilt, otherwise a human-readable reason.
    """
    try:
        zarr.consolidate_metadata(root.store)
        return None
    except Exception as e:
        reason = (
            f"the consolidated metadata index could not be rebuilt after "
            f"{what}, so what it wrote is on disk and invisible to every "
            f"reader ({type(e).__name__}: {e})"
        )
        logger.warning(f"{zarr_path.name}: {reason}")
        return reason


def _read_qc_masks(root, n_cells: int, n_vars: int):
    """``(cell_mask, gene_mask)`` from the store, or ``(None, None)``.

    Returns None rather than an all-True mask when a mask is absent, so a
    caller cannot mistake "quality control did not run" for "quality control
    kept everything". The planner should have blocked any stage that gets here
    without them, and a stage that finds them missing anyway has hit a bug
    rather than a configuration.
    """
    cell_key = _find_key(root, "obs", QC_CELL_MASK_KEY)
    gene_key = _find_key(root, "var", QC_GENE_MASK_KEY)
    if cell_key is None or gene_key is None:
        return None, None
    cell_mask = np.asarray(root["obs"][cell_key][:], dtype=bool)
    gene_mask = np.asarray(root["var"][gene_key][:], dtype=bool)
    if cell_mask.size != n_cells or gene_mask.size != n_vars:
        return None, None
    return cell_mask, gene_mask


def _ensure_hvg_rank(
    zarr_path: Path, params: Mapping[str, Any], logger
) -> StageResult:
    """Add var/chiron_hvg_rank + var/chiron_hvg_score to an existing zarr.

    Runs behind quality control, which is where the Methods put it: "we
    identified 1,200 highly variable genes (HVGs) within each dataset after
    quality control". Two consequences, and both change which genes end up in
    the panel.

    Cells that quality control dropped are excluded from the score. A gene that
    varies wildly across empty droplets is an artefact of the droplets, and
    scoring against them is how it reaches the panel.

    Genes that quality control dropped cannot be selected at all. Their score
    is forced to zero so they rank last, rather than being removed from the
    arrays: ``var/`` columns must stay the length of ``var``, and a reader that
    looks up gene *i* has to get gene *i*.

    This stage has no parameters of its own. The panel width is the model's
    input width, and changing it would mean the checkpoint no longer fits its
    own input. It is still recomputed whenever quality control is, because its
    inputs moved even though its settings did not, which is the case a presence
    check cannot see and the recipe planner exists to catch.
    """
    root = zarr.open_group(str(zarr_path), mode="r+")
    if "var" not in root:
        return StageResult(False, refused="this store has no var/ group")

    var_group = root["var"]

    # Refuse before measuring anything, not after. A store that arrives already
    # reduced to a model panel is recorded as such and left alone: re-scoring
    # HVGs on an upstream selection would silently replace it with a ranking
    # computed over a different matrix. See UPSTREAM_REDUCED_KEY for the
    # measured consequence.
    index_key = _find_key(root, "var", "_index") or "_index"
    n_vars = int(var_group[index_key].shape[0])
    reason = _detect_upstream_reduction(root, n_vars)
    if reason is not None:
        if _read_attr(root, UPSTREAM_REDUCED_KEY) is not True:
            root.attrs[UPSTREAM_REDUCED_KEY] = True
            root.attrs[UPSTREAM_REDUCED_WHY_KEY] = reason
        logger.info(
            f"{zarr_path.name}: already reduced upstream ({reason}). "
            f"Leaving the gene panel as it is."
        )
        return StageResult(False, refused=reason)

    X = _open_x(root, zarr_path, logger)
    if X is None:
        return StageResult(False, refused="X could not be read from this store")

    n_cells, n_vars = int(X.shape[0]), int(X.shape[1])
    if n_vars == 0:
        return StageResult(False, refused="this store has no genes")

    cell_mask, gene_mask = _read_qc_masks(root, n_cells, n_vars)
    if cell_mask is None:
        return StageResult(
            False,
            refused=(
                "the quality-control masks are absent or the wrong length, so "
                "there is nothing to select 'after quality control' from"
            ),
        )
    if not cell_mask.any():
        return StageResult(
            False,
            refused=(
                "quality control kept no cells, so there is nothing to score "
                "gene variability across"
            ),
        )

    # Per-gene over-dispersion (variance / mean), across surviving cells only.
    score = _compute_hvg_score(X, cell_mask=cell_mask)
    score = np.where(gene_mask, score, 0.0).astype(np.float32)

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
    # the pre-cut binned layer. The top n_selected by rank, where n_selected is
    # the model's input width capped by how many genes survived quality
    # control. Capping by the survivors rather than by n_vars is the whole
    # point: a gene the gene filter removed has score 0 above, so without the
    # cap the panel would fill its remaining slots with exactly the genes that
    # were just excluded, ordered by nothing.
    n_available = int(gene_mask.sum())
    n_selected = int(min(int(params.get("n_hvg", MODEL_IN_FEATURE)), n_available))
    selected_mask = np.zeros(n_vars, dtype=np.bool_)
    if n_selected > 0:
        # Masked as well as capped. Capping the COUNT is not the same as
        # constraining membership: every excluded gene scores 0 above, and when
        # fewer genes have a strictly positive score than there are slots, the
        # argsort fills the rest by tie-breaking across the zero-score genes,
        # which are exactly the ones quality control just removed. The two
        # filters are computed concurrently against the original matrix by
        # design, so a gene detected in enough cells that all fail the cell
        # filter reaches this point with a real gene_mask and a zero score.
        selected_mask = ((rank < n_selected) & gene_mask).astype(np.bool_)
    sel_arr = var_group.create_array(
        HVG_SELECTED_KEY,
        shape=selected_mask.shape,
        dtype=selected_mask.dtype,
        overwrite=True,
    )
    sel_arr[:] = selected_mask

    for key in (HVG_RANK_KEY, HVG_SCORE_KEY, HVG_SELECTED_KEY):
        _drop_legacy_key(root, "var", key)

    counts, edges, _ = _log_histogram(
        score[selected_mask | gene_mask], edges=HVG_SCORE_HIST_EDGES
    )
    stats = {
        "method": HVG_METHOD,
        "in_feature": int(MODEL_IN_FEATURE),
        "n_selected": int(selected_mask.sum()),
        "n_available": n_available,
        "n_cells_scored": int(cell_mask.sum()),
        # True when the gene filter left fewer genes than the model's input
        # width, so the model will train on a narrower panel than it was
        # designed for. An operator has to be told this rather than left to
        # infer it from two numbers being unequal.
        "panel_short": bool(n_available < MODEL_IN_FEATURE),
        "score_histogram_counts": counts,
        "score_histogram_edges": edges,
    }
    root.attrs["chiron_hvg_version"] = HVG_VERSION
    root.attrs["chiron_hvg_method"] = HVG_METHOD
    root.attrs["chiron_hvg_in_feature"] = int(MODEL_IN_FEATURE)
    root.attrs["chiron_hvg_n_selected"] = int(selected_mask.sum())
    root.attrs["chiron_hvg_n_available"] = n_available
    root.attrs["chiron_hvg_n_cells_scored"] = int(cell_mask.sum())
    root.attrs["chiron_hvg_panel_short"] = stats["panel_short"]

    # Rebuild the zarr-v3 consolidated metadata so the newly-written arrays
    # appear in subsequent opens. AnnData's writer leaves a consolidated
    # block listing only its own columns; without this call the trainer
    # would not see chiron_hvg_rank/score in var.keys().
    unreadable = _consolidate(root, zarr_path, "HVG ranking", logger)
    if unreadable:
        return StageResult(False, refused=unreadable)

    if stats["panel_short"]:
        logger.warning(
            f"{zarr_path.name}: quality control left {n_available:,} genes, "
            f"fewer than the model's input width {MODEL_IN_FEATURE:,}, so the "
            f"panel is narrower than the model was designed for"
        )
    logger.info(
        f"{zarr_path.name}: ranked {len(rank)} genes by HVG ({HVG_METHOD}) "
        f"across {int(cell_mask.sum()):,} cells that passed quality control, "
        f"selected {int(selected_mask.sum()):,} of {n_available:,} available"
    )
    return StageResult(True, stats=stats)


def _ensure_hvg_histogram(
    zarr_path: Path, params: Mapping[str, Any], logger
) -> StageResult:
    """Write a 20-bin log-scaled histogram of HVG scores into the root attrs.

    Runs behind the ranking, so the scores it summarises are the post-quality
    -control ones. Stores bin edges alongside the counts so the UI can render
    the histogram without re-deriving them, and sends 20 integers rather than
    one float per gene.
    """
    root = zarr.open_group(str(zarr_path), mode="r+")

    score_key = _find_key(root, "var", HVG_SCORE_KEY)
    if score_key is None:
        return StageResult(
            False,
            refused="var/chiron_hvg_score is absent, so there is nothing to summarise",
        )

    score = root["var"][score_key][:]
    positive = score[score > 0]
    if positive.size == 0:
        return StageResult(
            False,
            refused=(
                "every gene scored zero variability, which means the matrix is "
                "empty or constant and a histogram of it would say nothing"
            ),
        )

    # Binned onto the fixed score grid, not onto edges derived from this
    # store's own minimum and maximum.
    #
    # Derived edges are not an axis label, they are data: the lowest edge IS
    # the exact over-dispersion score of one gene in this dataset and the
    # highest is another's, and both would leave the site in a root attribute
    # the manager serves to the organiser. A federated platform that sends only
    # bin counts and then sends the two extreme values as the axis has sent two
    # per-gene measurements.
    #
    # Fixed edges also make a dataset's files add together, which is what the
    # UI shows.
    counts_list, edges_list, _ = _log_histogram(
        positive, edges=HVG_SCORE_HIST_EDGES
    )
    counts = np.asarray(counts_list, dtype=np.int32)
    # Reported as log10, which is what the existing readers expect.
    edges = np.log10(np.asarray(edges_list, dtype=np.float64))

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

    unreadable = _consolidate(root, zarr_path, "the HVG histogram", logger)
    if unreadable:
        return StageResult(False, refused=unreadable)

    logger.info(
        f"{zarr_path.name}: wrote {HVG_SCORE_HIST_BINS}-bin HVG score histogram"
    )
    return StageResult(
        True,
        stats={
            "counts": counts.tolist(),
            "edges_log10": edges.astype(np.float32).tolist(),
        },
    )


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


def _streaming_pca_then_umap(zarr_path: Path, root, logger, cell_mask=None):
    """Inner helper for _ensure_umap_embedding: stream the binned layer through
    IncrementalPCA, take a deterministic subsample if there are more eligible
    cells than UMAP_MAX_SAMPLES, run UMAP on that subsample.

    ``cell_mask`` restricts every step to the cells that passed quality
    control, because the embedding is a picture of what the model will actually
    be trained on. Including dropped cells would show the operator structure
    that the run never sees, and empty droplets cluster, so they would show up
    as a confident blob that means nothing.

    Returns ``(coords float32[m,2], indices int32[m] or None)``. The indices are
    row indices into the binned layer, and are None only when the coordinates
    cover every row in order. A mask that drops anything therefore always
    produces indices, because without them a reader cannot tell which cell a
    point belongs to.
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
    if x_node is None:
        raise RuntimeError("the binned layer is absent or unreadable")

    # Eligible rows, in order. Everything below indexes through this rather
    # than through arange(n_cells), so there is one place where the mask is
    # applied and no path that forgets it.
    if cell_mask is not None and cell_mask.size == n_cells and not cell_mask.all():
        eligible = np.flatnonzero(cell_mask).astype(np.int64)
    else:
        eligible = np.arange(n_cells, dtype=np.int64)
    n_eligible = int(eligible.size)

    if n_eligible < UMAP_N_NEIGHBORS + 1 or n_vars < 2:
        raise RuntimeError(
            f"Dataset too small for UMAP (binned shape n_cells={n_cells}, "
            f"n_selected={n_vars}, cells past quality control={n_eligible})"
        )

    # Compute a streaming batch size that respects the byte budget and the
    # IncrementalPCA constraint n_components <= batch_size.
    bytes_per_cell = max(1, n_vars * 4)
    target_batch = max(PCA_N_COMPONENTS + 1, PCA_BATCH_BYTES_BUDGET // bytes_per_cell)
    batch_size = int(min(n_eligible, max(PCA_N_COMPONENTS + 1, target_batch)))
    n_components = min(PCA_N_COMPONENTS, n_vars, n_eligible - 1)

    logger.info(
        f"{zarr_path.name}: streaming PCA on the binned layer "
        f"(n_cells={n_cells}, past quality control={n_eligible}, "
        f"n_selected={n_vars}, batch={batch_size}, components={n_components})"
    )

    def _read_rows(rows):
        """A block of the binned layer, by row index.

        A contiguous slice when the rows happen to be contiguous, which is the
        common case of an unmasked store, and an orthogonal selection
        otherwise. zarr reads a slice far faster than a fancy index, so this is
        worth the branch.
        """
        if rows.size and rows[-1] - rows[0] == rows.size - 1:
            return np.asarray(x_node[int(rows[0]) : int(rows[-1]) + 1, :], dtype=np.float64)
        return np.asarray(
            x_node.get_orthogonal_selection((rows, slice(None))), dtype=np.float64
        )

    ipca = IncrementalPCA(n_components=n_components)
    for start in range(0, n_eligible, batch_size):
        stop = min(start + batch_size, n_eligible)
        if stop - start < n_components:
            # Tail batch can be smaller than n_components; IncrementalPCA would
            # raise. Pad by re-using the previous start.
            start = max(0, n_eligible - n_components)
            stop = n_eligible
        ipca.partial_fit(_read_rows(eligible[start:stop]))
        if stop == n_eligible:
            break

    # Choose the subsample for UMAP, always out of the eligible rows.
    rng = np.random.default_rng(UMAP_RANDOM_STATE)
    if n_eligible > UMAP_MAX_SAMPLES:
        picked = np.sort(rng.choice(n_eligible, size=UMAP_MAX_SAMPLES, replace=False))
        indices = eligible[picked]
    elif n_eligible < n_cells:
        # Every eligible cell, but that is not every cell, so a reader still
        # needs the index to know which is which.
        indices = eligible
    else:
        indices = None  # coordinates cover every row of the layer, in order

    # Transform subsample (or full) through the PCA fit, in the same batches.
    def transform_indices(idx_array):
        # Reading arbitrary fancy indices from zarr is slow; chunk by contiguous
        # ranges keyed on the sorted indices.
        out = np.empty((len(idx_array), n_components), dtype=np.float32)
        i = 0
        while i < len(idx_array):
            j = i + batch_size
            out[i:j] = ipca.transform(_read_rows(idx_array[i:j])).astype(np.float32)
            i = j
        return out

    idx_for_transform = eligible if indices is None else indices
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


def _ensure_umap_embedding(
    zarr_path: Path, params: Mapping[str, Any], logger
) -> StageResult:
    """Write a 2-D UMAP embedding into obsm/, computed on layers/chiron_binned.

    Operates on the pre-cut binned layer so the embedding shows exactly the
    matrix the trainer consumes, and only on the cells that passed quality
    control, so it shows exactly the cells the run will see.

    Computes coordinates on a deterministic subsample when there are more
    eligible cells than UMAP_MAX_SAMPLES, so memory stays bounded.

    Stores:
      obsm/chiron_umap_coords  float32 (m, 2)
      obsm/chiron_umap_indices int32   (m,)  row indices into chiron_binned,
                                             absent only when the coordinates
                                             cover every row in order
      root attrs: chiron_umap_version, chiron_umap_method, chiron_umap_n_sampled

    Refusing here is cheap. The embedding is a picture for the dataset card and
    nothing trains on it, so a site without umap-learn installed loses the
    picture and nothing else.
    """
    root = zarr.open_group(str(zarr_path), mode="r+")

    x_node, n_cells, _ = _read_binned_node(root)
    if x_node is None:
        return StageResult(False, refused="the binned layer is absent or unreadable")
    var_index = _find_key(root, "var", "_index") or "_index"
    n_vars_total = int(root["var"][var_index].shape[0]) if "var" in root else 0
    cell_mask, _ = _read_qc_masks(root, n_cells, n_vars_total)
    if cell_mask is None:
        # Refused, not treated as "keep everything". _read_qc_masks returns
        # None rather than an all-True mask precisely so that "quality control
        # did not run" cannot be mistaken for "quality control kept every
        # cell", and silently embedding the excluded cells would show the
        # operator structure the run will never see. Empty droplets cluster, so
        # they would appear as a confident blob that means nothing.
        return StageResult(
            False,
            refused=(
                "the quality-control cell mask is absent or the wrong length, "
                "so the embedding cannot be restricted to the cells this run "
                "will train on"
            ),
        )

    try:
        coords, indices = _streaming_pca_then_umap(
            zarr_path, root, logger, cell_mask=cell_mask
        )
    except RuntimeError as e:
        # Includes umap-learn-not-installed and "too small" cases.
        logger.warning(f"{zarr_path.name}: UMAP skipped: {e}")
        return StageResult(False, refused=str(e))
    except Exception as e:
        logger.warning(f"{zarr_path.name}: UMAP failed: {type(e).__name__}: {e}")
        return StageResult(False, refused=f"{type(e).__name__}: {e}")

    # Make sure obsm exists.
    # The returned group, not a re-lookup. A re-lookup goes through the
    # consolidated index, which does not fall back to the store, so it raises
    # KeyError on the group that was just created.
    obsm_group = root["obsm"] if "obsm" in root else root.create_group("obsm")
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

    unreadable = _consolidate(root, zarr_path, "UMAP", logger)
    if unreadable:
        return StageResult(False, refused=unreadable)

    logger.info(
        f"{zarr_path.name}: wrote UMAP embedding "
        f"({coords.shape[0]} cells {'(a subset)' if indices is not None else '(all cells)'}, "
        f"{UMAP_METHOD})"
    )
    return StageResult(
        True,
        stats={
            "method": UMAP_METHOD,
            "n_sampled": int(coords.shape[0]),
            "n_neighbors": int(UMAP_N_NEIGHBORS),
            "subset": indices is not None,
        },
    )


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


def _read_var_strings(var_group, key: str) -> Optional[np.ndarray]:
    """A ``var`` column as a flat array of strings, or None if it cannot be.

    AnnData picks a column's on-disk encoding from its pandas dtype, so the
    same logical column arrives as a plain array, as a ``categorical`` group of
    ``categories`` and ``codes``, or as a ``nullable-string-array`` group of
    ``values`` and a ``mask``. Which one depends on nothing more than whether
    that site's reference happens to have duplicate entries.

    Indexing the column directly therefore works on some stores and raises on
    others. That is not a cosmetic difference here: the trainer reads this
    column through a decoder that handles all three, so a server that silently
    failed on a categorical column and fell back to a different column would
    build its gene ordering against one set of ids while the trainer mapped it
    through another. Both sides would look fine and the tokens would be wrong.

    Mirrors ``read_var_strings`` in the trainer base, deliberately. The two
    cannot be shared, because this package must not import a model's code, so
    they are kept identical instead.
    """
    if key not in var_group:
        return None
    node = var_group[key]
    try:
        if isinstance(node, zarr.Group):
            encoding = node.attrs.get("encoding-type")
            if encoding == "categorical":
                categories = np.asarray(node["categories"][:]).astype(str)
                codes = np.asarray(node["codes"][:]).astype(np.int64)
                # A -1 code is pandas' NaN category. Appending the sentinel
                # lets it index the same table as every real code.
                table = np.concatenate([categories, np.array([""], dtype=categories.dtype)])
                return table[np.where(codes < 0, len(categories), codes)]
            if encoding == "nullable-string-array":
                values = np.asarray(node["values"][:]).astype(str)
                mask = np.asarray(node["mask"][:]).astype(bool)
                return np.where(mask, "", values)
            return None
        return np.asarray(node[:]).astype(str)
    except Exception:
        return None


def _read_ensembl_ids(root, var_group, var_index: str, vocabulary, logger):
    """``(ensembl_ids, source_column)`` for this store, or ``(None, None)``.

    Ensembl ids are the join key between a store and Geneformer's corpus, and
    where they live depends on who staged the data. Chiron-prepared datasets
    carry them in ``var/feature_id``. Data taken straight from CELLxGENE
    carries them in the ``var`` index instead, with no ``feature_id`` column at
    all, which is the common case for a site bringing its own data.

    The column is chosen by MEASURING which one matches more of Geneformer's
    vocabulary, not by a regex that guesses which one looks like Ensembl ids.
    A guess has to pick a threshold, and any threshold is wrong somewhere: a
    panel that is mostly Ensembl ids with a tail of antibody-capture or ATAC
    features is a real panel and a majority test rejects it, while a column of
    the right shape and the wrong content passes. Counting vocabulary hits
    answers the question that actually matters, which is how many genes this
    store can contribute, and the trainer can arrive at the same answer from
    the same two columns without either side having to trust the other.
    """
    best_values = None
    best_label = None
    best_hits = 0
    for key, label in (
        (_find_key(root, "var", "feature_id"), "feature_id"),
        (var_index, "_index"),
    ):
        if key is None:
            continue
        values = _read_var_strings(var_group, key)
        if values is None:
            logger.warning(
                f"var/{key} is stored in an encoding this server cannot read as "
                f"strings, so it cannot be used to identify genes"
            )
            continue
        hits = int(sum(1 for value in values if value in vocabulary))
        if hits > best_hits:
            best_values, best_label, best_hits = values, label, hits

    if best_values is None or best_hits == 0:
        return None, None
    return best_values, best_label


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


def _compute_geneformer_ranks(
    X, col_to_slot, medians_by_slot, max_ranks, cell_mask=None, row_block=4096
):
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

        for offset, (cols, counts) in enumerate(block_rows):
            # A cell below the optional detected-genes floor is ranked as
            # empty rather than removed, so row i of the ordering is still
            # cell i of obs. A reader that joined by position would otherwise
            # silently shift by however many cells were dropped above it.
            if cell_mask is not None and not cell_mask[start + offset]:
                per_cell.append(np.empty(0, dtype=index_dtype))
                n_empty += 1
                continue
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


def _ensure_geneformer_ranks(
    zarr_path: Path, params: Mapping[str, Any], logger
) -> StageResult:
    """Write uns/chiron_geneformer_gc104M/{rank_indptr,rank_indices}.

    Whether this needs to run is the recipe planner's decision, which is how
    the request's "a dataset preprocessed with this protocol before should not
    be processed again" is honoured: the planner compares the recorded stage
    fingerprint, and the fingerprint covers the pinned dictionary revision, the
    rank cap and the cell filter.

    Touches nothing outside its own group under ``uns/``. X, var, obs, layers
    and obsm are read and never written, so running this after Tabula's quality
    control, HVG ranking, binning and UMAP leaves all four byte-identical, and
    running it first changes nothing they go on to compute.
    """
    min_genes_per_cell = int(params.get("geneformer_min_genes_per_cell", 0))

    root = zarr.open_group(str(zarr_path), mode="r+")
    if "var" not in root:
        return StageResult(False, refused="this store has no var/ group")

    var_group = root["var"]
    var_index = _find_key(root, "var", "_index") or "_index"
    n_vars = int(var_group[var_index].shape[0])

    X = _open_x(root, zarr_path, logger)
    if X is None:
        return StageResult(False, refused="X could not be read from this store")
    if getattr(X, "format", "csr") == "csc":
        reason = (
            "X is stored column-major (CSC) and ranking reads a cell as a row, "
            "so this store would have to be transposed first"
        )
        logger.info(f"{zarr_path.name}: Geneformer ranking skipped ({reason})")
        return StageResult(False, refused=reason)

    reason = _detect_geneformer_unsuitable(root, n_vars, X)
    if reason is not None:
        if _read_attr(root, GENEFORMER_UNSUITABLE_KEY) is not True:
            root.attrs[GENEFORMER_UNSUITABLE_KEY] = True
            root.attrs[GENEFORMER_UNSUITABLE_WHY_KEY] = reason
        logger.info(f"{zarr_path.name}: Geneformer ranking skipped ({reason})")
        return StageResult(False, refused=reason)

    n_cols = int(X.shape[1])

    # The vocabulary is loaded BEFORE the gene-id column is chosen, because the
    # column is chosen by how many of its values the vocabulary contains.
    try:
        tokens, medians = _load_geneformer_vocabulary(logger)
    except Exception as e:
        logger.warning(f"{zarr_path.name}: Geneformer ranking skipped, {e}")
        return StageResult(False, refused=str(e))

    ensembl, feature_key = _read_ensembl_ids(
        root, var_group, var_index, tokens, logger
    )
    if ensembl is None:
        reason = (
            "no column of var matches Geneformer's vocabulary, so there is "
            "nothing to join this store's genes against. Geneformer's corpus "
            "is keyed by Ensembl gene id, and this store appears to be keyed "
            "by something else"
        )
        root.attrs[GENEFORMER_UNSUITABLE_KEY] = True
        root.attrs[GENEFORMER_UNSUITABLE_WHY_KEY] = reason
        logger.info(f"{zarr_path.name}: Geneformer ranking skipped ({reason})")
        return StageResult(False, refused=reason)
    if len(ensembl) != n_cols:
        reason = (
            f"var/{feature_key} has {len(ensembl):,} entries but X has "
            f"{n_cols:,} columns, so the gene ids do not line up with the matrix"
        )
        logger.warning(f"{zarr_path.name}: Geneformer ranking skipped, {reason}")
        return StageResult(False, refused=reason)

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
        return StageResult(False, refused=reason)

    col_to_slot = np.full(n_cols, -1, dtype=np.int64)
    col_to_slot[keep] = np.arange(keep.size, dtype=np.int64)

    # Geneformer's own tokenizer applies no cell filter, so the default is off.
    # A site that wants one gets it here: a cell below the threshold is ranked
    # as empty, which the trainer then has nothing to feed the model and skips,
    # rather than being deleted from a store other models still read.
    cell_floor = None
    if min_genes_per_cell > 0:
        if hasattr(X, "indptr"):
            detected = np.diff(np.asarray(X.indptr, dtype=np.intp))
        else:
            # A dense store. Reached by every path above, because the CSC
            # refusal tests `getattr(X, "format", "csr")`, which defaults a
            # dense array to "csr" and lets it through.
            detected = (np.asarray(X) > 0).sum(axis=1)
        cell_floor = np.asarray(detected) >= min_genes_per_cell

    indptr, indices, stats = _compute_geneformer_ranks(
        X,
        col_to_slot,
        gene_medians[keep],
        GENEFORMER_MAX_RANKS,
        cell_mask=cell_floor,
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

    # How many genes each cell contributes, as a distribution. This is the
    # Geneformer equivalent of the HVG histogram: it is what the model's input
    # length will be, and it is the one number an operator can act on when a
    # dataset trains badly. Aggregate bins only, never a per-cell length.
    lengths = np.diff(indptr)
    length_counts, length_edges, length_zero = _log_histogram(lengths)

    full_stats = {
        "revision": GENEFORMER_REVISION,
        "dictionary_set": GENEFORMER_DICTIONARY_SET,
        "max_ranks": GENEFORMER_MAX_RANKS,
        "min_genes_per_cell": min_genes_per_cell,
        "n_cells": int(X.shape[0]),
        "n_genes_usable": int(keep.size),
        "n_genes_total": n_cols,
        # Which var column the ids came from. The trainer compares this with
        # its own choice and derives the order itself if they differ, because
        # two sides resolving gene identity from different columns produces a
        # confident wrong ordering that nothing downstream can detect.
        "gene_id_column": feature_key,
        "n_ranked": int(indices.size),
        "n_cells_truncated": stats["n_truncated"],
        "n_cells_empty": stats["n_empty"],
        "ranked_per_cell_counts": length_counts,
        "ranked_per_cell_edges": length_edges,
        "ranked_per_cell_zero": length_zero,
    }

    root.attrs[GENEFORMER_VERSION_ATTR] = GENEFORMER_VERSION
    root.attrs[GENEFORMER_RECIPE_ATTR] = GENEFORMER_RECIPE
    for key, value in full_stats.items():
        root.attrs[f"chiron_geneformer_{key}"] = value
    # A store refused by an earlier, stricter pin that now passes should not
    # keep advertising a refusal that no longer holds.
    if _read_attr(root, GENEFORMER_UNSUITABLE_KEY) is not None:
        root.attrs[GENEFORMER_UNSUITABLE_KEY] = False
        root.attrs[GENEFORMER_UNSUITABLE_WHY_KEY] = ""

    # These stores carry consolidated metadata, so a group written after the
    # fact is invisible to any reader that goes through the consolidated index.
    # Without this the ordering is on disk and unreadable.
    unreadable = _consolidate(root, zarr_path, "Geneformer ranking", logger)
    if unreadable:
        return StageResult(False, refused=unreadable)

    logger.info(
        f"{zarr_path.name}: Geneformer ranked {X.shape[0]:,} cells over "
        f"{keep.size:,}/{n_cols:,} genes in Geneformer's vocabulary, "
        f"{indices.size:,} ranked entries "
        f"({stats['n_truncated']:,} cells truncated at {GENEFORMER_MAX_RANKS}, "
        f"{stats['n_empty']:,} with nothing usable)"
    )
    return StageResult(True, stats=full_stats)


# ---------------------------------------------------------------------------
# The recipes
# ---------------------------------------------------------------------------
#
# What each model needs done to a store, declared rather than hardcoded into a
# loop. The machinery is in chiron.datasets.recipes; this is the part that says
# what the stages are, what depends on what, and which numbers a site is
# allowed to change.
#
# Which numbers are adjustable is a judgement, not a convenience. Tabula's
# 1,200 genes and its 50 value bins are properties of a pretrained checkpoint:
# change them and the weights no longer fit their own input, so they are
# declared fixed and an attempt to set them is an error rather than a silently
# ignored field. The two quality-control thresholds are genuinely the site's
# call, because the manuscript's 250 was chosen against datasets far larger
# than many sites hold, and on a small store "detected in at least 250 cells"
# removes most of the gene panel.

PREP_ATTR_PREFIX = "chiron_prep_"

TABULA_RECIPE = Recipe(
    model_family="tabula",
    version=1,
    label="Tabula",
    description=(
        "Quality control, then 1,200 highly variable genes selected from what "
        "survives it, then a 50-bin per-cell discretisation of those genes. "
        "This is the preprocessing the Tabula manuscript's Methods describe, "
        "in the order they describe it."
    ),
    stages=(
        Stage(
            name="quality_control",
            version=QC_VERSION,
            label="Quality control",
            description=(
                "Mark the cells and genes that pass the two filters. Nothing is "
                "deleted: the masks are stored beside the data so another model "
                "can still read the full panel."
            ),
            run=_ensure_qc,
            params=(
                Param(
                    name="min_genes_per_cell",
                    default=QC_MIN_GENES_PER_CELL,
                    label="Minimum detected genes per cell",
                    unit="genes",
                    minimum=0,
                    maximum=100_000,
                    description=(
                        "A cell with fewer detected genes than this is excluded. "
                        "It removes empty droplets, non-viable cells and severely "
                        "degraded cells. The published value is 250."
                    ),
                ),
                Param(
                    name="min_cells_per_gene",
                    default=QC_MIN_CELLS_PER_GENE,
                    label="Minimum cells per gene",
                    unit="cells",
                    minimum=0,
                    maximum=10_000_000,
                    description=(
                        "A gene detected in fewer cells than this is excluded. It "
                        "counts CELLS, not total counts, so a gene expressed "
                        "enormously in a handful of cells is still removed. The "
                        "published value is 250. On a small dataset this is a "
                        "large fraction of the cells present, so lower it rather "
                        "than lose most of the panel."
                    ),
                ),
            ),
            outputs=("obs/" + QC_CELL_MASK_KEY, "var/" + QC_GENE_MASK_KEY),
        ),
        Stage(
            name="hvg_ranking",
            version=HVG_VERSION,
            label="Highly variable gene selection",
            description=(
                "Rank genes by over-dispersion across the cells that passed "
                "quality control, and select the model's input width from the "
                "genes that passed it."
            ),
            run=_ensure_hvg_rank,
            requires=("quality_control",),
            params=(
                Param(
                    name="n_hvg",
                    default=MODEL_IN_FEATURE,
                    label="Genes the model reads",
                    unit="genes",
                    adjustable=False,
                    description=(
                        "This is the model's input width, fixed by the checkpoint "
                        "being trained. A different number would not fit the "
                        "pretrained weights."
                    ),
                ),
            ),
            outputs=(
                "var/" + HVG_RANK_KEY,
                "var/" + HVG_SCORE_KEY,
                "var/" + HVG_SELECTED_KEY,
            ),
        ),
        Stage(
            name="var_columns",
            version=1,
            label="Column registration",
            description=(
                "Register the masks as dataframe columns, so a reader going "
                "through anndata sees them. Metadata only."
            ),
            run=_ensure_var_columns_visible,
            requires=("hvg_ranking",),
        ),
        Stage(
            name="hvg_histogram",
            version=HVG_HIST_VERSION,
            label="Variability distribution",
            description=(
                "A 20-bin summary of the variability scores, so the dataset card "
                "can show the distribution without sending one number per gene."
            ),
            run=_ensure_hvg_histogram,
            requires=("hvg_ranking",),
        ),
        Stage(
            name="binning",
            version=BINNING_VERSION,
            label="Value discretisation",
            description=(
                "Each cell's expression over the selected genes, discretised into "
                "equal-frequency bins. This is the matrix the trainer reads."
            ),
            run=_ensure_binning,
            requires=("hvg_ranking",),
            params=(
                Param(
                    name="n_bins",
                    default=BINNING_N_BINS,
                    label="Value bins",
                    unit="bins",
                    adjustable=False,
                    description=(
                        "Fixed by the checkpoint: the model was pretrained against "
                        "this many bins and reads a bin index, not a value."
                    ),
                ),
            ),
            outputs=("layers/" + BINNING_LAYER_KEY,),
        ),
        Stage(
            name="umap",
            version=UMAP_VERSION,
            label="Embedding",
            description=(
                "A 2-D map of the cells the run will train on, computed from the "
                "discretised matrix through 50 principal components. For the "
                "dataset card only, nothing trains on it."
            ),
            run=_ensure_umap_embedding,
            # quality_control as well as binning, because the embedding reads
            # the cell mask directly to leave out what the run will not see.
            requires=("quality_control", "binning"),
            outputs=("obsm/" + UMAP_COORDS_KEY,),
        ),
    ),
)

GENEFORMER_RECIPE_DEF = Recipe(
    model_family="geneformer",
    version=1,
    label="Geneformer",
    description=(
        "Normalise each cell's counts by each gene's median across Geneformer's "
        "reference corpus and store the resulting order of genes. Geneformer "
        "reads an order, not values, and its gene set is its own vocabulary, so "
        "there is no gene filter to adjust."
    ),
    stages=(
        Stage(
            name="rank_ordering",
            version=GENEFORMER_VERSION,
            label="Rank ordering",
            description=(
                "Per cell, the genes it expresses sorted by count divided by that "
                "gene's corpus median. Stored as column indices, so the trainer "
                "still maps through its own token dictionary."
            ),
            run=_ensure_geneformer_ranks,
            params=(
                Param(
                    name="geneformer_min_genes_per_cell",
                    default=0,
                    label="Minimum detected genes per cell",
                    unit="genes",
                    minimum=0,
                    maximum=100_000,
                    description=(
                        "A cell with fewer detected genes than this contributes "
                        "nothing. Geneformer's own tokenizer applies no cell "
                        "filter, so the default is off, and this exists for a "
                        "site that wants one."
                    ),
                ),
                Param(
                    name="geneformer_max_ranks",
                    default=GENEFORMER_MAX_RANKS,
                    label="Ranks stored per cell",
                    unit="genes",
                    adjustable=False,
                    description=(
                        "Fixed at the widest input any Geneformer checkpoint "
                        "accepts, so the stored order serves both generations and "
                        "the trainer's own truncation stays the only one that "
                        "decides a sequence's length."
                    ),
                ),
            ),
            outputs=(
                f"uns/{GENEFORMER_GROUP}/{GENEFORMER_INDPTR_KEY}",
                f"uns/{GENEFORMER_GROUP}/{GENEFORMER_INDICES_KEY}",
            ),
        ),
    ),
)

RECIPES: Dict[str, Recipe] = {
    TABULA_RECIPE.model_family: TABULA_RECIPE,
    GENEFORMER_RECIPE_DEF.model_family: GENEFORMER_RECIPE_DEF,
}

# At import, not at first use. A malformed recipe stops the data server at
# startup with a message naming the problem, rather than on whichever store
# happens to be scanned first, two minutes later, in a log nobody is reading.
for _recipe in RECIPES.values():
    check_recipe(_recipe)


def _read_prep_state(root, model_family: str) -> Dict[str, Any]:
    """This store's recorded state for one model's recipe, or an empty dict."""
    value = _read_attr(root, f"{PREP_ATTR_PREFIX}{model_family}")
    return value if isinstance(value, dict) else {}


def apply_recipe(
    zarr_path: Path,
    recipe: Recipe,
    requested: Optional[Mapping[str, Any]] = None,
    logger=None,
) -> Dict[str, Any]:
    """Bring one store up to date for one model, and record what happened.

    The executor half of the chain rule. :func:`recipes.plan` decides what
    *should* run from what the store records; this runs it and re-decides as it
    goes, because a stage can refuse at run time and a refusal has to block
    everything downstream exactly as a missing prerequisite does.

    Every outcome is written back under one root attribute per model family, so
    two models' states sit side by side and neither can overwrite the other.

    Args:
        zarr_path: the store.
        recipe: which model's preparation to apply.
        requested: parameter overrides. Validated against the recipe, and a
            bad one raises rather than falling back to a default.
        logger: the caller's logger.

    Returns:
        The state block as recorded, with a ``changed`` flag saying whether
        anything was written.

    Raises:
        ValueError: the requested parameters are not valid for this recipe.
    """
    resolved = resolve_params(recipe, requested)
    previous = _read_prep_state(
        zarr.open_group(str(zarr_path), mode="r"), recipe.model_family
    )
    recorded = previous.get("stages") or {}

    actions = plan(recipe, resolved, recorded)
    satisfied = {a.stage.name for a in actions if a.action == "skip"}
    stages: Dict[str, Any] = {}
    changed = False

    for action in actions:
        stage = action.stage
        stage_params = {p.name: resolved[p.name] for p in stage.params}

        if action.action == "skip":
            stages[stage.name] = dict(recorded.get(stage.name) or {})
            stages[stage.name]["fingerprint"] = action.fingerprint
            stages[stage.name]["satisfied"] = True
            continue

        # Re-check here rather than trusting the plan. A stage the plan meant
        # to run may have had a prerequisite refuse in this very pass, which
        # the plan could not have known.
        missing = [r for r in stage.requires if r not in satisfied]
        if missing or action.action == "blocked":
            reason = action.reason if action.action == "blocked" else (
                f"{', '.join(missing)} did not complete, and {stage.name} is "
                f"computed from it"
            )
            stages[stage.name] = {
                "satisfied": False,
                "fingerprint": action.fingerprint,
                "params": stage_params,
                "blocked": True,
                "reason": reason,
            }
            if logger:
                logger.info(f"{zarr_path.name}: {stage.name} blocked, {reason}")
            continue

        try:
            result = stage.run(zarr_path, stage_params, logger)
        except Exception as e:
            if logger:
                logger.warning(
                    f"{zarr_path.name}: {stage.name} failed: "
                    f"{type(e).__name__}: {e}"
                )
            stages[stage.name] = {
                "satisfied": False,
                "fingerprint": action.fingerprint,
                "params": stage_params,
                "failed": True,
                "reason": f"{type(e).__name__}: {e}",
            }
            continue

        entry: Dict[str, Any] = {
            "satisfied": bool(result.satisfied),
            "fingerprint": action.fingerprint,
            "params": stage_params,
            "stats": result.stats,
        }
        if result.refused:
            entry["refused"] = True
            entry["reason"] = result.refused
        stages[stage.name] = entry
        if result.wrote:
            changed = True
        if result.satisfied:
            satisfied.add(stage.name)

    state = {
        "recipe_version": recipe.version,
        "fingerprint": recipe.fingerprint(resolved),
        "params": dict(resolved),
        "stages": stages,
        "complete": all(s.get("satisfied") for s in stages.values()),
    }
    # Only stamp a time when something actually happened. A pass that wrote
    # nothing must leave the store byte-identical, or "did this change" can
    # never be answered by comparing two snapshots.
    if changed or state != {k: previous.get(k) for k in state}:
        state["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        # Re-opened here, deliberately, and not reused from above. A zarr group
        # caches the attributes it was opened with, and every stage has just
        # written its own through a group of its own. Writing this block
        # through a handle opened before they ran, and then rebuilding the
        # consolidated index from it, publishes a snapshot that predates all of
        # them: the stage attributes are on disk and the index says they do not
        # exist, so every reader sees a store that was never preprocessed.
        root = zarr.open_group(str(zarr_path), mode="r+")
        root.attrs[f"{PREP_ATTR_PREFIX}{recipe.model_family}"] = state
        _consolidate(root, zarr_path, f"{recipe.model_family} preprocessing", logger)
    else:
        state["updated"] = previous.get("updated")

    state["changed"] = changed
    return state


# ---------------------------------------------------------------------------
# Requests from the manager
# ---------------------------------------------------------------------------
#
# An organiser sets the preprocessing parameters once in the Chiron UI and
# applies them to every site in the federation. Each site's manager turns that
# into a file here.
#
# The route is deliberately indirect. The HTTP layer in front of this data
# directory is bioengine's, and bioengine is read only from this repository, so
# there is no endpoint to add. What bioengine already offers is an
# authenticated write: `bioengine.datasets.save_file` POSTs to /save and the
# bytes land in `<data_dir>/saved/<user>/`. The manager writes a request there
# and this loop picks it up, which needs no change on either side of a
# boundary we do not own.
#
# Requests are not deleted after handling. The manager owns those files, the
# status it reads back has to stay readable, and a handled request is
# recognised by id, so re-reading one costs a comparison. Deleting would also
# make "did my request arrive" unanswerable the moment it succeeded.
PREP_REQUEST_PREFIX = "chiron-prep-request-"
PREP_STATUS_PREFIX = "chiron-prep-status-"

# Where this server publishes what it can be asked to do. The manager reads it
# and the frontend renders the parameter form from it, rather than either of
# them holding its own copy of the recipes.
#
# That is not just convenience. The manager and the data server are versioned
# and deployed separately, so a copy in the manager would eventually describe a
# different pipeline from the one that runs. Publishing from the server that
# executes it means the form can only ever offer fields this server accepts: an
# older server shows an older form instead of offering a parameter it will
# reject at apply time, which is the one moment an operator cannot recover
# from, because by then they have already told every site to use it.
PREP_SCHEMA_FILE = "chiron-preprocessing-schema.json"


def _publish_prep_schema(data_dir: Path, logger) -> None:
    """Write the recipe schema into the public saved directory.

    Written straight to disk rather than through bioengine's /save endpoint,
    because that endpoint refuses to overwrite a public file and this one has
    to track the code. Rewritten only when it differs, so a store that is
    already current stays untouched by every poll.
    """
    public = data_dir / "saved" / "public"
    target = public / PREP_SCHEMA_FILE
    payload = json.dumps(
        {
            "version": 1,
            "recipes": {f: r.describe() for f, r in sorted(RECIPES.items())},
        },
        indent=2,
        sort_keys=True,
    )
    try:
        if target.exists() and target.read_text() == payload:
            return
        public.mkdir(parents=True, exist_ok=True)
        target.write_text(payload)
        logger.info(
            f"Published the preprocessing schema for "
            f"{', '.join(sorted(RECIPES))} to saved/public/{PREP_SCHEMA_FILE}"
        )
    except Exception as e:
        logger.warning(
            f"Could not publish the preprocessing schema, so the Chiron UI will "
            f"have no parameter form to render: {type(e).__name__}: {e}"
        )


def _dataset_dirs(data_dir: Path) -> Dict[str, Path]:
    """Dataset id to directory, matching how bioengine's catalogue keys them.

    The id comes from the manifest and falls back to the directory name, which
    is what `load_datasets` in bioengine's proxy server does. Resolving it the
    same way here is what makes a request addressed to a dataset id land on the
    right directory, rather than on one whose folder happens to share the name.
    """
    out: Dict[str, Path] = {}
    for subdir in sorted(data_dir.iterdir()):
        manifest = subdir / "manifest.yaml"
        if not subdir.is_dir() or not manifest.exists():
            continue
        dataset_id = subdir.name
        try:
            import yaml

            loaded = yaml.safe_load(manifest.read_text()) or {}
            dataset_id = loaded.get("id") or subdir.name
        except Exception:
            pass
        out[str(dataset_id)] = subdir
    return out


def _prepare_store(
    zarr_path: Path,
    model_family: str,
    params: Optional[Mapping[str, Any]],
    logger,
) -> Dict[str, Any]:
    """Apply one model's recipe to one store, never raising.

    A store that cannot be prepared must not stop the ones after it. A site
    with twenty zarrs and one corrupt file should end up with nineteen prepared
    datasets and one recorded error, not an empty directory.
    """
    recipe = RECIPES.get(model_family)
    if recipe is None:
        return {"error": f"no preprocessing recipe for model family {model_family!r}"}
    try:
        return apply_recipe(zarr_path, recipe, params, logger)
    except ValueError as e:
        # Bad parameters. The operator's problem, and the message names which.
        logger.warning(f"{zarr_path.name}: {model_family} preprocessing refused: {e}")
        return {"error": str(e)}
    except Exception as e:
        logger.warning(
            f"{zarr_path.name}: {model_family} preprocessing failed: "
            f"{type(e).__name__}: {e}"
        )
        return {"error": f"{type(e).__name__}: {e}"}


def _recipes_to_refresh(zarr_path: Path, logger) -> List[tuple]:
    """``(model_family, params)`` pairs this store should be kept current for.

    Three sources, and the order is the point.

    Anything the store already records state for, **with the parameters it
    records**, because a prepared store that silently stops being updated after
    a version bump is worse than one that was never prepared: it looks ready
    and is not. Carrying the recorded parameters forward is not a detail. The
    scan runs every thirty seconds, so re-applying defaults here would quietly
    undo an organiser's threshold within half a minute of them setting it, and
    the store would look correct the whole time.

    Tabula with defaults on a store that records nothing, which is what this
    server did before recipes existed and what every site's prepared data
    already expects.

    Geneformer as well when the operator has switched it on, for a site that
    wants it without going through the UI.
    """
    found: List[tuple] = []
    try:
        root = zarr.open_group(str(zarr_path), mode="r")
        for family in RECIPES:
            state = _read_prep_state(root, family)
            if state:
                found.append((family, state.get("params") or None))
    except Exception as e:
        logger.warning(f"{zarr_path.name}: cannot read recorded preprocessing: {e}")

    if not found:
        found.append((TABULA_RECIPE.model_family, None))
    if _geneformer_prep_enabled() and not any(f == "geneformer" for f, _ in found):
        found.append(("geneformer", None))
    return found


def _handle_prep_requests(data_dir: Path, logger) -> None:
    """Apply any pending preprocessing requests and write their status back.

    Scans `<data_dir>/saved/*/` rather than the dataset directories, because
    that is where bioengine's /save endpoint puts what the manager writes, and
    the main scan skips it: `saved/` carries no manifest.yaml at its own level,
    so it is not a dataset.
    """
    saved = data_dir / "saved"
    if not saved.is_dir():
        return

    datasets = _dataset_dirs(data_dir)

    for user_dir in sorted(p for p in saved.iterdir() if p.is_dir()):
        for request_file in sorted(user_dir.glob(f"{PREP_REQUEST_PREFIX}*.json")):
            try:
                request = json.loads(request_file.read_text())
            except Exception as e:
                logger.warning(f"Cannot read {request_file.name}: {e}")
                continue

            request_id = str(request.get("request_id") or "")
            if not request_id:
                # Without an id there is no way to tell a re-read from a new
                # request, so this would be re-applied on every poll forever.
                logger.warning(
                    f"Ignoring {request_file.name}: a preprocessing request "
                    "needs a request_id, and this one has none"
                )
                continue
            dataset_id = str(request.get("dataset_id") or "")
            family = str(request.get("model_family") or "")
            params = request.get("params") or {}

            status_file = user_dir / (
                PREP_STATUS_PREFIX + request_file.name[len(PREP_REQUEST_PREFIX):]
            )
            if status_file.exists():
                try:
                    previous = json.loads(status_file.read_text())
                except Exception:
                    previous = {}
                # Already handled, and handled SUCCESSFULLY, under this id.
                #
                # The success half matters. The request id is a digest of what
                # was asked for, so re-sending an identical request is the same
                # request. But a request that errored because the dataset had
                # not been staged yet, or because the store was mid-write, is
                # exactly the one an operator will press again once they have
                # fixed it, and treating that as "already handled" would make
                # it unfixable without changing a parameter they do not want to
                # change. A retry of a successful request is free, because the
                # recipe planner finds nothing to do.
                if (
                    request_id
                    and previous.get("request_id") == request_id
                    and previous.get("state") == "done"
                ):
                    continue
                if request_id and previous.get("request_id") == request_id:
                    logger.info(
                        f"Retrying preprocessing request {request_id}, which "
                        f"last ended in {previous.get('state', 'an unknown state')}"
                    )

            started = datetime.now(timezone.utc).isoformat(timespec="seconds")
            status: Dict[str, Any] = {
                "request_id": request_id,
                "dataset_id": dataset_id,
                "model_family": family,
                "params": params,
                "started_at": started,
            }

            dataset_dir = datasets.get(dataset_id)
            if dataset_dir is None:
                status["state"] = "error"
                status["error"] = (
                    f"no dataset {dataset_id!r} on this site. It holds: "
                    + (", ".join(sorted(datasets)) or "nothing")
                )
            elif family not in RECIPES:
                status["state"] = "error"
                status["error"] = (
                    f"no preprocessing recipe for {family!r}. This server has: "
                    + ", ".join(sorted(RECIPES))
                )
            else:
                logger.info(
                    f"Preprocessing request {request_id or '(no id)'}: "
                    f"{family} on dataset {dataset_id} with {params or 'defaults'}"
                )
                stores: Dict[str, Any] = {}
                for zarr_path in sorted(dataset_dir.glob("*.zarr")):
                    stores[zarr_path.name] = _prepare_store(
                        zarr_path, family, params, logger
                    )
                status["stores"] = stores
                errors = [s["error"] for s in stores.values() if s.get("error")]
                if not stores:
                    status["state"] = "error"
                    status["error"] = (
                        f"dataset {dataset_id!r} holds no zarr store to prepare"
                    )
                elif len(errors) == len(stores):
                    status["state"] = "error"
                    status["error"] = errors[0]
                else:
                    status["state"] = "done"
                    # One fingerprint per dataset, taken from the stores that
                    # succeeded. Two sites comparing preprocessing compare this.
                    prints = {
                        s.get("fingerprint") for s in stores.values()
                        if s.get("fingerprint")
                    }
                    status["fingerprint"] = prints.pop() if len(prints) == 1 else None
                    if errors:
                        status["partial_errors"] = errors

            status["finished_at"] = datetime.now(timezone.utc).isoformat(
                timespec="seconds"
            )
            try:
                status_file.write_text(json.dumps(status, indent=2))
            except Exception as e:
                logger.warning(f"Cannot write {status_file.name}: {e}")


def convert_anndata_to_zarr(data_dir: str, log_file: str = None):
    """Convert new AnnData files to zarr, then keep every store's preprocessing
    current and apply anything the manager has asked for.

    For each .h5ad inside a dataset folder (identified by a manifest.yaml), a
    .zarr with the same stem is written alongside it. The original manifest and
    X matrix are never modified.

    Preprocessing then runs per model family, through the declared recipes. A
    store is kept current for whatever it already records, so a version bump
    reaches prepared data without an operator having to ask, and nothing starts
    work on a model nobody at this site is training.

    Args:
        data_dir (str): Path to the root data directory to scan.
        log_file (str): Optional path to a log file.
    """
    logger = create_logger("AnnDataToZarrConverter", log_file=log_file)
    _data_dir = Path(data_dir)

    # First, so that a UI opened against a freshly started server has a form to
    # render before any dataset has finished preparing.
    _publish_prep_schema(_data_dir, logger)

    for dataset_dir in sorted(_data_dir.iterdir()):
        if not (dataset_dir / "manifest.yaml").exists():
            continue

        # 1) Convert any new .h5ad files.
        for anndata_file in sorted(dataset_dir.glob("*.h5ad")):
            zarr_file = dataset_dir / (anndata_file.stem + ".zarr")
            if not zarr_file.exists():
                logger.info(
                    f"Dataset {dataset_dir.name} - Converting "
                    f"{anndata_file.name} to {zarr_file.name}..."
                )
                adata = ad.read_h5ad(anndata_file)
                adata.write_zarr(zarr_file)

        # 2) Keep each store current for whichever models it is prepared for,
        #    at the parameters it was prepared with.
        for zarr_path in sorted(dataset_dir.glob("*.zarr")):
            for family, params in _recipes_to_refresh(zarr_path, logger):
                _prepare_store(zarr_path, family, params, logger)

    # 3) Anything the manager has asked for since the last pass.
    try:
        _handle_prep_requests(_data_dir, logger)
    except Exception as e:
        logger.warning(
            f"Preprocessing requests could not be read: {type(e).__name__}: {e}"
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
