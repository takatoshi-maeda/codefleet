## Current Task

Epic ID to implement now: {{epicId}}

Objectives:
- Build an implementation that fully satisfies the Epic and its related Items.

Implementation guidance:
- If anything is unclear, proceed with the best judgment based on explicit assumptions.
- Record assumptions and decisions by appending notes to the relevant Item.
- Before implementation, run the following commands to review requirements, Epic, and Items:
  - `codefleet-backlog requirements read`
  - `codefleet-backlog epic read --id {{epicId}}`
  - `codefleet-backlog item list --epic-id {{epicId}}`
- Start the development environment first, and keep it running while implementing and validating changes.
- Build and validate features from the E2E layer whenever possible:
  - Create or update E2E test scripts before or alongside implementation.
  - Re-run E2E tests continuously while developing each Item.
  - Treat Item completion as "code + E2E verification passing" rather than code changes only.
- Keep mocks to the minimum necessary. Prefer real dependencies over mocked layers:
  - For databases (for example PostgreSQL), validate behavior against a real PostgreSQL instance (containerized local environment is preferred), not a mocked DB layer.
  - For middleware and external APIs, call real services (or official sandbox/staging endpoints) during development whenever feasible.
  - If a mock/stub is unavoidable, document why it is required and add at least one E2E path that exercises the real dependency.
- When setting up a development environment, create a local environment that is as close to production as possible. Use Docker as the default approach.
- Commit policy: create exactly one commit per Item (`1 Item = 1 commit`).
