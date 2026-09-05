# chiron-scgpt, the Chiron worker runtime for scGPT.
#
# Layer order:
#   flash-attn  →  scGPT stack  →  bioengine (LAST)
#
# The data server is not installed here. It comes from chiron-base, which every
# model image is built on, so this image carries no other model's code.
#
# The flash-attn RUN below is byte-identical to the one in the chiron-tabula
# Dockerfile in the tabula repository, and must stay that way. Same parent layer
# plus same command string means a machine that builds both images builds that
# ~2 GB step once and shares it. The comments differ (Docker ignores them), the
# RUN must not.
#
# Built by scripts/publish_docker_image.sh with the repo root as context.

ARG CHIRON_BASE_IMAGE
FROM ${CHIRON_BASE_IMAGE}

# Flash Attention, prebuilt. The wheel must match the interpreter (cp311), the
# torch minor (2.6) and torch's C++ ABI. PyPI torch 2.6.0 is built with the OLD
# ABI, so the cxx11abiFALSE wheel is the correct one.
#
# 2.7.4.post1 is deliberately not the newest release. From 2.8.0.post2 onward the
# published cxx11abiFALSE wheels for torch2.6 are in fact built against a NEW-ABI
# torch, and installing one here fails at import with an undefined
# std::__cxx11::basic_string symbol. worker/docker/README.md records the symbol
# check that established this. Do not bump the wheel without re-running it.
#
# The import check below is what caught that mismatch. Keep it: without it a bad
# wheel ships silently and surfaces as an opaque symbol error at first fit.
#
# KEEP THIS RUN BYTE-IDENTICAL TO the chiron-tabula Dockerfile in the tabula
# repository, so the two images share the built layer.
RUN pip install https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/flash_attn-2.7.4.post1+cu12torch2.6cxx11abiFALSE-cp311-cp311-linux_x86_64.whl \
    && python -c "import torch; \
assert not torch._C._GLIBCXX_USE_CXX11_ABI, \
'torch switched to the CXX11 ABI: re-check which flash-attn wheel matches'; \
import flash_attn; from flash_attn.modules.mha import MHA; \
print('flash-attn', flash_attn.__version__, 'OK on torch', torch.__version__)"

# scGPT's own scientific dependencies, minus everything the base already has
# (numpy, scikit-learn, umap-learn, anndata, scipy).
#
# ipython is here because scgpt/utils/util.py does `from IPython import
# get_ipython` at module top level, so `import scgpt` fails outright without it.
# It is a real runtime dependency of the package, not a notebook convenience.
#
# datasets and huggingface-hub are pinned to resolve a genuine three-way
# conflict rather than out of caution:
#   - scGPT declares datasets<3, so the 5.x that pip picks unpinned is wrong.
#   - huggingface-hub 1.x requires click>=8.4.2, while flwr 1.22.0 requires
#     click<8.2.0. Those are mutually exclusive, and flwr is what the federated
#     client runs on, so hf-hub stays on the 0.x line. datasets 2.21 is happy
#     there (it needs >=0.21.2) and click stays at the 8.1.8 the base ships.
# Dropping either pin puts click at 8.4.2 and breaks flwr's declared contract.
RUN pip install \
    scanpy \
    pandas \
    numba \
    scikit-misc \
    leidenalg \
    ipython \
    "datasets>=2.20,<3" \
    "huggingface-hub<1.0"

# scGPT itself, from git at the pin in worker/docker/versions.env, with --no-deps.
#
# --no-deps is load-bearing, not caution. scGPT declares scvi-tools>=0.16.0,<1.0
# as a *core* dependency, which transitively pins pytorch-lightning>=1.9,<1.10
# and would tear out the Lightning 2.x this platform trains on. No file under
# scgpt/ imports scvi-tools. The declared list also drags in torchtext, which is
# archived and has no wheels for modern Python or torch.
#
# The checks afterwards are the point of doing it this way: they fail the build
# if the resolution silently moved numpy off the base pin or downgraded
# Lightning, either of which would otherwise surface much later as a wrong-dtype
# error or a missing Trainer API.
ARG SCGPT_REF
RUN : "${SCGPT_REF:?SCGPT_REF build-arg is required, see worker/docker/versions.env}" \
    && pip install --no-deps "git+https://github.com/bowang-lab/scGPT.git@${SCGPT_REF}" \
    && python -c "import numpy, pytorch_lightning, importlib.util as u, importlib.metadata as m; \
assert numpy.__version__.startswith('1.26.'), f'numpy moved off the base pin: {numpy.__version__}'; \
assert pytorch_lightning.__version__.startswith('2.'), f'lightning was downgraded: {pytorch_lightning.__version__}'; \
assert u.find_spec('torchtext') is None, 'torchtext leaked in: the --no-deps install is not doing its job'; \
assert u.find_spec('scvi') is None, 'scvi-tools leaked in: it would pin lightning below 1.10'; \
click_v = m.version('click'); \
assert tuple(int(p) for p in click_v.split('.')[:2]) < (8, 2), f'click passed the flwr cap: {click_v}, check the huggingface-hub pin'; \
import scgpt, scgpt.model, scgpt.tasks, scgpt.scbank, scgpt.utils; \
from scgpt.tokenizer import GeneVocab; \
print('scgpt OK on numpy', numpy.__version__, 'lightning', pytorch_lightning.__version__, 'click', m.version('click'))"

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
ENV CHIRON_MODEL_FAMILY=scgpt \
    CHIRON_MODEL_NAME="scGPT" \
    CHIRON_TRAINER_ARTIFACT=chiron-platform/scgpt-trainer \
    CHIRON_HVG_IN_FEATURE=1200 \
    CHIRON_IMAGE_REF=${CHIRON_IMAGE_REF}

CMD [ "/bin/bash" ]
