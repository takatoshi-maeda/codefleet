## Current Task

Updated source documents (from docs.update paths):
{{paths}}

Objectives:
- First, run `codefleet-curator-tools --help` to load role-specific usage guidance.
- Read the updated source documents and normalize them into the canonical fleet Source Brief.
- Capture the source documents with enough rigor that Gatekeeper and Orchestrator can rely on the brief before consulting the original sources.
- Preserve source-document concepts rather than producing a high-level abstract summary.
- Normalize the material into exactly these sections:
  - Overview
  - Implementation Constraints
  - Definition of Done
  - Documentation Index
- Do not add any other top-level sections to the Source Brief.
- Use `Implementation Constraints` for implementation-facing rules that downstream roles should preserve, such as design-system requirements, mandated component usage, prohibited implementation patterns, technology constraints, and explicitly allowed exceptions.
- Include explicit traceability back to the updated source paths, especially in Documentation Index.

Tool Usage Guidelines:
- Use `codefleet-curator-tools source-brief save` to persist the latest brief to `.codefleet/data/source-brief/latest.md`.
- Use `codefleet-curator-tools source-brief view` after saving to verify the persisted artifact.
- Persist the brief as a durable artifact; do not finish with analysis text only.

Definition of Done:
- Done only if all conditions are true:
  - The updated source documents were reviewed.
  - A canonical Source Brief was persisted with `codefleet-curator-tools source-brief save`.
  - The persisted brief was verified with `codefleet-curator-tools source-brief view`.
  - The brief contains only Overview, Implementation Constraints, Definition of Done, and Documentation Index as its top-level sections.
