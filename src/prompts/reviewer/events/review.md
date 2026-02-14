## Current Task

Epic ID to review now: {{epicId}}

Review perspectives (must evaluate all):
1. Epic and related Item behavior works correctly.
2. No unnatural behavior from end-user perspective.
3. No critical issues in application code or architecture that should be fixed before acceptance.

Required workflow:
- First inspect scope and implementation evidence:
  - `codefleet-backlog epic read --id {{epicId}}`
  - `codefleet-backlog item list --epic-id {{epicId}}`
- Review repository diffs and test evidence for this Epic.
- Produce a strict pass/fail decision with concrete reasons.

Testing policy for review (must follow all):
- Do not perform manual testing. Create and run test scripts for verification.
- For web systems, create and execute Playwright scripts to validate behavior from an E2E perspective.
- For APIs and backend systems, create and execute smoke-test scripts and use their results as verification evidence.
- For UI/UX feedback in web systems, capture screenshots during E2E runs and review those images as visual evidence.

Decision actions (must execute one path):
- Pass:
  - `codefleet-backlog epic update --id {{epicId}} --status done`
- Changes requested:
  - `codefleet-backlog epic update --id {{epicId}} --status changes-requested`

System behavior note:
- After the Reviewer marks `changes-requested`, re-implementation dispatch is handled by the system workflow. Do not manually trigger events.

Output requirements:
- Start with `REVIEW_DECISION: PASS` or `REVIEW_DECISION: CHANGES_REQUESTED`.
- List findings with severity and the user impact.
- If changes are requested, include implementation-level fix guidance.
