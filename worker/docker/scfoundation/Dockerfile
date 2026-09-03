# chiron-scfoundation, the Chiron worker runtime for scFoundation.
#
# Layer order:
#   einops + local-attention  →  bioengine (LAST)
#
# The data server is not installed here. It comes from chiron-base, which every
# model image is built on, so this image carries no other model's code.
#
# The thinnest of the four images. scFoundation has no packaging of its own
# anywhere upstream: no setup.py, no pyproject.toml, no requirements.txt, no
# Dockerfile. (`pip install scfoundation` installs an unrelated third-party
# package. Do not.)
#
# Built by scripts/publish_docker_image.sh with the repo root as context.

ARG CHIRON_BASE_IMAGE
FROM ${CHIRON_BASE_IMAGE}

# The only two imports scFoundation's model code needs beyond the base.
#
# local-attention is dead weight in practice but not optional: performer.py
# imports LocalAttention at module top level even though it is never
# instantiated at the default local_attn_heads=0.
RUN pip install \
    einops \
    local-attention \
    && python -c "import einops, local_attention; \
import numpy; assert numpy.__version__.startswith('1.26.'), f'numpy moved off the base pin: {numpy.__version__}'; \
print('einops', einops.__version__, 'local-attention OK')"

# No scFoundation model code and no checkpoint in this image, on purpose.
#
# The ~50 KB of model source (pretrainmodels/) and the 228 KB
# OS_scRNA_gene_index.19264.tsv are vendored into the trainer app artifact
# instead. Upstream forces vendoring either way: performer.py uses an absolute
# import (`from pretrainmodels.reversible import ...`) while select_model.py uses
# a relative one, so the directory has to sit on sys.path. The replica bootstrap
# already puts the artifact's source/ dir there
# (bioengine/_app/replica_init.py:284-285), so the app is the natural home, and
# shipping it there means model fixes are an app re-upload rather than an image
# rebuild across every site.
#
# The checkpoint is fetched at runtime by the trainer app. Its licence is
# non-transferable, non-sublicensable and non-commercial, so each site downloads
# under its own grant and Chiron never redistributes it.

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
ENV CHIRON_MODEL_FAMILY=scfoundation \
    CHIRON_MODEL_NAME="scFoundation" \
    CHIRON_TRAINER_ARTIFACT=chiron-platform/scfoundation-trainer \
    CHIRON_HVG_IN_FEATURE=1200 \
    CHIRON_IMAGE_REF=${CHIRON_IMAGE_REF}

CMD [ "/bin/bash" ]
