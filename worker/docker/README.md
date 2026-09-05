# Chiron worker images

One image per model. A worker trains one model at a time and carries only that
model's dependencies. To train a different model you stop the worker and restart
it on a different image.

The models do not depend on each other, so a per-model split is the easiest
layout to extend when a fifth model arrives. Only the container changes: the
trainer apps and the `chiron_trainer_base` scaffold are the same everywhere, so
an image can be swapped later without touching app code.

## Which repository builds what

| Image | Built from | Why |
|---|---|---|
| `chiron-base` | this repo | No model code at all. It is the platform's runtime contract. |
| `chiron-scgpt` | this repo | scGPT is public and installs from its own upstream. |
| `chiron-geneformer` | this repo | Only `transformers` and `datasets`, both public. |
| `chiron-scfoundation` | this repo | Only `einops` and `local-attention`, both public. |
| `chiron-tabula` | `aicell-lab/tabula` | Tabula is unpublished, so its source cannot be built in a public repo yet. |

All five push to `ghcr.io/aicell-lab/chiron-*`. GHCR authorises a push against
the organisation, not against the repository the build ran in, so a package can
be published from either repo and stay linked to `aicell-lab/chiron-platform`.

`chiron-tabula` moves here too once Tabula ships as a pip package, at which point
the tabula repository stops building images entirely.

## Layering

```
chiron-base:<v>                 python 3.11, curl, tzdata, minio + mc,
                                torch 2.6.0, anndata[lazy], requirements.txt,
                                chiron.datasets, staged patch script
                                (no bioengine, no model code)
  |
  +-- chiron-tabula:<v>         flash-attn 2.7.4.post1 -> tabula -> bioengine
  +-- chiron-scgpt:<v>          flash-attn 2.7.4.post1 -> scanpy stack ->
  |                             scGPT (git, --no-deps) -> bioengine
  +-- chiron-geneformer:<v>     transformers 4.46 + datasets -> bioengine
  +-- chiron-scfoundation:<v>   einops + local-attention -> bioengine
```

`chiron-tabula` is also tagged `ghcr.io/aicell-lab/tabula` so existing sites and
older compose files keep resolving through the transition.

### One version across two repositories

`chiron-tabula` is `FROM chiron-base:<v>`, so the two repositories share a
version number and bump it together. A release is:

1. Bump `version` in `worker/pyproject.toml` here.
2. `scripts/publish_docker_image.sh --all` here, which publishes the base and
   the three model images.
3. Bump `version` in `pyproject.toml` and `CHIRON_BASE_VERSION` in
   `docker/versions.env` in the tabula repo to the same number.
4. `scripts/publish_docker_image.sh --all` there, which pulls the published base
   and builds `chiron-tabula` on it.

The base has to be published before step 4 can run. That ordering is build-time
only and does not constrain how the two pull requests are merged.

## The data server lives in the base

`python -m chiron.datasets` is a Chiron platform component, not a model
component: it converts AnnData to zarr and precomputes an HVG ranking, a binned
expression layer and a UMAP embedding that any of the models can train on. The
compose file the setup wizard generates runs it as its own service off the same
image as the worker, so every model image needs it.

It is installed into `chiron-base` from `worker/`, which is why the three model
images here carry no other model's code. Before the split they each installed
the whole tabula package for this one module.

The base can install it but cannot run it: `chiron.datasets` imports
`bioengine.datasets.proxy_server` at module scope, and the base deliberately
has no bioengine.

### The model's input width

The data server cuts its binned layer and HVG selection mask to
`CHIRON_HVG_IN_FEATURE`, set in each model image's identity block and defaulting
to 1200. The image that ships a model owns that value and is responsible for
keeping it equal to what the model declares. `chiron-tabula` asserts it against
`tabula/framework.yaml` at build time, so the two cannot drift apart silently.

Changing it means editing the model image, rebuilding, and bumping `HVG_VERSION`
and `BINNING_VERSION` in `worker/chiron/datasets/__main__.py` so datasets already
on disk are re-cut rather than skipped by the version idempotence check.

