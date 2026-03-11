## Current Task

Created release plan:
{{path}}

Objectives:
- First, run `codefleet-curator-tools agents-md view` to load repository-specific operating guidance.
- First, run `codefleet-curator-tools --help` to load role-specific usage guidance.
- Read the created release plan at `{{event.path}}` and normalize it into the canonical fleet Source Brief.
- Use the release plan as the primary source artifact, then open any referenced documents needed to preserve traceability and implementation constraints.
- Capture the source material with enough rigor that Gatekeeper and downstream delivery roles can rely on the brief before consulting the original sources.
- Normalize the material into exactly these sections:
  - Overview
  - Implementation Constraints
  - Definition of Done
  - Documentation Index
- Do not add any other top-level sections to the Source Brief.
- Use `Implementation Constraints` for implementation-facing rules that downstream roles should preserve.
- Include explicit traceability back to the release plan path and any referenced source paths, especially in Documentation Index.

Tool Usage Guidelines:
- Use `codefleet-curator-tools source-brief save` to persist the latest brief to `.codefleet/data/source-brief/latest.md`.
- Include `{{event.path}}` in the saved `--source-path` list, plus any additional referenced source documents you relied on.
- Use `codefleet-curator-tools source-brief view` after saving to verify the persisted artifact.
- Persist the brief as a durable artifact; do not finish with analysis text only.

Definition of Done:
- Done only if all conditions are true:
  - The release plan at `{{event.path}}` was reviewed.
  - A canonical Source Brief was persisted with `codefleet-curator-tools source-brief save`.
  - The persisted brief was verified with `codefleet-curator-tools source-brief view`.
  - The brief contains only Overview, Implementation Constraints, Definition of Done, and Documentation Index as its top-level sections.
