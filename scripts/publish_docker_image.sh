#!/usr/bin/env bash
# Builds and pushes the Chiron worker images built in this repository to GHCR.
#
# Usage (run from the chiron-platform repo root):
#   scripts/publish_docker_image.sh [--model <name>|--all] [--build-only] [--skip-latest]
#
#   --model <name>   build one of: base scgpt geneformer scfoundation
#                    (default: base)
#   --all            build the base and then all three model images
#   --build-only     build locally, push nothing
#   --skip-latest    publish ONLY the versioned tags, leave :latest where it is
#
# Requires docker to be logged in to ghcr.io:
#   echo $GITHUB_TOKEN | docker login ghcr.io -u <username> --password-stdin
#
# chiron-tabula is NOT built here. It is built in the aicell-lab/tabula
# repository, against the chiron-base published by this script, until Tabula
# ships as a pip package. It pushes to the same ghcr.io/aicell-lab/chiron-*
# namespace: GHCR authorises a push against the organisation, not against the
# repository the build ran in.
#
# All images build from the repo root as context, because chiron-base installs
# worker/. See worker/docker/README.md for the layering and its rationale.
#
# The tag is taken from the version field in worker/pyproject.toml. The tabula
# repository carries the same number for chiron-tabula, and the two are bumped
# together, because chiron-tabula is FROM chiron-base at that version.
#
# --skip-latest publishes ONLY the versioned tags. Use it for any release that
# has not yet been validated on a live worker: an image tag of `latest` puts the
# image on every site at its next container restart. Promote `latest` as a
# separate, deliberate step once a federated round has been verified on the new
# tag.

set -euo pipefail

MODELS=(scgpt geneformer scfoundation)

BUILD_ONLY=false
SKIP_LATEST=false
BUILD_ALL=false
SELECTED=""

while [ $# -gt 0 ]; do
  case "$1" in
    --build-only)  BUILD_ONLY=true ;;
    --skip-latest) SKIP_LATEST=true ;;
    --all)         BUILD_ALL=true ;;
    --model)
      shift
      SELECTED="${1:-}"
      if [ -z "$SELECTED" ]; then
        echo "Error: --model needs a name (base ${MODELS[*]})"
        exit 1
      fi
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: scripts/publish_docker_image.sh [--model <name>|--all] [--build-only] [--skip-latest]"
      exit 1
      ;;
  esac
  shift
done

if [ "$BUILD_ALL" = true ] && [ -n "$SELECTED" ]; then
  echo "Error: --all and --model are mutually exclusive"
  exit 1
fi

# Default to the base. It is the only image every other build depends on, and
# building it alone is the common case when only requirements.txt or the data
# server changed.
SELECTED="${SELECTED:-base}"

if [ "$BUILD_ALL" = false ]; then
  valid=false
  for candidate in base "${MODELS[@]}"; do
    [ "$SELECTED" = "$candidate" ] && valid=true
  done
  if [ "$valid" = false ]; then
    echo "Error: unknown model '$SELECTED' (expected: base ${MODELS[*]})"
    exit 1
  fi
fi

# The image version. Read from worker/pyproject.toml, which is also the version
# of the chiron-platform package installed into the base, so there is one number
# rather than two that can disagree. package.json versions the website and is a
# different thing.
VERSION=$(grep '^version =' worker/pyproject.toml | sed -E 's/version = "(.*)"/\1/')

if [ -z "$VERSION" ]; then
  echo "Error: version not found in worker/pyproject.toml (run from the repo root)"
  exit 1
fi

# Shared pins (BIOENGINE_REF, HYPHA_RPC_PIN, SCGPT_REF). Single source of truth,
# so a bioengine bump is one edit in one file rather than three.
if [ ! -f worker/docker/versions.env ]; then
  echo "Error: worker/docker/versions.env not found (run from the repo root)"
  exit 1
fi
# shellcheck disable=SC1091
source worker/docker/versions.env

BASE_IMAGE="ghcr.io/aicell-lab/chiron-base:$VERSION"

# OCI labels. image.source is what GHCR reads to decide which repository a
# package belongs to, and it is the link on the package page. These are Chiron
# worker images, published for and consumed by the Chiron platform, so they all
# point at aicell-lab/chiron-platform, chiron-tabula included.
#
# revision is the commit the image was built from, so a running worker can be
# traced back to source. It is left empty outside a git checkout rather than
# guessed.
SOURCE_REPO="https://github.com/aicell-lab/chiron-platform"
REVISION=$(git rev-parse HEAD 2>/dev/null || echo "")

# Per-image title and description, so the GHCR package page says what the image
# is instead of repeating the repository name. Keyed by the image basename.
declare -A IMAGE_TITLE=(
  [chiron-base]="Chiron base"
  [chiron-scgpt]="Chiron worker: scGPT"
  [chiron-geneformer]="Chiron worker: Geneformer"
  [chiron-scfoundation]="Chiron worker: scFoundation"
)
declare -A IMAGE_DESC=(
  [chiron-base]="Shared layer for the Chiron worker images: Python 3.11, torch 2.6.0 on CUDA 12.4, the common scientific stack, and the Chiron data server. Carries no model code and no bioengine, and is not runnable on its own."
  [chiron-scgpt]="BioEngine worker image for federated training of scGPT, a generative pretrained transformer over single-cell expression."
  [chiron-geneformer]="BioEngine worker image for federated training of Geneformer, a transformer over rank-ordered gene expression."
  [chiron-scfoundation]="BioEngine worker image for federated training of scFoundation, a large-scale single-cell foundation model."
)