## The runtime patch layer

`patches/apply_runtime_patches.py` rewrites files inside the installed
`hypha_rpc` and `bioengine` packages. Every patch carries its own `reason` and
`remove_when`, with the write-up in [patches/README.md](patches/README.md), so
they can be reviewed and dropped one at a time.

There is exactly one copy of the script, here, and `chiron-base` stages it at
`/opt/chiron/patches/` without running it. Every model image, in either
repository, runs that staged copy after its own bioengine install. A second copy
in the tabula repo would be 480 lines of guaranteed drift, and the script has no
coupling to either repository: it only ever touches site-packages.

Two rules:

- The `RUN python /opt/chiron/patches/apply_runtime_patches.py` must stay
  **below** the bioengine install. A `BIOENGINE_REF` bump reinstalls the package
  and the patches have to re-run against the fresh source.
- The base must **not** run the script. It has neither package installed.

The script fails the build when an anchor no longer matches, so a version bump
cannot silently drop a patch and resurrect the original symptom.

## Two layer-cache properties, and how to break them

**1. BioEngine is the last layer of every model image.** It is the fastest-moving
pin in the stack, so a bump has to be cheap. Because nothing installs below it,
changing `BIOENGINE_REF` and rebuilding reuses every cached layer above (torch,
flash-attn, the model stack) and reinstalls only bioengine itself.

