# AGENTS.md

## Purpose

- `codefleet` is a multi-agent software delivery orchestrator.
- It turns source documents and change requests into structured work artifacts such as backlog epics/items and acceptance-test specifications.
- It coordinates specialized agent roles around those shared artifacts through CLI commands, MCP tools, and event-driven workflows.
- The system is designed to keep implementation work, review/polish steps, and acceptance validation aligned through explicit shared state.

## Core Concepts

- Backlog epics and items represent planned work, sequencing, and status transitions.
- Acceptance tests represent the externally visible outcomes expected from backlog work.
- Agent roles collaborate through shared project state and role-specific tooling rather than ad hoc instructions alone.
- System events, triggers, and watchers drive orchestration when repository or project state changes.

## Basic Rules for Changes
- Preserve type safety under the existing TypeScript settings (`strict: true`).
- Do not break Node ESM behavior, including import extensions and `NodeNext` resolution.
- Proactively add code comments to explain design intent that cannot be inferred directly from the code (e.g., trade-offs, invariants, and domain-specific constraints).

## Frequently Used Commands
- Install dependencies: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Generate schemas/types:
  - `npm run generate:app-server:types`

## Testing Policy
- For spec changes or bug fixes, add regression tests under `tests/` whenever possible.
- At minimum, run `npm test`; additionally run `npm run build` when type/build integrity needs verification.
