# Chiron Platform — CLAUDE.md

## What this repository is

**Chiron Platform** is the web frontend and federated orchestration layer for **Tabula**, a single-cell foundation model that combines tabular learning over genes with federated learning across institutions. Raw single-cell data never leaves the institution that owns it. Only shared transformer weights cross the network. See the bioRxiv preprint: https://www.biorxiv.org/content/10.1101/2025.01.06.631427v1.

`chiron.aicell.io` coordinates BioEngine Workers across institutions so they can train collaboratively. Tabula and scGPT are supported today, with Geneformer and scFoundation being brought online one at a time.

## Where to look first

- **Agent or end-user workflows on the platform** (browse the model hub, set up a worker, prepare datasets, launch and monitor federated training, contribute a trainer for another model) → `public/skills/chiron-platform/SKILL.md`. This is the public skill served at https://chiron.aicell.io/skills/chiron-platform/SKILL.md.
- **Repo maintainer operations** (Tabula backend env, BioEngine app upload and deploy, federated session walkthrough, image and resource baselines) → `.claude/skills/chiron-maintainer/SKILL.md`.
- **Manuscript and figure work** (paper draft, Figure 2 working directory, design references, hard constraints) → `.claude/skills/chiron-figures/SKILL.md`.

## The manuscript and the figures are not in git

`/resources` and `/outputs` are gitignored (`.gitignore` lines 4 and 5). The paper draft and the figure sources live under `resources/`, so they are edited in place and never committed, and `git status` will not show them. Code goes in `src/` and `worker/`.

## Companion repositories

| Repo | Location | Purpose |
|------|----------|---------|
| `chiron-platform` | this repo | React UI + federated orchestration apps |
| `tabula` | `../tabula/` (separate git repo) | Tabula model, FL client/server apps. Clone with `git clone https://github.com/aicell-lab/tabula ../tabula` if not present locally. |
| `bioengine` | `../bioengine/` (separate git repo) | Worker runtime framework. **Read-only from this repo:** surface bioengine bugs to the user instead of patching them inside `tabula/`. |

## Common commands

This project uses **pnpm**, not npm.

```bash
pnpm install        # install dependencies
pnpm start          # dev server at http://localhost:3000
pnpm build          # production build
pnpm test           # run tests
```

For Tabula backend setup, BioEngine app upload and deploy, and federated training session steps, see `.claude/skills/chiron-maintainer/SKILL.md`.

## Architecture rules

Three constraints that no test in this repo enforces and that the code does not state.

- **Data privacy is non-negotiable.** Raw single-cell data never leaves the worker. Only transformer weights and scalar metrics cross the network.
- **Hypha RPC is the integration layer.** All cross-service calls go through Hypha. Do not add alternative transports.
- **Platform vs. model.** Chiron platform code should stay model-agnostic where possible, anticipating future single-cell foundation models beyond Tabula.

## Key files that a search of this repo will not find

The orchestration half of the platform lives in the `tabula` repo, so these are not reachable from here by grep.

| Area | File |
|------|------|
| FL client implementation | `../tabula/tabula/distributed/federated_client.py` |
| Federated server (FedAvg) | `../tabula/apps/chiron_orchestrator/` |
| Local trainer app | `../tabula/apps/tabula_trainer/` |
| Control plane | `../tabula/apps/chiron_manager/` |

In this repo, `src/store/hyphaStore.ts` holds the Hypha connection, auth and artifact state that most pages read from, and `src/components/BioEngine/` holds the worker dashboard and deployment UI.