# licenses is asserted only where we know the answer. All three model images
# here install or vendor upstream model code whose terms are not ours to
# restate, so none of them carries a licenses label rather than a guess.
# scfoundation in particular is vendored source with no LICENSE file of its own,
# which is an open question.
#
# chiron-base is deliberately absent even though MIT would be accurate for it.
# A child image inherits its parent's labels, so labelling the base MIT stamps
# that claim onto every model image, including chiron-tabula built in the other
# repository, and defeats the point of leaving them unlabelled. The base is a
# build substrate, not something anyone pulls on its own, so dropping the label
# there costs nothing and keeps the claim where it is true.
declare -A IMAGE_LICENSE=()

# Fill the global LABEL_ARGS array with the --label flags for one image.
# An array rather than a string, because the titles and descriptions contain
# spaces and word splitting would shred them into separate arguments.
LABEL_ARGS=()
set_oci_labels() {
  local basename="${1##*/}"
  LABEL_ARGS=(
    --label "org.opencontainers.image.source=$SOURCE_REPO"
    --label "org.opencontainers.image.url=$SOURCE_REPO"
    --label "org.opencontainers.image.documentation=$SOURCE_REPO/blob/main/worker/docker/README.md"
    --label "org.opencontainers.image.vendor=AICell Lab"
    --label "org.opencontainers.image.version=$VERSION"
    --label "org.opencontainers.image.revision=$REVISION"
    --label "org.opencontainers.image.title=${IMAGE_TITLE[$basename]}"
    --label "org.opencontainers.image.description=${IMAGE_DESC[$basename]}"
  )
  if [ -n "${IMAGE_LICENSE[$basename]:-}" ]; then
    LABEL_ARGS+=(--label "org.opencontainers.image.licenses=${IMAGE_LICENSE[$basename]}")
  fi
}

# Every image built in this run, in push order.
BUILT=()

build_base() {
  echo
  echo "==> Building $BASE_IMAGE"
  set_oci_labels "chiron-base"
  docker build \
    "${LABEL_ARGS[@]}" \
    -f worker/docker/base/Dockerfile \
    -t "$BASE_IMAGE" \
    .
  BUILT+=("ghcr.io/aicell-lab/chiron-base")
}

build_model() {
  local model="$1"
  local image="ghcr.io/aicell-lab/chiron-$model:$VERSION"

  echo
  echo "==> Building $image"
  # Every model image takes CHIRON_BASE_IMAGE, BIOENGINE_REF, HYPHA_RPC_PIN and
  # CHIRON_IMAGE_REF. SCGPT_REF is passed to all of them for simplicity; a
  # Dockerfile that does not declare the matching ARG ignores it (docker warns,
  # harmlessly).
  #
  # CHIRON_IMAGE_REF is the image's own canonical name, baked in so a running
  # worker can report which image it came from.
  set_oci_labels "chiron-$model"
  docker build \
    "${LABEL_ARGS[@]}" \
    --build-arg "CHIRON_BASE_IMAGE=$BASE_IMAGE" \
    --build-arg "BIOENGINE_REF=$BIOENGINE_REF" \
    --build-arg "HYPHA_RPC_PIN=$HYPHA_RPC_PIN" \
    --build-arg "SCGPT_REF=$SCGPT_REF" \
    --build-arg "CHIRON_IMAGE_REF=$image" \
    -f "worker/docker/$model/Dockerfile" \
    -t "$image" \
    .
  BUILT+=("ghcr.io/aicell-lab/chiron-$model")
}

echo "Building Chiron images at version: $VERSION"
echo "  bioengine pin: $BIOENGINE_REF"
echo "  hypha_rpc pin: $HYPHA_RPC_PIN"

if [ "$BUILD_ALL" = true ]; then
  build_base
  for model in "${MODELS[@]}"; do
    build_model "$model"
  done
elif [ "$SELECTED" = "base" ]; then
  build_base
else
  # A single model image still needs its base. Building it here is a cache hit
  # when nothing under worker/ changed.
  build_base
  build_model "$SELECTED"
fi

if [ "$SKIP_LATEST" = false ]; then
  for repo in "${BUILT[@]}"; do
    docker tag "$repo:$VERSION" "$repo:latest"
  done
fi

echo
echo "Built:"
for repo in "${BUILT[@]}"; do
  echo "  $repo:$VERSION"
done

if [ "$BUILD_ONLY" = true ]; then
  echo "Skipping push because --build-only was specified."
  exit 0
fi

for repo in "${BUILT[@]}"; do
  echo
  echo "Pushing $repo:$VERSION"
  docker push "$repo:$VERSION"
done

if [ "$SKIP_LATEST" = true ]; then
  echo
  echo "Done. Published the versioned tags only (--skip-latest)."
  echo "Sites tracking :latest are unaffected. To promote once validated:"
  for repo in "${BUILT[@]}"; do
    echo "  docker tag $repo:$VERSION $repo:latest && docker push $repo:latest"
  done
  exit 0
fi

for repo in "${BUILT[@]}"; do
  echo
  echo "Pushing $repo:latest"
  docker push "$repo:latest"
done

echo
echo "Done. Published $VERSION and latest for:"
for repo in "${BUILT[@]}"; do
  echo "  $repo"
done
