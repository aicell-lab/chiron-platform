# Chiron worker

Everything that runs on a BioEngine worker rather than in the browser: the
Chiron data server, and the Docker images the platform ships.

```
worker/
  chiron/datasets/    the data server, started as `python -m chiron.datasets`
  docker/             chiron-base and the model images built from this repo
  requirements.txt    the base image's Python dependencies
```

Nothing in `chiron/` may import a foundation model. This package is installed
into `chiron-base`, which every model image is built on, so a model import here
would put that model into every other model's image.

## The data server

Started next to a worker, given the site's data directory:

```bash
python -m chiron.datasets --data-dir /data
```

It scans for AnnData files, converts them to zarr, and precomputes the
artifacts the dataset card and the trainers read: a highly-variable-gene
ranking and selection mask, a per-cell binned expression layer cut to the
model's input width, and a 2-D UMAP embedding. Raw expression data never
leaves the machine. Only the derived summaries are served.

The setup wizard at `#/worker` generates the compose file that runs it, so
the command above rarely has to be typed by hand.

### Where the model's input width comes from

The binned layer and the HVG mask are cut to the model's input sequence
length, read once at startup from `CHIRON_HVG_IN_FEATURE` (default 1200).
Each model image sets it, and the image that ships a model is responsible for
keeping that value equal to what the model actually declares. `chiron-tabula`
asserts it against `tabula/framework.yaml` at build time so the two cannot
drift apart silently.

Changing the width means editing it in the model image, rebuilding, and
bumping `HVG_VERSION` and `BINNING_VERSION` in `chiron/datasets/__main__.py`
so datasets already on disk are re-cut rather than skipped by the version
idempotence check.

### Zarr key names

Artifacts are written under `chiron_*` keys. Datasets prepared before this
package moved out of the `tabula` package carry the same artifacts under
`tabula_*`, and every reader here and in the trainers accepts either, new
name first. No site has to re-prepare anything.

## Docker

See [docker/README.md](docker/README.md) for what is built here, what is built
in the `tabula` repository, and how a release is cut across the two.
