# chiron-base, the runtime every Chiron worker shares, regardless of model.
#
# Holds the expensive, model-independent half of the stack: Python 3.11, torch,
# the scientific stack from worker/requirements.txt, the minio binaries the
# BioEngine worker needs, and the Chiron data server. It deliberately contains
# NO bioengine and NO model code.
#
# BioEngine is absent because it is the fastest-moving pin in the whole image
# and belongs in the LAST layer of each model image, so that bumping it rebuilds
# one cheap step instead of reinstalling torch. Model code is absent so this
# layer stays shared across every model image, including chiron-tabula, which is
# built from the tabula repository against the published base.
#
# Built by scripts/publish_docker_image.sh with the repo root as context.

FROM condaforge/miniforge3:25.9.1-0

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # Set SSL_CERT_FILE for hypha-rpc to work properly
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    # tzdata is installed by mamba into /opt/conda/share/zoneinfo; tell glibc where to find it
    # so that TZ=Europe/Berlin etc. resolves to a real zoneinfo file instead of a POSIX literal
    TZDIR=/opt/conda/share/zoneinfo \
    # umap-learn depends on Numba, which tries to cache its JIT-compiled functions
    # next to the source file. site-packages is read-only inside the image, so the
    # cache write fails with "no locator available for file ...". Redirect Numba's
    # cache to a writable tmpfs dir so the UMAP step in chiron.datasets can run.
    NUMBA_CACHE_DIR=/tmp/numba_cache

WORKDIR /app

# Install Python 3.11, curl and tzdata in the base environment.
#
# No CUDA toolkit here. It only ever existed to give flash-attn's source build an
# nvcc, and flash-attn now installs from a prebuilt wheel, so nothing in this
# image compiles CUDA code. The torch wheel bundles the CUDA *runtime* it needs
# (cudart, cuBLAS, cuDNN, NCCL, nvrtc, nvjitlink) as ordinary pip dependencies.
# The host only has to provide an NVIDIA driver >= 525 for CUDA 12.x.
RUN mamba install -n base -c conda-forge -y \
    python=3.11 \
    curl \
    tzdata \
    && mamba clean --all -f -y

# PyTorch 2.6.0 from plain PyPI — no extra index needed. The default PyPI wheel
# for this version *is* the CUDA 12.4 build: every bundled nvidia-*-cu12
# dependency pins 12.4.127. That is the cu12 ABI the flash-attn wheel in the
# tabula and scgpt images expects. A released version's dependency metadata never
# changes, so this stays deterministic across rebuilds without pinning
# download.pytorch.org.
RUN pip install torch==2.6.0

# Install minio and minio-client
RUN curl -Lo /bin/minio.20240716T234641Z https://dl.min.io/server/minio/release/linux-amd64/archive/minio.RELEASE.2024-07-16T23-46-41Z && \
    chmod +x /bin/minio.20240716T234641Z

RUN curl -Lo /bin/mc.20250408T153949Z https://dl.min.io/client/mc/release/linux-amd64/archive/mc.RELEASE.2025-04-08T15-39-49Z && \
    chmod +x /bin/mc.20250408T153949Z

ENV MINIO_EXECUTABLE_PATH=/bin

# Install anndata to support conversion of h5ad files into zarr format
RUN pip install anndata[lazy]==0.12.9

# Copy the requirements file
COPY worker/requirements.txt .

# Install the shared dependency set (flwr, lightning, numpy, zarr, umap-learn, ...)
RUN pip install -r requirements.txt

# The Chiron data server, `python -m chiron.datasets`. It lives in the base and
# not in each model image because it is model-agnostic: it prepares zarrs, an
# HVG ranking and a binned layer that any of the models can train on.
#
# Installed here but NOT runnable here. It imports bioengine at module scope,
# which this image deliberately does not carry, so it can only be started from a
# model image. Installing it in the base is still the right layer: it is the
# same code for every model, and the alternative is four copies that drift.
# Copied file by file rather than as `COPY worker/`, so that editing a
# Dockerfile under worker/docker/ does not invalidate this layer and force a
# rebuild of everything above it.
COPY worker/pyproject.toml worker/README.md /opt/chiron/worker/
COPY worker/chiron/ /opt/chiron/worker/chiron/
RUN pip install /opt/chiron/worker

# Stage the runtime patch layer without running it.
#
# The patches rewrite files inside the installed hypha_rpc and bioengine
# packages, neither of which exists here, so running the script now would be a
# no-op at best. Each model image runs THIS copy after its own bioengine
# install. One copy, in the repository that builds the base, so the two
# repositories cannot drift apart.
COPY worker/docker/patches/ /opt/chiron/patches/

CMD [ "/bin/bash" ]
