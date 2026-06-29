# Chiron Platform — CLAUDE.md

## What this repository is

**Chiron Platform** is the web frontend and federated orchestration layer for **Tabula**, a single-cell foundation model that combines tabular learning over genes with federated learning across institutions. Raw single-cell data never leaves the institution that owns it. Only shared transformer weights cross the network. See the bioRxiv preprint: https://www.biorxiv.org/content/10.1101/2025.01.06.631427v1.

`chiron.aicell.io` coordinates BioEngine Workers across institutions so they can train collaboratively. Tabula is currently the only model supported. Keep platform code model-agnostic where possible so future foundation models can plug in.

## Where to look first

- **Agent or end-user workflows on the platform** (browse the model hub, set up a worker, prepare datasets, launch and monitor federated training, contribute a trainer for another model) → `public/skills/chiron-platform/SKILL.md`. This is the public skill served at https://chiron.aicell.io/skills/chiron-platform/SKILL.md.
- **Repo maintainer operations** (Tabula backend env, BioEngine app upload and deploy, federated session walkthrough, image and resource baselines) → `.claude/skills/chiron-maintainer/SKILL.md`.
- **Manuscript and figure work** (paper draft, Figure 2 working directory, design references, hard constraints) → `.claude/skills/chiron-figures/SKILL.md`.

## Work tracks in this repo

Three connected tracks. Don't conflate them in a single commit.

1. **Platform code** — React frontend in `src/` and BioEngine worker assets in `worker/`. Edits land here.
2. **Manuscript** — local draft under `resources/` (gitignored). Edits in the markdown file, never committed.
3. **Figures** — main and supplementary figures under `resources/figure-2/` and `resources/Figure-{1,3,4}.png`. Vector SVG edits in the panel directories, also gitignored.

Code edits go in `src/` and `worker/`. Manuscript edits go in `resources/`. Figure edits go in `resources/figure-2/` (or a sibling figure dir once one exists).

## Companion repositories

| Repo | Location | Purpose |
|------|----------|---------|
| `chiron-platform` | this repo | React UI + federated orchestration apps |
| `tabula` | `../tabula/` (separate git repo) | Tabula model, FL client/server apps. Clone with `git clone https://github.com/aicell-lab/tabula ../tabula` if not present locally. |
| `bioengine` | `../bioengine/` (separate git repo) | Worker runtime framework. **Read-only from this repo:** surface bioengine bugs to the user instead of patching them inside `tabula/`. |

## Common commands

```bash
pnpm install        # install dependencies
pnpm start          # dev server at http://localhost:3000
pnpm build          # production build
pnpm test           # run tests
```

For Tabula backend setup, BioEngine app upload and deploy, and federated training session steps, see `.claude/skills/chiron-maintainer/SKILL.md`.

## Coding standards

### TypeScript / React

- Functional components and hooks only.
- Shared cross-page state lives in Zustand stores.
- Explicit TypeScript types for all RPC responses and structured data.
- Wrap every async call in `try/catch` and surface errors in the UI. Do not swallow them.
- Follow the styling language already in the file being edited. Do not introduce a new design system.
- Preserve existing component boundaries. No speculative abstractions.

### Python

- PEP 8, type hints on all public functions.
- Docstrings on significant classes and functions.
- Wrap I/O, network, and filesystem operations in `try/except` with meaningful messages.

### Naming

| Context | Convention |
|---------|------------|
| Python variables and functions | `snake_case` |
| Python classes | `PascalCase` |
| TS/JS variables and functions | `camelCase` |
| TS/JS classes | `PascalCase` |
| Files and folders | `snake_case` or `kebab-case`, consistent within each area |

## Architecture rules

- **Data privacy is non-negotiable.** Raw single-cell data never leaves the worker. Only transformer weights and scalar metrics cross the network.
- **Hypha RPC is the integration layer.** All cross-service calls go through Hypha. Do not add alternative transports.
- **Separation of concerns.** Orchestration logic stays out of React components. Worker, dataset, and UI code must not bleed into each other.
- **Platform vs. model.** Chiron platform code should stay model-agnostic where possible, anticipating future single-cell foundation models beyond Tabula.
- When a change touches deployment, service registration, or dataset access, read the relevant worker-side code before editing the UI.
- Prefer the smallest change that addresses the request. No speculative features or design-for-future additions beyond what the task requires.

## Key files to read before editing

| Area | File |
|------|------|
| Agent workspace + Hypha Core setup | `src/pages/AgentLab.tsx` |
| Hypha connection, auth, artifact state | `src/store/hyphaStore.ts` |
| Worker dashboard and deployment UI | `src/components/BioEngine/` |
| Setup wizard (Human / AI Agent toggle, manifest builder) | `src/components/BioEngine/BioEngineGuide.tsx` |
| Dataset and worker services | `worker/` |
| FL client implementation | `../tabula/tabula/distributed/federated_client.py` |
| Federated server (FedAvg) | `../tabula/apps/chiron_orchestrator/` |
| Local trainer app | `../tabula/apps/tabula_trainer/` |
| Control plane | `../tabula/apps/chiron_manager/` |
