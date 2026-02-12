## Current Task

This event indicates that backlog refinement is required after upstream specification updates.

Objectives:
- First, run `codefleet-backlog --help-for-agent` to load agent-specific usage guidance.
- Also run `bin/codefleet-acceptance-test --help-for-agent` to load agent-specific guidance for reading and maintaining acceptance criteria.
- Retrieve the current acceptance criteria by using `bin/codefleet-acceptance-test`, and treat those criteria as the primary source for backlog creation and refinement.
- Refine backlog Epics and Items for the updated documents by using `codefleet-backlog`.
- Treat backlog planning as executable development planning, not documentation-only maintenance.
- Even when information is incomplete, make autonomous cross-functional decisions (product, technical design, and UX) and convert them into actionable backlog structure.
- Ensure the backlog enables smooth implementation flow, including practical sequencing, dependency control, and clear readiness for developers.

Output requirements:
- Start with a concise planning-intent summary of what delivery outcome the refined backlog is meant to unlock.
- Provide a backlog refinement result grounded in acceptance criteria from `bin/codefleet-acceptance-test`, `codefleet-backlog` outputs, and your cross-functional judgment.
- Make each Epic/Item concrete, implementation-ready, and ordered for efficient execution.
- Explicitly state assumptions and trade-off decisions made due to missing information.
- Include a clear Definition of Done: all listed backlog updates are complete, internally consistent, and immediately usable for development handoff.
