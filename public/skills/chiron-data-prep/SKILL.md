---
name: chiron-data-prep
description: Prepare single-cell data for Tabula federated training on a Chiron worker. Covers folder layout, manifest.yaml, and what the data-server handles for you (h5ad → zarr conversion, HVG gene ranking).
compatibility: Designed for Claude Code, Gemini CLI, or any agent that can read a URL and execute Python.
metadata:
  author: chiron-platform
  version: "1.0"
  pip: "scanpy>=1.10"
  server_handles:
    - h5ad → zarr conversion on first read + every 30 s rescan
    - HVG ranking (variance / mean over-dispersion) written into var/ so the trainer can pick the most informative genes when n_vars > in_feature
---

# Prepare single-cell data for Tabula federated training

This skill explains what a Chiron worker expects on disk and how to get an `.h5ad` file ready for training. You should read this once at the start of a session and then act.

## TL;DR for the agent

The user has either an `.h5ad` file, an already-converted `.zarr` directory, or a mix of both — possibly several. The Chiron worker mounts a host directory into its data-server container. Your job is to:

1. **Ask the user for the path to their worker's data directory.** Do not assume.
2. **Pick / confirm a `<dataset-slug>`** for each dataset (one folder per tissue / dataset; one or more `.h5ad` or `.zarr` per folder is fine).
3. **Place** the file(s) at `<their-DATA_DIR>/<dataset-slug>/`. `.h5ad` and `.zarr` both work — the data-server reads either and auto-converts `.h5ad` to `.zarr` on first scan if no matching `.zarr` exists.
4. **Write** `<their-DATA_DIR>/<dataset-slug>/manifest.yaml` describing the dataset.
5. **Optionally pre-filter genes** if you know the model's `in_feature` (default 1200) and the AnnData has dramatically more genes — the data-server will rank-select for you, but pre-filtering keeps the zarr small.

You **do not need to**:
- convert `.h5ad` → `.zarr` yourself (the data-server does it on first scan)
- run `scanpy.pp.highly_variable_genes` for the trainer (the data-server ranks all genes by variance/mean over-dispersion and writes `var/tabula_hvg_rank` so the trainer can pick top-K at training time)
- compute a UMAP / PCA for the dataset card (the data-server does that too — streaming IncrementalPCA + UMAP on a subsample if the dataset is large)
- modify the AnnData's `X`, `obs`, or `var` beyond what the user wants biologically

## Environment

```bash
pip install "scanpy>=1.10"
```

`scanpy` brings `anndata`, `numpy`, `pandas`, `scipy`. That's all you need on the user's side.

## What lives on disk

```
<DATA_DIR>/                 ← the path the worker mounts as /data
├── blood/                  ← one folder per dataset / tissue / cohort
│   ├── manifest.yaml       ← required
│   ├── healthy_donors.h5ad ← user-provided
│   └── disease_cohort.h5ad ← optional, multiple .h5ads in one folder are OK
├── liver/
│   ├── manifest.yaml
│   └── liver_atlas.h5ad
└── thymus/
    ├── manifest.yaml
    └── thymus_atlas.zarr/  ← already-converted zarr also works
```

A folder is "discovered" by the data-server only if it contains a `manifest.yaml`. The data-server runs `python -m tabula.datasets --data-dir /data` and rescans every 30 seconds.

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
name: Blood Perturb RNA       # human-readable name shown in Chiron UI
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

For each dataset folder:

1. **Converts `.h5ad` → `.zarr` v3** alongside the `.h5ad` if no matching `.zarr` exists. If the user already shipped a `.zarr`, the data-server uses it directly. The original `.h5ad` is untouched.
2. **Computes a per-gene over-dispersion score** (`var / mean`) and writes it into the zarr's `var/` group as:
   - `var/tabula_hvg_rank` — int32, rank 0 = most variable
   - `var/tabula_hvg_score` — float32, the raw score
   - `var/tabula_hvg_histogram_counts` — int32 of length 20, log-spaced histogram of the score (so the dataset card can render a sparkline without sending 30k floats)
   - group attrs: `tabula_hvg_method`, `tabula_hvg_version`, `tabula_hvg_histogram_edges_log10`
3. **Computes a 2D embedding** of the cells using streaming IncrementalPCA followed by UMAP on a subsample:
   - cells are read from zarr in chunked batches so memory stays bounded regardless of dataset size
   - IncrementalPCA reduces to 50 components on the streamed batches
   - if `n_cells > 50,000`, a random subsample of 50k cells is taken; otherwise all cells are used
   - UMAP runs on the (≤ 50k, 50) PCA matrix
   - the resulting 2D coordinates are written as `obsm/tabula_umap_coords` (float32) and `obsm/tabula_umap_indices` (int32, only present if subsampled). Group attrs: `tabula_umap_method`, `tabula_umap_version`, `tabula_umap_n_sampled`.

Each step is **independently idempotent** — the data-server checks the version attr for each artefact and skips it if up-to-date. If you ever change the AnnData's `X` after the fact, delete the corresponding `.zarr/` directory and the data-server will rebuild + recompute everything on its next scan.

## What the trainer does with the rank at training time

`tabula.training.data_loader.MultiClientDataset` opens each zarr and:

- If `n_vars ≤ in_feature` → keeps all genes, pads on the right with `padding_id`.
- If `n_vars > in_feature` and `var/tabula_hvg_rank` is present → keeps the `in_feature` genes with the lowest rank (= most variable).
- If `n_vars > in_feature` and the rank is missing (legacy zarrs written before data-server v0.4.0) → falls back to positional truncation and prints a warning telling the user to restart the data-server.

This means **you do not have to filter genes yourself for the trainer to work**. But pre-filtering still helps if:

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
name: Lung Atlas — Adult Healthy
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

- **Do not convert to zarr yourself if you only have an `.h5ad`.** The data-server is responsible for that and uses `anndata.settings.zarr_write_format = 3`. If the user already has a `.zarr`, that's fine — but only if it was written by AnnData with `write_format=3`. Older v2 zarrs won't read correctly through `HttpZarrStore`.
- **Do not normalize / log-transform `X` unless the user asks.** The Tabula pipeline expects raw counts in `X` (or pre-binned values in `layers/X_binned` when provided by an upstream pipeline). Normalizing in `X` destroys signal the HVG ranker uses.
- **Do not modify `var/tabula_hvg_*` or `obsm/tabula_umap_*`** if you find them — those are the data-server's columns. If you want to change them, delete the `.zarr/` and let the server rebuild.
- **Do not put the manifest one level too deep.** `manifest.yaml` lives **directly inside** the dataset folder, alongside the `.h5ad` / `.zarr` files. A `manifest.yaml` deeper than that is invisible to the scanner.

## When to ask the user

Stop and ask when:
- The `.h5ad` `X` looks already-normalized (negative values or non-integer means substantially > 1 with no `raw` slot). The Tabula trainer assumes raw-count-like inputs in `X`.
- The user has multiple `.h5ad` files that look like the same dataset split by batch. Decide together whether they want one folder with many files (data-server treats them as one dataset, concatenated) or one folder per file (different datasets, trainable independently).
- The `id` they want clashes with an existing dataset on the same worker. Ask before silently appending `_v2`.

That's the whole job. Be precise about paths, don't surprise the user with mutations to their data, and let the data-server handle the boring parts.
