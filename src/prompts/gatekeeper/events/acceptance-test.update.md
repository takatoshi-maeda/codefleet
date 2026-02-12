## Current Task

Trigger event: {{triggerEventType}}
Prompt template: {{promptEventType}}.md

Objectives:
- First, run `codefleet-acceptance-test --help-for-agent` to load agent-specific usage guidance.
- Design acceptance tests for the updated documents by using `codefleet-acceptance-test`.
- Treat test planning as requirements definition and write the plan with that level of rigor.
- Even when information is incomplete, make the best autonomous product/technical requirement decisions and convert them into test cases.
- Ensure the plan expresses what users actually need, not only what is easy to validate.

Output requirements:
- Start with a concise intent summary of what the user should be able to achieve when all tests pass.
- Provide an acceptance-test plan generated from `codefleet-acceptance-test` results and your requirement judgments.
- Make each test concrete, verifiable, and implementation-agnostic where possible.
- Explicitly state assumptions you had to decide due to missing information.
- Include a clear Definition of Done: all listed acceptance tests passing means the user-desired outcome is complete.
