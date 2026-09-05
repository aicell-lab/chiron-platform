# chiron-geneformer, the Chiron worker runtime for Geneformer.
#
# Layer order:
#   transformers stack  →  bioengine (LAST)
#
# No flash-attn: Geneformer does not use it. This image is correspondingly
# smaller than chiron-tabula and chiron-scgpt.
#
# The data server is not installed here. It comes from chiron-base, which every
# model image is built on, so this image carries no other model's code.
#
# Built by scripts/publish_docker_image.sh with the repo root as context.

ARG CHIRON_BASE_IMAGE
FROM ${CHIRON_BASE_IMAGE}

# The `geneformer` package is DELIBERATELY NOT INSTALLED. This is not an
# oversight, so please do not "fix" it.
#
# Everything awkward about Geneformer's packaging lives in its tokenization path,
# which runs once at data-prep time and never on a training worker:
#   - tdigest needs a C compiler and fails on modern toolchains without
#     CFLAGS="-std=c99", and it is imported at package import time
#     (geneformer/__init__.py -> emb_extractor.py), so it blocks `import
#     geneformer` outright.
#   - loompy transitively pins numpy<2, which would fight the rest of the stack.
#   - git-lfs is mandatory not only for weights but for the four .pkl gene
#     dictionaries. A GIT_LFS_SKIP_SMUDGE=1 clone silently installs ~130-byte
#     pointer files in their place.
#   - setup.py and requirements.txt disagree, and the documented install path
#     (`pip install .`) reads the unpinned one.
#
# Training a Geneformer model needs torch (in the base), transformers, datasets
# and a small collator. That is all this layer provides.
#
# transformers is pinned to 4.46 because that is what Geneformer's own
# requirements.txt pins, and the modelling code tracks that API. No other Chiron
# model imports transformers, so the pin conflicts with nothing.
#
# huggingface-hub is held on the 0.x line for the same reason as in
# worker/docker/scgpt/Dockerfile: hf-hub 1.x requires click>=8.4.2 while flwr 1.22.0
# requires click<8.2.0, and flwr is what the federated client runs on. datasets
# is pinned alongside it to the 2.x line that works against hf-hub 0.x.
RUN pip install \
    transformers==4.46 \
    "datasets>=2.20,<3" \
    "huggingface-hub<1.0" \
    && python -c "import transformers, datasets, importlib.util as u, importlib.metadata as m; \
assert transformers.__version__.startswith('4.46'), f'transformers moved off the pin: {transformers.__version__}'; \
assert u.find_spec('geneformer') is None, 'the geneformer package leaked in, see the comment above'; \
import numpy; assert numpy.__version__.startswith('1.26.'), f'numpy moved off the base pin: {numpy.__version__}'; \
click_v = m.version('click'); \
assert tuple(int(p) for p in click_v.split('.')[:2]) < (8, 2), f'click passed the flwr cap: {click_v}, check the huggingface-hub pin'; \
from transformers import BertForMaskedLM; \
print('transformers', transformers.__version__, 'datasets', datasets.__version__, 'click', click_v, 'OK')"

# ── bioengine, LAST ───────────────────────────────────────────────────────
# Pins live in worker/docker/versions.env, passed in as build args. Nothing
# installs below this line, so a BIOENGINE_REF bump rebuilds only this step.
#
# The protobuf and googleapis-common-protos re-pins share this RUN on purpose:
# bioengine drags in the protobuf 7 chain, Ray Serve 2.55 trips on it, and flwr
# caps protobuf below 5.0, so 4.25.x is the only mutually compatible band.
# worker/docker/README.md has the full write-up. Welding the correction to the
# install that causes it means the two cannot drift apart.
ARG BIOENGINE_REF
ARG HYPHA_RPC_PIN
RUN : "${BIOENGINE_REF:?BIOENGINE_REF build-arg is required, see worker/docker/versions.env}" \
    && : "${HYPHA_RPC_PIN:?HYPHA_RPC_PIN build-arg is required, see worker/docker/versions.env}" \
    && pip install "git+https://github.com/aicell-lab/bioengine.git@${BIOENGINE_REF}#egg=bioengine[datasets,worker]" \
    uv \
    pydantic==2.12.0 \
    pydantic-core==2.41.1 \
    "${HYPHA_RPC_PIN}" \
    && pip install "protobuf>=4.25.5,<5" "googleapis-common-protos<1.75.1"

# ── Chiron runtime patches ────────────────────────────────────────────────
#
# Local fixes to bioengine and hypha_rpc, applied in the image rather than in
# either upstream repo (CLAUDE.md marks bioengine read-only from the Chiron
# side). Every patch carries its own reason and remove_when in
# worker/docker/patches/apply_runtime_patches.py and a write-up in
# worker/docker/patches/README.md, so they can be reviewed and dropped one at a
# time.
#
# The script itself is not copied here. chiron-base stages it at
# /opt/chiron/patches/, and every model image in either repository runs that one
# copy, so the patch set cannot differ between images.
#
# The script fails the build when an anchor no longer matches, so a version
# bump cannot silently drop a patch and resurrect the original symptom.
#
# Must stay BELOW the bioengine install: a BIOENGINE_REF bump reinstalls the
# package and the patches have to re-run against the fresh source.
RUN python /opt/chiron/patches/apply_runtime_patches.py

# ── Chiron image identity ─────────────────────────────────────────────────
# chiron-manager reads these and reports them through get_worker_info(), which
# is how the platform knows what a worker can train and which trainer artifact
# to deploy onto it. A container without CHIRON_MODEL_FAMILY is treated as an
# image that predates per-model support.
#
# CHIRON_HVG_IN_FEATURE is the input width the data server cuts its binned
# layer and HVG mask to. It has to equal what this model declares. See
# worker/docker/README.md.
#
# The block sits BELOW the bioengine layer because CHIRON_IMAGE_REF changes on
# every release. ENV is metadata only, so nothing expensive is rebuilt here.
ARG CHIRON_IMAGE_REF
ENV CHIRON_MODEL_FAMILY=geneformer \
    CHIRON_MODEL_NAME="Geneformer" \
    CHIRON_TRAINER_ARTIFACT=chiron-platform/geneformer-trainer \
    CHIRON_HVG_IN_FEATURE=1200 \
    CHIRON_IMAGE_REF=${CHIRON_IMAGE_REF}

CMD [ "/bin/bash" ]
