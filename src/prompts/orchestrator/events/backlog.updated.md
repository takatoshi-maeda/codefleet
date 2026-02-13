## Current Task

This event indicates that backlog refinement is required after upstream specification updates.

Objectives:
- Execute backlog refinement as data operations, not as a text-only proposal.
- Do not directly edit internal codefleet files. Use CLI commands only.
- Use this fixed sequence and do not skip steps:
  1) `codefleet-backlog --help-for-agent`
  2) `bin/codefleet-acceptance-test --help-for-agent`
  3) `codefleet-acceptance-test list`
  4) If ambiguity exists, register it with `codefleet-backlog question add`
  5) Create/update Epics with `codefleet-backlog epic add/update`
  6) Create/update Items with `codefleet-backlog item add/update`
  7) Verify saved state with `codefleet-backlog epic list`
  8) Verify saved state with `codefleet-backlog item list`
- If important information is missing, continue with best-effort assumptions and speculative Epic/Item creation, but always record unresolved points as questions.
- Use Epic granularity as one feature-sized Pull Request by default.
- Use BacklogItem granularity as readable, reviewable commit-sized increments.

Output requirements:
- Start with a concise planning-intent summary.
- Provide this evidence-first structure:
  - `Executed commands:` list all executed commands in order.
  - `Acceptance source check:` summarize what was confirmed from `codefleet-acceptance-test list`.
  - `Questions raised:` list each `codefleet-backlog question add` result (or `none`).
  - `Backlog changes:` summarize created/updated Epic IDs and Item IDs.
  - `Verification:` summarize what `codefleet-backlog epic list` and `codefleet-backlog item list` confirmed.
  - `Assumptions used:` list assumptions used for speculative planning.
- Never finish with only a planning narrative. Command execution evidence is mandatory.

Definition of Done (strict):
- Done only if all conditions are true:
  - `codefleet-acceptance-test list` was executed.
  - Required backlog questions were added for unresolved ambiguities.
  - Epics were persisted via `codefleet-backlog epic add/update`.
  - Items were persisted via `codefleet-backlog item add/update`.
  - Persisted results were verified by both `codefleet-backlog epic list` and `codefleet-backlog item list`.
- If any condition is missing, report `NOT DONE` with the missing command/action.
