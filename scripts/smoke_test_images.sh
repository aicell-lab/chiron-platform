#!/usr/bin/env bash
# Import smoke tests for the Chiron worker images.
#
# Usage (run from the chiron-platform repo root):
#   scripts/smoke_test_images.sh [version]
#
# Checks what each image is supposed to contain and, just as importantly, what it
# is supposed to NOT contain: the geneformer package, torchtext and scvi-tools are
# all deliberately absent and their absence is part of the contract (see
# worker/docker/README.md).
#
# Covers all five images, chiron-tabula included, even though that one is built
# in the aicell-lab/tabula repository. The five carry one version and are
# released as a set, and the flash-attn layer-sharing check below spans both
# repositories, so there is one place to run this and it is here. Every image has
# to be present locally or pullable.
#
# Runs on GPU 2. Never device 0: that is the Quadro P400, which is Pascal and
# cannot run FlashAttention.

set -uo pipefail

VERSION="${1:-$(grep '^version =' worker/pyproject.toml | sed -E 's/version = "(.*)"/\1/')}"
GPU="${CHIRON_SMOKE_GPU:-2}"

echo "Smoke testing Chiron images at version $VERSION on GPU $GPU"

FAILED=()

run_check() {
  local image="$1" label="$2" code="$3"
  echo
  echo "==> $label ($image)"
  if docker run --rm --gpus "\"device=$GPU\"" "$image" python -c "$code"; then
    echo "    PASS"
  else
    echo "    FAIL"
    FAILED+=("$label")
  fi
}

BASE_CODE='
import torch, flwr, pytorch_lightning, zarr, anndata, numpy
print("torch", torch.__version__, "cuda_available", torch.cuda.is_available())
assert torch.cuda.is_available(), "no GPU visible in the container"
print("flwr", flwr.__version__, "lightning", pytorch_lightning.__version__)
print("zarr", zarr.__version__, "anndata", anndata.__version__, "numpy", numpy.__version__)
'

# Every model image must be able to run the data server and import bioengine.
COMMON_CODE='
import bioengine, chiron.datasets, google.protobuf, flwr, importlib.metadata as m
print("bioengine", getattr(bioengine, "__version__", "?"), "protobuf", google.protobuf.__version__)
assert google.protobuf.__version__.startswith("4.25."), google.protobuf.__version__
click_v = m.version("click")
assert tuple(int(p) for p in click_v.split(".")[:2]) < (8, 2), f"click passed the flwr cap: {click_v}"
print("flwr", flwr.__version__, "click", click_v)
'

TABULA_CODE='
import torch, flash_attn
from flash_attn.modules.mha import MHA
assert not torch._C._GLIBCXX_USE_CXX11_ABI
print("flash-attn", flash_attn.__version__, "OK on torch", torch.__version__)
'

SCGPT_CODE='
import importlib.util as u, pytorch_lightning, numpy
import scgpt
from scgpt.tokenizer import GeneVocab
assert u.find_spec("torchtext") is None, "torchtext leaked in"
assert u.find_spec("scvi") is None, "scvi-tools leaked in"
assert pytorch_lightning.__version__.startswith("2."), pytorch_lightning.__version__
assert numpy.__version__.startswith("1.26."), numpy.__version__
print("scgpt OK, GeneVocab importable, lightning", pytorch_lightning.__version__)
'

GENEFORMER_CODE='
import importlib.util as u, transformers, datasets
assert transformers.__version__.startswith("4.46"), transformers.__version__
assert u.find_spec("geneformer") is None, "the geneformer package leaked in"
print("transformers", transformers.__version__, "datasets", datasets.__version__)
'

SCFOUNDATION_CODE='
import einops, local_attention
print("einops", einops.__version__, "local-attention OK")
'

run_check "ghcr.io/aicell-lab/chiron-base:$VERSION"          "base"                "$BASE_CODE"

run_check "ghcr.io/aicell-lab/chiron-tabula:$VERSION"        "tabula flash-attn"   "$TABULA_CODE"
run_check "ghcr.io/aicell-lab/chiron-scgpt:$VERSION"         "scgpt flash-attn"    "$TABULA_CODE"
run_check "ghcr.io/aicell-lab/chiron-scgpt:$VERSION"         "scgpt package"       "$SCGPT_CODE"
run_check "ghcr.io/aicell-lab/chiron-geneformer:$VERSION"    "geneformer stack"    "$GENEFORMER_CODE"
run_check "ghcr.io/aicell-lab/chiron-scfoundation:$VERSION"  "scfoundation stack"  "$SCFOUNDATION_CODE"

for model in tabula scgpt geneformer scfoundation; do
  run_check "ghcr.io/aicell-lab/chiron-$model:$VERSION" "$model bioengine + data server" "$COMMON_CODE"
done

echo
echo "=== flash-attn layer sharing (tabula vs scgpt) ==="
# Compare content digests, not `docker history` IDs. History reports <missing>
# for every non-leaf layer of a locally-built image, so comparing those compares
# nothing and passes even when the layers have genuinely diverged.
#
# RootFS.Layers is the ordered list of diff_ids. flash-attn is the first step
# after FROM in both files, so it sits at index len(base layers) in each.
layers() { docker inspect --format '{{range .RootFS.Layers}}{{println .}}{{end}}' "$1"; }
N_BASE=$(layers "ghcr.io/aicell-lab/chiron-base:$VERSION" | grep -c .)
T=$(layers "ghcr.io/aicell-lab/chiron-tabula:$VERSION" | sed -n "$((N_BASE + 1))p")
S=$(layers "ghcr.io/aicell-lab/chiron-scgpt:$VERSION"  | sed -n "$((N_BASE + 1))p")
echo "  base layers:   $N_BASE"
echo "  chiron-tabula: $T"
echo "  chiron-scgpt:  $S"
if [ -n "$T" ] && [ "$T" = "$S" ]; then
  echo "    PASS: flash-attn layer is shared"
else
  echo "    FAIL: flash-attn layer is NOT shared, the two RUN lines have drifted"
  FAILED+=("flash-attn layer sharing")
fi

echo
echo "=== image sizes ==="
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' \
  | grep -E "aicell-lab/(chiron-(base|tabula|scgpt|geneformer|scfoundation)|tabula):$VERSION"

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "All smoke tests passed."
else
  echo "FAILED (${#FAILED[@]}):"
  printf '  %s\n' "${FAILED[@]}"
  exit 1
fi
