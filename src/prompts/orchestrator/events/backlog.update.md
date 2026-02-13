## Current Task

This event indicates that backlog refinement is required after upstream specification updates.

Objectives:
- Persist a high-quality backlog refinement aligned with the latest upstream specification updates.
- Represent planning as saved backlog data (Epics, Items, and Questions), not as a text-only proposal.
- Update the shared requirements text via `codefleet-backlog requirements write` so the latest planning intent is persisted as a single source of truth, based on repository evidence.
- Ensure ambiguity is explicitly captured, assumptions are transparent, and outcomes are verifiable.
- Keep backlog structure implementation-ready:
  - Epics should generally map to one feature-sized Pull Request.
  - Backlog Items should generally map to readable, reviewable commit-sized increments.
- Include technical foundation work when needed (for example CI/test baseline, environment setup, quality gates) by creating Technical Epics/Items.

Tool Usage Guidelines:
- Do not directly edit internal codefleet files. Use CLI commands only.
- Before writing requirements, explore the repository and collect evidence from both documentation and codebase.
- Start by running `codefleet-backlog --help-for-agent` and `codefleet-acceptance-test --help-for-agent` to understand the intended command usage, then choose and execute the necessary commands for exploration, requirements updates, backlog updates, and verification.
- If important information is missing, continue with best-effort assumptions and speculative Epic/Item creation, and always record unresolved points as questions.
- Report format is free. Include enough command evidence and rationale to make actions and outcomes verifiable.
- Never finish with only a planning narrative. Command execution evidence is mandatory.

Definition of Done (strict):
- Done only if all conditions are true:
  - Repository exploration was performed and documented using both docs and codebase evidence.
  - `codefleet-acceptance-test list` was executed.
  - Requirements were updated via `codefleet-backlog requirements write`.
  - Required backlog questions were added for unresolved ambiguities.
  - Epics were persisted via `codefleet-backlog epic add/update`.
  - Items were persisted via `codefleet-backlog item add/update`.
  - Persisted results were verified by both `codefleet-backlog epic list` and `codefleet-backlog item list`.
- If any condition is missing, report `NOT DONE` with the missing command/action.
