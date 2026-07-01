---
name: chiron-platform/data-prep
parent: chiron-platform
description: Prepare single-cell data for Tabula federated training on a Chiron worker. Covers folder layout, manifest.yaml, and what the data-server handles for you (h5ad → zarr conversion, value binning, HVG ranking, UMAP). Sub-skill of the chiron-platform skill.
compatibility: Designed for Claude Code, Gemini CLI, or any agent that can read a URL and execute Python.
metadata:
  author: chiron-platform
  version: "1.3"
  pip: "scanpy>=1.10"
  server_handles:
    - h5ad → zarr conversion on first read + every 30 s rescan
    - Per-dataset HVG ranking by over-dispersion (variance / mean) written into var/
    - Per-cell 50-bin quantile value binning written into layers/tabula_binned
    - 2D UMAP embedding for the dataset card
---

# Prepare single-cell data for Tabula federated training

This is a sub-skill of the [chiron-platform skill](../SKILL.md). It explains what a Chiron worker expects on disk and how to get an `.h5ad` file ready for training. Read this once at the start of a data-onboarding session and then act.

## TL;DR for the agent

The user has either an `.h5ad` file, an already-converted `.zarr` directory, or a mix of both — possibly several. The Chiron worker mounts a host directory into its data-server container. Your job is to:

1. **Ask the user for the path to their worker's data directory.** Do not assume.
2. **Pick / confirm a `<dataset-slug>`** for each dataset (one folder per tissue / dataset; one or more `.h5ad` or `.zarr` per folder is fine).
3. **Place** the file(s) at `<their-DATA_DIR>/<dataset-slug>/`. `.h5ad` and `.zarr` both work — the data-server reads either and auto-converts `.h5ad` to `.zarr` on first scan if no matching `.zarr` exists.
4. **Write** `<their-DATA_DIR>/<dataset-slug>/manifest.yaml` describing the dataset.
5. **Optionally pre-filter genes** if the AnnData has dramatically more genes than the trainer's input sequence length `in_feature` (fixed at 1200 in the trainer's framework.yaml). The data-server will rank-select for you at training time, but pre-filtering keeps the on-disk zarr small.

You **do not need to**:
- convert `.h5ad` → `.zarr` yourself (the data-server does it on first scan)
- quantile-bin the expression matrix (the data-server writes a per-cell 50-bin discretisation to `layers/tabula_binned`, which the trainer reads in preference to raw `X`)
- run `scanpy.pp.highly_variable_genes` for the trainer (the data-server ranks genes by per-dataset over-dispersion and writes `var/tabula_hvg_rank` so the trainer can pick the top 1,200 at training time)
- compute a UMAP / PCA for the dataset card (the data-server does that too with streaming IncrementalPCA + UMAP on a subsample if the dataset is large)
- modify the AnnData's `X`, `obs`, or `var` beyond what the user wants biologically

Cell- and gene-level quality control is the user's responsibility upstream. The data-server does **not** apply any QC filter; whatever cells and genes are in the user's `.h5ad` are what the trainer sees.

## Environment

```bash
pip install "scanpy>=1.10"
```

`scanpy` brings `anndata`, `numpy`, `pandas`, `scipy`. That's all you need on the user's side.

## What lives on disk

```
/path/to/data/
├── thymus/
│   ├── thymus_atlas.h5ad   ← .h5ad auto converts to .zarr
│   └── manifest.yaml       ← describes the thymus dataset
└── blood/
    ├── pbmc_10k.zarr/      ← already-converted zarr is fine too
    └── manifest.yaml       ← describes the blood dataset
```

A folder is "discovered" by the data-server only if it contains a `manifest.yaml`. The data-server runs `python -m tabula.datasets --data-dir /data` and rescans every 30 seconds.

## Which AnnData keys are read

The data-server and the trainer only look at a small, fixed set of keys inside each AnnData / zarr. **Make sure the user's count matrix lives in the right slot before handing off**, because anything in `raw.X`, `layers/counts`, or another layer is ignored.

| Slot | Role | Required? |
|------|------|-----------|
| `adata.X` | Raw integer count matrix, shape `(n_cells, n_vars)`. Source of every downstream artefact (HVG ranking, binning, UMAP). | **Yes** |
| `adata.var["gene_id"]` | int64 / int column read by the trainer as the gene-token ID. If absent, the trainer falls back to positional indices (0..n_vars-1), which works for a single-dataset run but breaks cross-dataset gene matching. | Strongly recommended |
| `adata.var_names` | Preserved by the zarr write and visible in the dataset card. Not used for training. | Optional |
| `adata.obs` | Preserved verbatim. | Optional |
| `adata.var` | Preserved verbatim. The data-server adds `var/tabula_hvg_rank`, `var/tabula_hvg_score`, `var/tabula_hvg_selected` next to whatever else is there. | Optional |
| `adata.layers["counts"]`, `adata.raw.X`, any other layer | **Ignored.** | n/a |

If counts live in `adata.raw.X` or a layer, move them into `X` before writing the `.h5ad`:

```python
import scanpy as sc

adata = sc.read_h5ad("~/raw_data/my_dataset.h5ad")
# Example: counts shipped in raw.X
if adata.raw is not None and adata.X.dtype.kind == "f" and adata.X.max() < 50:
    # Looks like the working X is already log/normalised — restore counts.
    adata = adata.raw.to_adata()
# Or, counts shipped in layers["counts"]
if "counts" in adata.layers:
    adata.X = adata.layers["counts"]
adata.write_h5ad("/shared/chiron-data/<slug>/my_dataset.h5ad")
```

After this step, `adata.X` should contain non-negative integer-valued counts (sparse or dense both work), and `adata.var["gene_id"]` should hold the gene IDs the federated network uses to align tokens across institutions.

## manifest.yaml schema

Minimum fields:

```yaml
id: blood_perturb     # unique snake_case identifier, must not clash with other datasets on this worker
authorized_users:             # list. "*" = public on this worker. Otherwise list specific Hypha user emails.
  - "*"
```

Recommended fields:

```yaml
id: blood_perturb
name: Blood-Perturb           # human-readable name shown in Chiron UI; Title-cased, hyphenate sub-descriptors (e.g. Blood-Perturb, Skin Aging - BLSA)
description: CRISPR perturbation screen of 19 transcription factors in human HSPCs with scRNA-seq during erythroid differentiation.
authorized_users:
  - "*"
tags:
  - perturbation
  - hematopoiesis
  - scRNA-seq
license: CC-BY-4.0            # SPDX identifier
source: https://doi.org/10.1126/science.ads7951
documentation: https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE274113
authors:
  - name: Jane Doe
    affiliation: Department of X, University Y
    github_user: jdoe
```

The dataset `id` is what trainers reference (e.g. when calling `create_trainer(datasets=["blood_perturb", ...])`). **Make it unique per worker** — two datasets with the same `id` will overwrite each other.

## What the data-server does on first read

For each dataset folder, the data-server runs these steps in order. Each step is independently idempotent (versioned via a root attr) so re-running only does the missing work.

