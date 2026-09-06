"""What the suite needs to know about each model, beyond the app's own registry.

`src/config/chironModels.ts` is the platform's registry and stays the source of
truth for display names, images and memory. This file holds only the run
parameters, which are properties of the test bench rather than of the platform:
the batch size that fits a 24 GB card, and the dataset the model can actually
read.

Dataset choice is not cosmetic. The three gene-panel models need a set that
carries gene symbols, so they are pointed at one by name rather than taking
whichever row the launch dialog happens to list first. Skin Aging - BLSA is the
row they must not take: it is already cut to Tabula's 1200-gene input and
carries no `feature_name`, so it is the one demo dataset only Tabula can read.
"""

MODELS = [
    {
        "slug": "tabula",
        "display": "Tabula",
        "image": "ghcr.io/aicell-lab/chiron-tabula",
        # Tabula's local part is input-side and sized by the gene panel, so it
        # trains happily on the small tissue set.
        "dataset": None,
        "batch_size": 8,
        "worker_memory_gb": 30,
    },
    {
        "slug": "scgpt",
        "display": "scGPT",
        "image": "ghcr.io/aicell-lab/chiron-scgpt",
        "dataset": "Blood-Perturb",
        "batch_size": 32,
        "worker_memory_gb": 30,
    },
    {
        "slug": "geneformer",
        "display": "Geneformer",
        "image": "ghcr.io/aicell-lab/chiron-geneformer",
        "dataset": "Blood-Perturb",
        "batch_size": 16,
        "worker_memory_gb": 40,
    },
    {
        "slug": "scfoundation",
        "display": "scFoundation",
        "image": "ghcr.io/aicell-lab/chiron-scfoundation",
        "dataset": "Blood-Perturb",
        "batch_size": 8,
        "worker_memory_gb": 48,
    },
]

BY_SLUG = {model["slug"]: model for model in MODELS}
SLUGS = [model["slug"] for model in MODELS]
