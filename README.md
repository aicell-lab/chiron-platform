# Chiron Platform

A decentralized platform for training and reusing privacy-preserving
single-cell foundation models. Chiron brings the full federated training
life cycle into a single browser interface, so any institution can join
a federation without an infrastructure team.

Live deployment: [https://chiron.aicell.io](https://chiron.aicell.io).
The flagship model trained through Chiron is
[Tabula](https://www.biorxiv.org/content/10.1101/2025.01.06.631427v1),
a single-cell foundation model that combines tabular learning over
genes with federated learning across institutions.

## 🎯 Overview

Single-cell foundation models scale by aggregating data, but raw single
cell data carries patient identity and rarely leaves the institution
that owns it. Chiron removes that barrier. Each participating
institution runs a lightweight worker on its own hardware. A central
orchestrator coordinates federated rounds with FedAvg aggregation. Only
shared transformer weights and scalar metrics cross the network. Raw
data never moves over external channels.

The platform is built on top of
[BioEngine](https://github.com/aicell-lab/bioengine), the
distributed-computing layer that handles container scheduling, RPC, and
worker registration. Chiron adds three BioEngine applications that
implement the federated-learning roles:

- **Chiron Manager** is the control plane. It discovers datasets, spawns
  and tears down orchestrator and trainer applications, surfaces logs,
  and reports cluster state.
- **Chiron Orchestrator** runs the Flower-based FedAvg server that
  coordinates one federated training session at a time. It broadcasts
  the current transformer to every registered trainer, collects updated
  weights after each round, aggregates them, and repeats for the
  configured number of rounds.
- **Tabula Trainer** is the local Flower client that trains on the
  institution's private datasets. Multiple trainers register to one
  orchestrator. The trainer surface is foundation-model agnostic, so a
  different model (for example scGPT or Geneformer) can join a
  federation through the same trainer template.

Published checkpoints land in the **Chiron Model Hub**, a versioned
artifact collection with public landing pages, so any user can browse,
fork, retrain, or republish a model.

## ✨ What you can do

- **Browse published Tabula checkpoints** on the Model Hub, including
  per-tissue foundation snapshots and client-specific fine-tunes.
- **Set up a Chiron worker** on your own hardware through a browser
  wizard that emits a one-line launch command for Docker Compose,
  Podman, Singularity or Apptainer. The worker hosts two isolated
  containers: a data server that exposes private datasets only over
  the worker's container-internal network, and a Tabula trainer that
  holds the GPU-bound model.
- **Launch and monitor a federated training run** through the Training
  tab, with per-round training and validation loss curves and live
  downstream task metrics.
- **Publish trained checkpoints** to the Model Hub, either the
  FedAvg-aggregated global transformer or a trainer's full
  client-specific model.
- **Drive Chiron from an AI agent** through the public
  [Chiron skill](https://chiron.aicell.io/skills/chiron-platform/SKILL.md).
  Every action available in the UI is also available through Hypha RPC,
  and the skill is the contract any compatible AI agent can read to set
  up workers and data, launch and monitor a training run, or browse and
  reuse published models.

## 🏛️ Architecture

```
                    ┌────────────────────────────────────┐
                    │      chiron.aicell.io (this repo)  │
                    │     React + TypeScript frontend    │
                    └──────┬──────────────────┬──────────┘
                           │ Hypha RPC        │ Hypha artifacts
                           ▼                  ▼
        ┌──────────────────────────────┐   ┌──────────────────────┐
        │  Chiron Manager (per worker) │   │  Chiron Model Hub    │
        │  control plane RPC service   │   │  versioned artifact  │
        └──────────────┬───────────────┘   │  collection          │
                       │ deploys            └──────────────────────┘
                       ▼
        ┌──────────────────────────────┐   ┌──────────────────────┐
        │  Chiron Orchestrator         │◄──┤  Tabula Trainer (N)  │
        │  Flower FedAvg server        │   │  Flower client per   │
        │  per training session        │──►│  participating site  │
        └──────────────────────────────┘   └──────────────────────┘
                  ▲ scalar weights + metrics only ▼
                  ───────────────────────────────────
                            Raw cell data never crosses this line.
```

Each BioEngine worker registers under the `chiron-platform` Hypha
workspace and exposes its Chiron apps as Ray Serve deployments. Service
discovery, authentication, and per-dataset access control are handled
by BioEngine and Hypha; Chiron only owns the federated-training logic
and the user-facing surface.

## 📦 What lives in this repository

This repository contains the **Chiron web frontend** that powers
[https://chiron.aicell.io](https://chiron.aicell.io) and the
**federated orchestration glue** that the BioEngine worker pulls in
as a startup application. The BioEngine application sources for the
Chiron Manager, Chiron Orchestrator, and Tabula Trainer live in the
sibling [`aicell-lab/tabula`](https://github.com/aicell-lab/tabula)
repository, alongside the Tabula model code itself.

```
chiron-platform/
├── src/                          # React + TypeScript frontend
│   ├── pages/                    # Top-level pages (Landing, Models,
│   │                             #   MyModels, ModelDetail, Runs,
│   │                             #   AgentLab)
│   ├── components/
│   │   ├── BioEngine/            # Worker dashboard, setup wizard,
│   │   │                         #   app deployment UI
│   │   ├── training/             # Federated training tab, run
│   │   │                         #   monitor, save / publish weights
│   │   ├── models/               # Model Hub grid, model card
│   │   └── notebook/             # Embedded agent-lab notebook
│   ├── store/                    # Zustand state (Hypha connection,
│   │                             #   auth, artifact cache)
│   ├── utils/                    # Hypha RPC + artifact helpers
│   └── providers/                # Auth + Hypha providers
├── public/
│   └── skills/chiron-platform/   # Public AI-agent skill served at
│                                 #   chiron.aicell.io/skills/...
├── worker/                       # Optional worker-side assets
├── tests/e2e/                    # End-to-end federated run test
└── scripts/                      # Build, deploy, maintenance scripts
```

## 🚀 Quick start

### Run the web frontend locally

Requirements: Node.js 18+ and pnpm 8+.

```bash
git clone https://github.com/aicell-lab/chiron-platform.git
cd chiron-platform
pnpm install
pnpm start                       # http://localhost:3000
```

The UI talks to the live Hypha workspace at `https://hypha.aicell.io`
and the `chiron-platform` workspace. No backend needs to run locally.

### Join an existing federation as a worker

Open [chiron.aicell.io/#/worker](https://chiron.aicell.io/#/worker),
click **Launch your own BioEngine instance**, fill in worker name,
data directory, container runtime, and resource allocation, and copy
the one-line launch command. The wizard targets Docker Compose,
Podman, Singularity, and Apptainer. The launched worker auto-registers
in the `chiron-platform` workspace and shows up on the worker page
with its name, datasets, and hardware. The data server rescans the
data directory every 30 seconds.

Dataset preparation (folder layout, `manifest.yaml`, what the data
server handles automatically) is documented in the AI-agent skill at
[`public/skills/chiron-platform/references/data-prep.md`](public/skills/chiron-platform/references/data-prep.md).

### Drive Chiron from an AI agent

Point any compatible coding agent (Claude Code, Gemini CLI, Cursor,
etc.) at the public skill URL and let it set up the worker, prepare
the data, and launch the run on your behalf:

```
https://chiron.aicell.io/skills/chiron-platform/SKILL.md
```

The Chiron landing page exposes the same prompt as a one-click copy
button.

## 🧪 Development

| Command | What it does |
| --- | --- |
| `pnpm start` | Start the dev server on port 3000 with hot reload. |
| `pnpm build` | Production build into `build/`. |
| `pnpm test`  | Run the React Testing Library suite. |
| `pnpm tsc --noEmit` | Type-check without emitting output. |

Coding standards, naming conventions, and architecture rules are
documented in [`CLAUDE.md`](CLAUDE.md).

End-to-end federated runs are covered by
[`tests/e2e/full_pipeline.py`](tests/e2e/full_pipeline.py). It deploys
an orchestrator and two trainers on the demo workers, runs five
training rounds with a mid-run late-join, and verifies that the run
artifact lands in the user workspace.

## 🛠️ Tech stack

- **Frontend.** React 18, TypeScript, Tailwind CSS, Zustand, React
  Router. Build via Create React App / `react-scripts`.
- **State + RPC.** Hypha JavaScript SDK for service discovery and RPC,
  Hypha artifact manager for the Model Hub, presigned S3 URLs for file
  downloads.
- **Orchestration.** BioEngine for worker scheduling and Ray Serve for
  per-app deployments. Federated learning is implemented with the
  [Flower](https://flower.ai/) framework over BioEngine's RPC layer.
- **Backend apps.** Chiron Manager, Chiron Orchestrator, and Tabula
  Trainer are Python applications shipped from
  [`aicell-lab/tabula`](https://github.com/aicell-lab/tabula).

## 🤝 Contributing

External contributions are welcome, especially trainer images for
additional foundation models. See the trainer template at
[`public/skills/chiron-platform/references/trainer-artifact-template.md`](public/skills/chiron-platform/references/trainer-artifact-template.md)
for the model-side engineering and the Hypha RPC contract.

For platform-level changes (UI, orchestrator, manager, deployment),
open an issue or pull request on
[`aicell-lab/chiron-platform`](https://github.com/aicell-lab/chiron-platform).
Please follow the conventions in [`CLAUDE.md`](CLAUDE.md): functional
React components, TypeScript types on RPC responses, no speculative
abstractions, and the smallest change that addresses the request.

## 👥 Authors

The Chiron Platform code in this repository was developed at the
[AICell Lab](https://github.com/aicell-lab), Department of Applied
Physics, KTH Royal Institute of Technology / Science for Life
Laboratory (SciLifeLab), Stockholm, Sweden.

- **Nils Mechtel.** Main author, platform design and implementation.
  KTH Royal Institute of Technology / SciLifeLab.
- **Wei Ouyang.** Group leader, technical guidance.
  KTH Royal Institute of Technology / SciLifeLab.

The platform was built in collaboration with Jiayuan Ding, Jianhui
Lin, Ziyang Miao, Min Li, Jiliang Tang, Yuancheng Ryan Lu, Xiaojie
Qiu, and the rest of the co-authors on the Chiron / Tabula paper (see
[Citation](#-citation) below). The [`CITATION.cff`](CITATION.cff) file
carries the full author list with affiliations.

## 🪞 Repository mirrors

This repository is **maintained at**
[`aicell-lab/chiron-platform`](https://github.com/aicell-lab/chiron-platform).
A read-only copy is mirrored to
[`aristoteleo/chiron`](https://github.com/aristoteleo/chiron) for the
paper's *Code Availability* statement. Both copies are MIT-licensed and
share the same commit history. Please open issues and pull requests on
the AICell Lab repository.

## 📄 License

Released under the MIT License. See [`LICENSE`](LICENSE) for the full
terms.

## 📚 Citation

If you use Chiron Platform in your research, please cite the Chiron /
Tabula paper:

> Ding J., Lin J., Miao Z., Mechtel N., Jiang S., Wang Y., Fang Z.,
> Martin-Rufino J. D., Weng C., Saunders R., Xu W., Weissman J. S.,
> Li M., Tang J., Ouyang W., Lu Y. R., and Qiu X.
> *Predictive single cell foundation model for gene regulation and
> aging with privacy-preserving tabular learning.* bioRxiv, 2025.
> doi: [10.1101/2025.01.06.631427](https://doi.org/10.1101/2025.01.06.631427).

The [`CITATION.cff`](CITATION.cff) file in this repository carries the
full author list with affiliations. GitHub's *Cite this repository*
button reads from it.

## 🌟 Acknowledgments

We thank the single-cell genomics community and all collaborating
institutions whose data, infrastructure, and feedback shaped this
platform. Chiron stands on top of
[BioEngine](https://github.com/aicell-lab/bioengine) for distributed
worker orchestration, [Hypha](https://github.com/amun-ai/hypha) for
RPC and artifact management, and [Flower](https://flower.ai/) for the
federated-learning runtime.

---

<div align="center">
Maintained by the <a href="https://github.com/aicell-lab">AICell Lab</a>, KTH Royal Institute of Technology and SciLifeLab.
</div>
