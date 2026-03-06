## Current Task

Primary source brief:
{{briefPath}}

Source documents represented by the brief:
{{sourcePaths}}

Objectives:
- First, run `codefleet-gatekeeper-tools --help` to load role-specific usage guidance.
- Read `.codefleet/data/source-brief/latest.md` first and use it as the primary source of normalized intent.
- Use the original source documents only when the brief indicates ambiguity or missing detail.
- Identify the user/business goals described in the source brief.
- Define the completion requirements and acceptance requirements needed to achieve those goals.
- Design acceptance tests that validate goal achievement through product behavior and user-observable outcomes by using `codefleet-gatekeeper-tools` (`test-case view` / `test-case upsert`).
- Treat test planning as requirements definition and write the plan with that level of rigor.
- Even when information is incomplete, make the best autonomous product/technical requirement decisions and convert them into test cases.
- Ensure the plan expresses what users actually need, not only what is easy to validate.
- Avoid document-format or document-completeness checks unless the stated goal explicitly requires a documentation artifact.

Output requirements:
- Start with a concise intent summary of the goals that users should be able to achieve when all tests pass.
- Provide completion requirements and an acceptance-test plan generated from `codefleet-gatekeeper-tools` results and your requirement judgments.
- Make each test concrete, verifiable, and implementation-agnostic where possible.
- For each completion requirement and acceptance test, include traceability to the source goal(s) in the reference documents.
- Explicitly state assumptions you had to decide due to missing information.
- Include a clear Definition of Done: all listed completion requirements are satisfied and all listed acceptance tests pass, meaning the user-desired goals are complete.
