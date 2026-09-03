"""Create the ``chiron-platform/chiron-architectures`` collection and its cards.

Maintainer script. Run it with an admin token for the ``chiron-platform``
workspace whenever a card changes. It is idempotent: the collection is created
with ``overwrite=True`` and every card is re-created from the definitions below,
so editing a card here and re-running is the supported way to change one.

Why a separate collection rather than a card inside ``chiron-models``
---------------------------------------------------------------------
``chiron-models`` grants ``{"*": "rw+"}`` so that any logged-in user can publish
a checkpoint they trained. These cards are different: a card names the remote
source every worker in every federation downloads its base weights from, so
write access to a card is write access to what runs on other people's hardware.
This collection is therefore read-only to everyone (``{"*": "r+"}``) and only
workspace admins can edit a card.

What a card is for
------------------
Two jobs, and it is worth keeping them apart.

1. It tells a visitor which architectures the platform is about, including the
   ones that are not usable yet. Without it, ``#/models`` shows a pile of Tabula
   checkpoints and nothing else.
2. It is the source of truth for where base weights come from. The trainer
   resolves ``chiron.base_weights`` at load time, so moving an upstream
   checkpoint is a card edit rather than a trainer release.

``base_weights`` accepts either shape:

    base_weights:
      artifact_id: chiron-platform/tabula-foundation   # weights held in Hypha
      file_path: model.pth

    base_weights:
      url: https://huggingface.co/.../models.ckpt      # weights held upstream
      sha256: 9f40bf...                                # optional but verified

A card with no ``base_weights`` block means the base checkpoint for that model
is not settled yet, which is the honest state for scGPT and Geneformer today.

The split with ``src/config/chironModels.ts``
---------------------------------------------
That file stays the source of truth for anything the UI must render before it
has made a network call: badge colours, reference memory, worker RAM, summaries,
and the image identity contract. The card owns base weights and published
status, which are the two things that have to be changeable without a release.
"""

import asyncio
import os

import httpx
from dotenv import load_dotenv
from hypha_rpc import connect_to_server

load_dotenv()

SERVER_URL = os.getenv("SERVER_URL", "https://hypha.aicell.io")
WORKSPACE = "chiron-platform"
COLLECTION_ALIAS = f"{WORKSPACE}/chiron-architectures"

# Read-only to everyone. `r+` expands to the read side of the permission set,
# which is what a visitor needs to see the cards and what a trainer needs to
# resolve base weights. Nobody outside the workspace admins can edit one.
READER_PERMISSIONS = "r+"

TABULA_DOCS = """\
# Tabula

Tabula is the foundation model Chiron was built around: a tabular transformer
over genes, pretrained by masked value reconstruction across many single-cell
datasets. It is the one architecture the platform currently guarantees, and the
one every federated training run on `chiron.aicell.io` uses today.

Preprint: <https://www.biorxiv.org/content/10.1101/2025.01.06.631427v1>

## Base weights

The pretrained checkpoint published as
[`tabula-foundation`](/models/tabula-foundation). Selecting the base weights in
the training configuration resolves through this card, so the source can be
moved without redeploying a trainer.

## Running it

Set up a worker from the [worker guide](/worker) and pick Tabula. The image is
`ghcr.io/aicell-lab/chiron-tabula`, and the trainer application is
`chiron-platform/tabula-trainer`.
"""

SCGPT_DOCS = """\
# scGPT

scGPT is a generative pretrained transformer for single-cell multi-omics, from
Bowang Lab. Chiron ships a trainer and a container image for it, and the model
trains end to end in the lab, but it is not offered in the worker setup wizard
yet.

Upstream: <https://github.com/bowang-lab/scGPT>

## Status

Coming soon. What is left is a published base checkpoint the federation can
agree on. The gene vocabulary is already fixed, because every worker runs the
same pinned `chiron-scgpt` image and takes scGPT's default HGNC symbol
vocabulary from it, which is what keeps two sites from disagreeing about what a
token means.
"""

GENEFORMER_DOCS = """\
# Geneformer

Geneformer is a rank-value-encoded transformer pretrained on a large human
single-cell corpus, from the Theodoris lab. Chiron ships a trainer and a
container image for it, but it is not offered in the worker setup wizard yet.

Upstream: <https://huggingface.co/ctheodoris/Geneformer>

## Status

Coming soon. The tokenizer side is settled: the token and gene-median
dictionaries are pinned to a single upstream commit and verified by digest
before they are unpickled, so every site encodes genes identically. What is left
is agreeing on which pretrained checkpoint the federation starts from.
"""

SCFOUNDATION_DOCS = """\
# scFoundation

scFoundation is a large-scale pretrained model for single-cell transcriptomics,
from GenBio AI. Chiron ships a trainer and a container image for it, but it is
not offered in the worker setup wizard yet.

Upstream: <https://huggingface.co/genbio-ai/scFoundation>

## Base weights and licensing

The checkpoint is fetched at runtime from Hugging Face rather than mirrored
here. Its licence is non-commercial and non-sublicensable, so each site
downloads it under its own grant. The digest recorded on this card is verified
before the file is loaded, which matters because the bundle is a nested pickle
that has to be loaded with `weights_only=False` and therefore executes code.

## Status

Coming soon.
"""

