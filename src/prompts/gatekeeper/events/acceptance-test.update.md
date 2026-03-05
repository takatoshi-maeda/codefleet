## Current Task

Reference documents (from docs.update paths):
{{paths}}

Objectives:
- First, run `codefleet-gatekeeper-tools --help` to load role-specific usage guidance.
- Design acceptance tests for the updated documents by using `codefleet-gatekeeper-tools` (`test-case view` / `test-case upsert`).
- Treat test planning as requirements definition and write the plan with that level of rigor.
- Even when information is incomplete, make the best autonomous product/technical requirement decisions and convert them into test cases.
- Ensure the plan expresses what users actually need, not only what is easy to validate.

Output requirements:
- Start with a concise intent summary of what the user should be able to achieve when all tests pass.
- Provide an acceptance-test plan generated from `codefleet-gatekeeper-tools` results and your requirement judgments.
- Make each test concrete, verifiable, and implementation-agnostic where possible.
- Explicitly state assumptions you had to decide due to missing information.
- Include a clear Definition of Done: all listed acceptance tests passing means the user-desired outcome is complete.