*Breaks if* anything is appended below the bioengine `RUN`, or if the protobuf
and googleapis-common-protos re-pins are split into their own `RUN`. Those must
stay welded to the install they correct, see [Protobuf](#protobuf) below.

**2. flash-attn is built once and shared by chiron-tabula and chiron-scgpt.** A
`RUN`'s cache key is the parent layer digest plus the command string, so a
byte-identical `RUN` first-after-`FROM` in both files means a machine building
both images builds that ~2 GB step once and both images point at the same layer.

The two files now live in different repositories, which makes this easier to
break and impossible to catch by reading one file. Keep the `RUN` byte-identical
in both. Comments are stripped from the cache key, so those may differ freely,
and they do.

Verify with:

```bash
docker history --no-trunc ghcr.io/aicell-lab/chiron-tabula:<v> | grep flash_attn
docker history --no-trunc ghcr.io/aicell-lab/chiron-scgpt:<v>  | grep flash_attn
```

### flash-attn wheel selection

The wheel must match the interpreter (cp311), the torch minor (2.6) and torch's
C++ ABI. PyPI torch 2.6.0 is built with the OLD ABI
(`torch._C._GLIBCXX_USE_CXX11_ABI` is False, and `libc10.so` exports no `__cxx11`
symbols), so the `cxx11abiFALSE` wheel is correct.

2.7.4.post1 is deliberately not the newest release. From 2.8.0.post2 onward the
published `cxx11abiFALSE` wheels for torch2.6 are in fact built against a
NEW-ABI torch. `nm -D --undefined-only` finds 28 undefined
`std::__cxx11::basic_string` symbols in both the abiFALSE and abiTRUE variants of
2.8.0.post2 and 2.8.3, and zero in 2.7.3 and 2.7.4.post1. Installing 2.8.x fails
at import with `undefined symbol: _ZN3c105ErrorC2ENS_14SourceLocationENSt7__cxx1112basic_string...`.

Do not bump the wheel without re-running that symbol check against the target
torch. Both Dockerfiles assert the ABI at build time, which is what caught the
2.8.3 mismatch.

### Protobuf

bioengine pulls the protobuf 7 chain in through `google-api-core` and
`opentelemetry-proto`, and Ray Serve 2.55 trips on protobuf 7's removed
`FieldDescriptor.label` when building deployments. `flwr` 1.22.0 also caps
protobuf strictly below 5.0, so 4.25.x is the only mutually compatible band.
`opentelemetry-proto` 1.43 complains but only at telemetry-emit time, where it
degrades to a no-op.

`googleapis-common-protos` is capped for the same reason. bioengine 0.16.1 pulls
ray 2.58 and `google-api-core` 2.34, which drag in
`googleapis-common-protos` 1.75.2, whose `google/rpc/code_pb2.py` was regenerated
against protobuf 5 and imports `google.protobuf.runtime_version`, a module that
does not exist below protobuf 5.27. Under the 4.25.x pin that import raises,
opencensus fails to load, and `ray start` exits 1 before the worker ever
registers. 1.75.0 is the last release whose generated code predates
`runtime_version` and whose own metadata still declares `protobuf>=4.25.8`, so
the cap is `<1.75.1` rather than `<1.75.2`.

Remove both pins once flwr accepts protobuf 5 or later.

## The image identity contract

Every model image ends with a block of environment variables. They are the whole
mechanism by which the Chiron platform knows what a worker can train:

| Variable | Example | Meaning |
|----------|---------|---------|
| `CHIRON_MODEL_FAMILY` | `scgpt` | Slug matching the adapter's `model_family` and the trainer manifest's `model_family` |
| `CHIRON_MODEL_NAME` | `scGPT` | Display name, shown as the worker's model badge |
| `CHIRON_TRAINER_ARTIFACT` | `chiron-platform/scgpt-trainer` | The only trainer this image can host |
| `CHIRON_HVG_IN_FEATURE` | `1200` | Input width the data server cuts its binned layer and HVG mask to |
| `CHIRON_IMAGE_REF` | `ghcr.io/aicell-lab/chiron-scgpt:0.7.8` | Passed in as a build arg by the publish script |

`chiron-manager` reads them at startup and reports them through
`get_worker_info()`. The Chiron UI uses `CHIRON_TRAINER_ARTIFACT` as the trainer
to deploy and refuses to deploy anything else, and the manager independently
rejects a trainer artifact whose manifest declares a different `model_family`. A
container where `CHIRON_MODEL_FAMILY` is unset is treated as an image that
predates per-model support: it gets no badge and cannot deploy a trainer at all.

`chiron-base` deliberately sets none of them, so a worker started on the base
image by mistake is correctly seen as unmarked rather than as some model.

Adding a fifth model means a fifth image with its own values, a trainer artifact
whose manifest declares the same family, and an entry in the platform's
`src/config/chironModels.ts`. Nothing else in the images changes.

The block sits **below** the bioengine layer. `CHIRON_IMAGE_REF` changes on
every release, and above the bioengine `RUN` that would invalidate the install
each time. `ENV` is metadata only, so nothing expensive is rebuilt by keeping it
last, and bioengine remains the last thing actually installed.

## Per-model dependency notes

The reasoning behind each choice is in the Dockerfile comments. In short:

- **tabula** (tabula repo) — flash-attn 2.7.4.post1, not newer, for the ABI
  reason above.
- **scgpt** — installed from a pinned git commit with `--no-deps`. Its declared
  core dependency `scvi-tools` would drag Lightning back to 1.9, and its
  declared list pulls in the archived `torchtext`. Nothing under `scgpt/`
  imports either. The build asserts both stayed out and that numpy and Lightning
  did not move. `--no-deps` does mean the genuinely-needed ones are listed by
  hand: `ipython` (imported at the top of `scgpt/utils/util.py`, so `import
  scgpt` fails without it) and `datasets<3`.
- **geneformer** — the `geneformer` package is deliberately **not** installed.
  Everything awkward about its packaging lives in the tokenization path, which
  runs at data-prep time, not on a training worker. Training needs torch,
  `transformers` and a small collator. The build asserts the package did not
  leak in.
- **scfoundation** — `einops` and `local-attention` only. The model source is
  vendored into the trainer app artifact (upstream has no packaging at all and
  mixes absolute with relative imports, so the directory has to sit on
  `sys.path`, which the replica bootstrap already arranges). The checkpoint is
  fetched at runtime: its licence is non-commercial and non-sublicensable, so
  each site downloads under its own grant.

## The click constraint (scgpt and geneformer)

`huggingface-hub` 1.x requires `click>=8.4.2`. `flwr` 1.22.0, which every
federated client runs on, requires `click<8.2.0`. Those are mutually exclusive,
so both images that pull in `datasets` hold `huggingface-hub<1.0`, where
`datasets` 2.x is happy and `click` stays at the 8.1.8 the base ships.

Both Dockerfiles assert the resulting click version at build time. If that
assertion fires after a dependency bump, the fix is the hf-hub pin, not the
assertion.

## Measured sizes

At 0.7.0, before the split, from `docker system df -v`:

| Image | Total | Shared | Unique |
|---|---|---|---|
| chiron-base | 7.09 GB | | |
| chiron-tabula | 8.22 GB | 7.698 GB | 518 MB |
| chiron-scgpt | 8.62 GB | 7.698 GB | 921 MB |
| chiron-geneformer | 7.91 GB | 7.092 GB | 815 MB |
| chiron-scfoundation | 7.61 GB | 7.092 GB | 519 MB |

All four share the 7.09 GB base. tabula and scgpt share a further 606 MB, which
is the flash-attn layer. Four independent images would occupy 32.36 GB on disk,
these occupy 10.47 GB.

A site only ever pulls one of them, so what this really buys is pull time when
switching a worker between models, and rebuild time here.

## Building

```bash
scripts/publish_docker_image.sh --all --build-only        # base + three, push nothing
scripts/publish_docker_image.sh --model scgpt --build-only
scripts/publish_docker_image.sh --all --skip-latest       # push versioned tags only
```

Run from the repo root. The build context is the repo root for every image,
since the base needs `worker/`.

`--skip-latest` publishes only the versioned tags. Use it for any release not
yet validated on a live worker: an image tag of `latest` puts the image on every
site at its next container restart.

## Smoke testing

```bash
scripts/smoke_test_images.sh [version]     # defaults to worker/pyproject.toml
```

Checks all five images, `chiron-tabula` included, so run it after that one has
been built in the tabula repository as well. It asserts what each image must
contain, what it must NOT contain (the geneformer package, torchtext,
scvi-tools), that `chiron.datasets` imports in every model image, and that the
flash-attn layer is genuinely shared between `chiron-tabula` and `chiron-scgpt`.
It runs on GPU 2 by default, never device 0, which is a Pascal card that cannot
run FlashAttention.

## Routine bumps

**BioEngine.** Edit `BIOENGINE_REF` in `worker/docker/versions.env`, note what
the new commit contains in the comment above it, rebuild. Only the final layer of
each image is rebuilt. The pin has no default in any Dockerfile and the `RUN`
fails loudly if the build-arg is missing, so it can never be picked up silently
from a file that was left behind during a bump. Bump the matching value in the
tabula repo's `docker/versions.env` in the same release.

**torch.** Edit `worker/docker/base/Dockerfile`, then re-check the flash-attn
wheel against the new torch before touching anything else:

```bash
python -c "import torch; print(torch._C._GLIBCXX_USE_CXX11_ABI)"   # picks abiTRUE/abiFALSE
nm -D --undefined-only <path>/flash_attn_2_cuda*.so | grep -c __cxx11
```

The count must be 0 for an old-ABI torch. Then update the URL in **both**
`worker/docker/scgpt/Dockerfile` here and `docker/tabula/Dockerfile` in the
tabula repo, keeping the two `RUN`s byte-identical. Everything rebuilds from the
torch layer down, which is the expensive case and is expected.

**scGPT.** Edit `SCGPT_REF` in `worker/docker/versions.env`.

**Adding a model.** Add `worker/docker/<model>/Dockerfile` following the same
skeleton (`ARG CHIRON_BASE_IMAGE` / `FROM` / model layer / bioengine last /
patches / identity block) and add the name to `MODELS` in
`scripts/publish_docker_image.sh`.