# One entry per architecture. `status` mirrors `src/config/chironModels.ts`, and
# the two must be changed together when a model becomes available.
ARCHITECTURES = [
    {
        "alias": "tabula",
        "docs": TABULA_DOCS,
        "manifest": {
            "name": "Tabula",
            "description": (
                "Tabular transformer over genes, pretrained by masked value "
                "reconstruction. The model Chiron was built around, and the one "
                "the platform currently guarantees."
            ),
            "type": "model",
            "cover": "tabula.png",
            "chiron": {
                "model_family": "tabula",
                "status": "available",
                "trainer_artifact": "chiron-platform/tabula-trainer",
                "image_repository": "ghcr.io/aicell-lab/chiron-tabula",
                "base_weights": {
                    "artifact_id": "chiron-platform/tabula-foundation",
                    "file_path": "model.pth",
                    "label": "Tabula foundation weights",
                },
            },
        },
    },
    {
        "alias": "scgpt",
        "docs": SCGPT_DOCS,
        "manifest": {
            "name": "scGPT",
            "description": (
                "Generative pretrained transformer for single-cell multi-omics. "
                "Trainer and image are in place, not yet offered in the worker "
                "setup wizard."
            ),
            "type": "model",
            "cover": "scgpt.png",
            "chiron": {
                "model_family": "scgpt",
                "status": "coming-soon",
                "trainer_artifact": "chiron-platform/scgpt-trainer",
                "image_repository": "ghcr.io/aicell-lab/chiron-scgpt",
                # No base_weights: the federation has no agreed starting
                # checkpoint for scGPT yet. Runs start from a fresh model.
            },
        },
    },
    {
        "alias": "geneformer",
        "docs": GENEFORMER_DOCS,
        "manifest": {
            "name": "Geneformer",
            "description": (
                "Rank-value-encoded transformer pretrained on a large human "
                "single-cell corpus. Trainer and image are in place, not yet "
                "offered in the worker setup wizard."
            ),
            "type": "model",
            "cover": "geneformer.png",
            "chiron": {
                "model_family": "geneformer",
                "status": "coming-soon",
                "trainer_artifact": "chiron-platform/geneformer-trainer",
                "image_repository": "ghcr.io/aicell-lab/chiron-geneformer",
                # No base_weights: the tokenizer dictionaries are pinned in the
                # trainer, but which pretrained checkpoint the federation starts
                # from is not settled.
            },
        },
    },
    {
        "alias": "scfoundation",
        "docs": SCFOUNDATION_DOCS,
        "manifest": {
            "name": "scFoundation",
            "description": (
                "Large-scale pretrained model for single-cell transcriptomics. "
                "Trainer and image are in place, not yet offered in the worker "
                "setup wizard."
            ),
            "type": "model",
            "cover": "scfoundation.png",
            "chiron": {
                "model_family": "scfoundation",
                "status": "coming-soon",
                "trainer_artifact": "chiron-platform/scfoundation-trainer",
                "image_repository": "ghcr.io/aicell-lab/chiron-scfoundation",
                # Fetched from upstream at runtime under each site's own licence
                # grant, never mirrored into this workspace. The digest is
                # verified before the bundle is unpickled. Keep both pinned to
                # the same revision as apps/scfoundation_trainer/checkpoint.py.
                "base_weights": {
                    "url": (
                        "https://huggingface.co/genbio-ai/scFoundation/resolve/"
                        "cb434153a1acfacd215eefc956ea445f7cc39cc3/models.ckpt"
                    ),
                    "sha256": (
                        "9f40bf324d3d0084c4b288d06f5af4fddd12206e2a3f0225"
                        "51d12e89e33a0ea9"
                    ),
                    "label": "scFoundation pretrained bundle",
                },
            },
        },
    },
]


async def bootstrap() -> None:
    token = os.environ.get("WORKSPACE_TOKEN") or os.environ.get("HYPHA_TOKEN")
    if not token:
        raise SystemExit(
            "Set WORKSPACE_TOKEN (or HYPHA_TOKEN) to an admin token for the "
            f"'{WORKSPACE}' workspace before running this script."
        )

    server = await connect_to_server(
        {"server_url": SERVER_URL, "workspace": WORKSPACE, "token": token}
    )
    try:
        artifact_manager = await server.get_service("public/artifact-manager")

        collection_manifest = {
            "name": "Chiron Architectures",
            "description": (
                "The single-cell foundation model architectures the Chiron "
                "Platform supports, including the ones that are not usable "
                "yet. Each card names where its base weights come from."
            ),
        }
        collection_config = {"permissions": {"*": READER_PERMISSIONS}}
        try:
            collection = await artifact_manager.create(
                alias=COLLECTION_ALIAS,
                type="collection",
                manifest=collection_manifest,
                config=collection_config,
            )
        except Exception as error:
            # Deliberately not `overwrite=True`: on the artifact manager that
            # deletes the collection and every card under it, so a re-run to
            # change one card's weight source would take the other three down
            # with it. Edit the existing collection in place instead.
            if "already exists" not in str(error).lower():
                raise
            collection = await artifact_manager.edit(
                artifact_id=COLLECTION_ALIAS,
                manifest=collection_manifest,
                config=collection_config,
            )
            print("Collection already existed, updated in place.")
        print(f"Collection: {collection['id']}")
        print(f"Permissions: {collection['config'].get('permissions')}")

        for arch in ARCHITECTURES:
            alias = arch["alias"]
            card = await artifact_manager.create(
                parent_id=COLLECTION_ALIAS,
                alias=f"{WORKSPACE}/{alias}",
                type="model",
                manifest=arch["manifest"],
                version="stage",
                overwrite=True,
            )
            put_url = await artifact_manager.put_file(
                card["id"], file_path="documentation.md"
            )
            async with httpx.AsyncClient(timeout=60) as client:
                response = await client.put(
                    put_url, content=arch["docs"].encode("utf-8")
                )
                response.raise_for_status()
            await artifact_manager.commit(card["id"])
            status = arch["manifest"]["chiron"]["status"]
            print(f"  {card['id']}  ({status})")
    finally:
        await server.disconnect()


if __name__ == "__main__":
    asyncio.run(bootstrap())
