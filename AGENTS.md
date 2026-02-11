# AGENTS.md

## Purpose

- `buildfleet` is a product that orchestrates teams where multiple coding agents run concurrently.
- It reads and decomposes documents into requirements, and enables multiple agents to collaborate around acceptance-test specifications and backlog items as a shared hub.

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
