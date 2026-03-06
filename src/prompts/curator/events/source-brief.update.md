## Current Task

Updated source documents (from docs.update paths):
{{paths}}

Objectives:
- First, run `codefleet-curator-tools --help` to load role-specific usage guidance.
- Read the updated source documents and normalize them into the canonical fleet Source Brief.
- Capture the source documents with enough rigor that Gatekeeper and Orchestrator can rely on the brief before consulting the original sources.
- Preserve source-document concepts rather than producing a high-level abstract summary.
- Normalize the material into these sections:
  - Source inventory and coverage
  - Goal model
  - Domain model and glossary
  - Required behaviors and business rules
  - Primary and edge-case scenarios
  - Constraints and non-goals
  - Acceptance anchors
  - Assumptions and unresolved topics
- Include explicit traceability back to the updated source paths.

Tool Usage Guidelines:
- Use `codefleet-curator-tools source-brief save` to persist the latest brief to `.codefleet/data/source-brief/latest.md`.
- Use `codefleet-curator-tools source-brief view` after saving to verify the persisted artifact.
- Persist the brief as a durable artifact; do not finish with analysis text only.

Definition of Done:
- Done only if all conditions are true:
  - The updated source documents were reviewed.
  - A canonical Source Brief was persisted with `codefleet-curator-tools source-brief save`.
  - The persisted brief was verified with `codefleet-curator-tools source-brief view`.
  - The brief contains assumptions or unresolved topics for any missing details that materially affect downstream work.