1. **Converts `.h5ad` → `.zarr` v3** alongside the `.h5ad` if no matching `.zarr` exists. If the user already shipped a `.zarr`, the data-server uses it directly. The original `.h5ad` is untouched.
2. **Ranks genes by per-dataset over-dispersion** (`variance / mean`). Written into the zarr's `var/` group:
   - `var/tabula_hvg_rank` — int32, full length `n_vars`, rank 0 = most variable
   - `var/tabula_hvg_score` — float32, full length `n_vars`, the raw score
   - `var/tabula_hvg_selected` — bool, full length `n_vars`. True for the top `min(in_feature, n_vars)` genes by rank. Read by the trainer to map the pre-cut binned layer back to gene IDs.
   - root attrs: `tabula_hvg_method`, `tabula_hvg_version`, `tabula_hvg_in_feature` (the trainer's input sequence length, 1200), `tabula_hvg_n_selected`, `tabula_hvg_histogram_counts` (length-20 log-spaced histogram so the dataset card can render a sparkline without sending 30k floats), `tabula_hvg_histogram_edges_log10`
3. **Bins expression values per cell** into 50 equal-frequency quantile bins on the cells × selected-HVG submatrix. Zero values stay at bin 0, non-zero values are ranked per row and assigned bins 1..50. Written as a uint8 layer pre-cut to the trainer-ready shape:
   - `layers/tabula_binned` — uint8, shape `(n_cells, n_selected_genes)` where `n_selected_genes = min(in_feature, n_vars) = min(1200, n_vars)`. This is exactly what the model consumes, so the trainer streams a row at a time without further reshaping. Column `j` corresponds to the `j`-th `True` in `var/tabula_hvg_selected`.
   - root attrs: `tabula_binning_version`, `tabula_binning_n_bins`, `tabula_binning_n_cells`, `tabula_binning_n_genes`
4. **Computes a 2D UMAP embedding** of the binned matrix using streaming IncrementalPCA followed by UMAP on a subsample:
   - cells are read from `layers/tabula_binned` in chunked batches so memory stays bounded regardless of dataset size, and the embedding reflects exactly what the trainer sees (cells × top-1200 HVGs in 0..50 quantile bins)
   - IncrementalPCA reduces to 50 components on the streamed batches
   - if `n_cells > 50,000`, a random subsample of 50k binned rows is taken, otherwise all cells are used
   - UMAP runs on the (≤ 50k, 50) PCA matrix
   - 2D coordinates are written as `obsm/tabula_umap_coords` (float32) and `obsm/tabula_umap_indices` (int32, row indices into the binned matrix, only present if subsampled). Root attrs: `tabula_umap_method`, `tabula_umap_version`, `tabula_umap_n_sampled`.

If you ever change the AnnData's `X` after the fact, delete the corresponding `.zarr/` directory and the data-server will rebuild and recompute everything on its next scan.

## What the trainer does with these artefacts at training time

`tabula.training.data_loader.MultiClientDataset` classifies each zarr into one of two modes:

- **new** (`var/tabula_hvg_selected` present): the binned layer is already `(n_cells, n_selected_genes)`. The trainer reads `layers/tabula_binned[row, :]` directly and derives the per-column gene IDs as `var/gene_id[var/tabula_hvg_selected]`. No runtime HVG selection happens — the matrix is already trainer-ready.
- **legacy** (no HVG artefacts): every cell contributes; reads from `X` or `layers/X_binned`; if `n_vars > in_feature` and no rank is present, falls back to positional truncation and prints a warning telling the user to restart the data-server.

This means **you do not have to bin values or filter genes yourself for the trainer to work**. But pre-filtering genes still helps if:

- You want to keep the zarr on disk small.
- You have very strong biological priors about which genes to keep.
- You want to use the same `.h5ad` outside Chiron.

## A complete walk-through

The user typically has something like:

```
~/raw_data/my_dataset.h5ad  ← their starting point
/shared/chiron-data/        ← the directory mounted into the worker
```

Step 1: confirm shape and pick a slug.

```python
import scanpy as sc

adata = sc.read_h5ad("~/raw_data/my_dataset.h5ad")
print(adata)        # AnnData object with n_obs × n_vars = 52341 × 36601
                    # obs: 'cell_type', 'donor_id', 'batch', ...
                    # var: 'gene_symbol', ...
```

`tissue_slug = "lung_atlas_001"` (say).

Step 2: lay out the folder.

```bash
mkdir -p /shared/chiron-data/lung_atlas_001
cp ~/raw_data/my_dataset.h5ad /shared/chiron-data/lung_atlas_001/
```

Step 3: write `manifest.yaml`.

```yaml
# /shared/chiron-data/lung_atlas_001/manifest.yaml
id: lung_atlas_001
name: Lung Atlas - Adult Healthy
description: 52k single cells from 12 adult healthy donors, droplet-based scRNA-seq.
authorized_users:
  - "*"
tags:
  - lung
  - scRNA-seq
  - healthy
license: CC-BY-4.0
authors:
  - name: Jane Doe
    affiliation: Some Institute
```

Step 4 (optional but kind): if `n_vars` is huge and the user prefers a leaner zarr, pre-filter.

```python
# Only do this if the user explicitly asks for a leaner on-disk dataset.
# The trainer's HVG rank already picks the right genes at training time.
import scanpy as sc

adata = sc.read_h5ad("/shared/chiron-data/lung_atlas_001/my_dataset.h5ad")

# Pre-filter to a much smaller set of HVGs — this is biology, not training infra.
sc.pp.highly_variable_genes(adata, n_top_genes=2000, flavor="seurat_v3")
adata = adata[:, adata.var.highly_variable].copy()
adata.write_h5ad("/shared/chiron-data/lung_atlas_001/my_dataset.h5ad")
```

Step 5: tell the user it's done. The data-server will pick it up within 30 seconds; they can verify via `manager.get_datasets_info()` from the Chiron UI or the Python RPC client.

## Anti-patterns

- **Do not ship a `.zarr/` you need to preserve byte-for-byte.** The data-server opens every discovered `.zarr/` in read-write mode and writes HVG rank, the value-binned layer, and a UMAP embedding directly into it. Ship the `.h5ad` instead. The `.h5ad` is read once at conversion time and never written, and the sibling `.zarr/` the server materialises is the only file it ever mutates. If the user already has a `.zarr/` they consider canonical, keep an untouched copy of it elsewhere before pointing the worker at it.
- **Do not convert to zarr yourself if you only have an `.h5ad`.** The data-server is responsible for that and uses `anndata.settings.zarr_write_format = 3`. If the user already has a `.zarr`, that's fine — but only if it was written by AnnData with `write_format=3`. Older v2 zarrs won't read correctly through `HttpZarrStore`.
- **Do not normalize / log-transform `X` unless the user asks.** The Tabula pipeline expects raw counts in `X` (or pre-binned values in `layers/X_binned` when provided by an upstream pipeline). Normalizing in `X` destroys signal the HVG ranker uses.
- **Do not modify `var/tabula_hvg_*`, `layers/tabula_binned`, or `obsm/tabula_umap_*`** if you find them. Those are the data-server's columns. If you want to change them, delete the `.zarr/` and let the server rebuild.
- **Do not put the manifest one level too deep.** `manifest.yaml` lives **directly inside** the dataset folder, alongside the `.h5ad` / `.zarr` files. A `manifest.yaml` deeper than that is invisible to the scanner.

## When to ask the user

Stop and ask when:
- The `.h5ad` `X` looks already-normalized (negative values or non-integer means substantially > 1 with no `raw` slot). The Tabula trainer assumes raw-count-like inputs in `X`.
- The user has multiple `.h5ad` files that look like the same dataset split by batch. Decide together whether they want one folder with many files (data-server treats them as one dataset, concatenated) or one folder per file (different datasets, trainable independently).
- The `id` they want clashes with an existing dataset on the same worker. Ask before silently appending `_v2`.

That's the whole job. Be precise about paths, don't surprise the user with mutations to their data, and let the data-server handle the boring parts.
