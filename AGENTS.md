# AGENTS.md

This file applies to the entire repository tree under `/workspace/buildfleet`.

## Purpose
- `buildfleet` is a TypeScript-based CLI and domain-service implementation.
- Primary concerns are domain logic consistency, JSON schema consistency, and event-processing stability.

## Basic Rules for Changes
- Keep the impact surface minimal (avoid unnecessary renames, reformatting, or dependency additions).
- Preserve type safety under the existing TypeScript settings (`strict: true`).
- Do not break Node ESM behavior, including import extensions and `NodeNext` resolution.
- When updating generated artifacts, verify consistency across source, schemas, and tests.
- Proactively add code comments to explain design intent that cannot be inferred directly from the code (e.g., trade-offs, invariants, and domain-specific constraints).

## Recommended Workflow
1. Identify the exact change target.
2. Implement the fix with the smallest practical diff.
3. Run the required checks.
4. Commit with a clear explanation of rationale and scope.

## Frequently Used Commands
- Install dependencies: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Generate schemas/types:
  - `npm run generate:app-server:types`
  - `npm run generate:app-server:schemas`

## Testing Policy
- For spec changes or bug fixes, add regression tests under `tests/` whenever possible.
- At minimum, run `npm test`; additionally run `npm run build` when type/build integrity needs verification.

## Documentation Update Policy
- If specs or operational flow change, update documentation under `docs/` as well.
- For JSON schema changes, consider corresponding updates to `schemas/README.md` and related docs.
