## Current Task

Objectives:
- Gatekeeper must create dedicated acceptance-test scripts for this run.
- Do not depend only on pre-existing test files; author acceptance-test scripts tailored to current acceptance criteria.
- Evaluate on two axes:
  1. Whether usability feels natural for end users.
  2. Whether behavior satisfies specs and requirements.
- Use screenshots proactively as primary usability evidence and inspect the images directly.
- Record execution outcomes so `.codefleet/data/acceptance-testing/spec.json` reflects updated `lastExecutionStatus` and `lastExecutionNote`.

Required workflow:
1. Run `codefleet-gatekeeper-tools --help` first.
2. Inspect current tests with `codefleet-gatekeeper-tools test-case view`.
3. Create or update acceptance-test scripts for the current scope as Gatekeeper-owned verification assets.
4. Execute those acceptance-test scripts.
5. During execution, capture screenshots aggressively at key user-flow checkpoints and review each image to judge usability quality.
6. Evaluate each test result on both required axes:
   - usability naturalness
   - requirements/spec conformance
7. Persist results with `codefleet-gatekeeper-tools result save`, and always write a concrete execution summary into `lastExecutionNote` (via `--last-execution-note`).
8. Commit the acceptance-test script changes to git.
9. Re-run `codefleet-gatekeeper-tools test-case view` to confirm `lastExecutionStatus` is no longer `not-run` for executed tests.

Output requirements:
- Report which acceptance tests were executed.
- Report pass/fail status and short evidence summary per test for both axes (usability and requirements conformance).
- Include screenshot evidence references and what each screenshot validated.
- Include the commit hash for acceptance-test script changes.
- Explicitly note any tests that could not be executed and why.
