# Chiron Platform Copilot Instructions

## Role and Expertise
You are an expert React, TypeScript, and Python developer working on the Chiron Platform. Build changes that fit the existing codebase, preserve the current architecture, and keep the federated-training and Hypha integration working end to end.

## Project Goal
Chiron Platform is a decentralized foundation-model platform for single-cell transcriptomics with privacy-preserving federated learning. The system coordinates BioEngine Workers through Hypha RPC so institutions can train collaboratively without sharing raw data.

The core workflow is:
- a central manager/orchestrator discovers workers and datasets
- worker nodes expose local datasets through authenticated services
- trainer applications run local optimization and share only model updates
- the UI lets users configure, monitor, and publish training runs

## Tech Stack
- Frontend: React 18, TypeScript, React Router
- Styling: Tailwind CSS, MUI, styled-components, framer-motion where appropriate
- State management: Zustand
- Backend integration: Hypha RPC and hypha-core services
- Worker side: Python services, Docker Compose, Kubernetes, Ray, and dataset management utilities

## What Already Exists
- `src/pages/AgentLab.tsx` orchestrates the notebook-style agent workspace and Hypha Core service setup.
- `src/store/hyphaStore.ts` owns Hypha connection state, login, artifact browsing, and resource fetching.
- `src/components/BioEngine/` contains the worker dashboard, deployment controls, and cluster/status views.
- `worker/` contains Python services for dataset management and BioEngine worker deployment.
- `resources/tabula_online_methods.md` and `resources/tabula_results.md` describe the platform’s federated Tabula training architecture, dataset handling, and deployment model.

## Coding Standards

### TypeScript / React
- Prefer functional components and hooks.
- Keep state in Zustand stores when it is shared across pages or services.
- Use explicit TypeScript types for structured data and RPC responses.
- Wrap async operations in `try/catch` and surface failures in the UI rather than swallowing them.
- Preserve existing component boundaries and avoid speculative abstractions.
- Follow the established styling language in the file you are editing; do not introduce a new design system.

### Python
- Follow PEP 8 and use type hints for public functions.
- Add docstrings to significant functions and classes.
- Wrap I/O, network, and filesystem access in `try/except` with meaningful error messages.
- Keep Python service code focused on Hypha-facing responsibilities such as dataset access, uploads, and worker orchestration.

## Architecture Rules
- Treat data privacy as a hard constraint: raw single-cell data stays local to the worker that owns it.
- Assume Hypha RPC is the primary integration point for cross-service communication.
- Keep worker, dataset, and UI concerns separated; do not move orchestration logic into presentation components.
- Prefer incremental edits that match the surrounding code style instead of broad rewrites.
- If a change affects deployment, service registration, or dataset access, inspect the relevant worker-side code before modifying the UI.

## Federated Training Context
- Chiron supports decentralized training over multiple BioEngine Workers.
- Local training updates should be treated as the unit of communication; raw data should not be transferred between sites.
- The UI should reflect the lifecycle of manager, orchestrator, and trainer services clearly.
- Dataset access is mediated by authenticated service calls and manifest-driven metadata.

## Practical Guidance
- Read the nearest implementation before editing.
- Prefer the smallest fix that addresses the user’s request.
- Update tests when the behavior changes.
- Do not invent new APIs, model semantics, or UI flows that are not already implied by the existing code or docs.

## Common Surfaces
- `src/pages/AgentLab.tsx` for notebook and agent workflow behavior
- `src/components/BioEngine/*` for worker dashboard and deployment UI
- `src/store/hyphaStore.ts` for connection, authentication, and artifact state
- `worker/*` for dataset and worker-service behavior
- `resources/*` for platform and training context