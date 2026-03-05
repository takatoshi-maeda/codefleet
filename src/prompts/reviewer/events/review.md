## Current Task

Epic ID to review now: {{epicId}}

Review perspectives (must evaluate all):
1. Epic and related Item behavior works correctly.
2. No unnatural behavior from end-user perspective.
3. No critical issues in application code or architecture that should be fixed before acceptance.

Required workflow:
- First inspect scope and implementation evidence:
  - `codefleet-reviewer-tools --help`
  - `codefleet-reviewer-tools current-context view --epic {{epicId}}`
- Review repository diffs and test evidence for this Epic.
- Produce a strict pass/fail decision with concrete reasons.

Testing policy for review (must follow all):
- Do not perform manual testing. Create and run test scripts for verification.
- For web systems, create and execute Playwright scripts to validate behavior from an E2E perspective.
- For APIs and backend systems, create and execute smoke-test scripts and use their results as verification evidence.
- For UI/UX feedback in web systems, capture screenshots during E2E runs and review those images as visual evidence.
- Treat review scripts as repository assets, not disposable temp files:
  - Place reusable review scripts under `tests/review/` (use Epic-specific file names/directories).
  - Include any created/updated review scripts in commit history as part of the review work.
  - Keep execution artifacts (logs, JSON output, screenshots) in `tmp/logs/review/` and do not treat those artifacts as script sources.

Commit and exit policy (must follow all):
- Do not finish the review run with uncommitted changes.
- Before final output, create a commit that contains all review deliverables generated in this run (e.g., review scripts under `tests/review/`, and any related tracked files intentionally produced for review).
- Do not include execution artifacts under `tmp/logs/review/` in the commit.
- If there are no tracked file changes to commit, explicitly state in the output that no commit was necessary.
- After creating the commit (or confirming no commit was necessary), proceed to the decision action and final output.

Decision actions (must execute one path):
- Pass:
  - `codefleet-reviewer-tools decision pass --epic {{epicId}} --note "<review summary>"`
- Changes requested:
  - Record a detailed rationale that includes: failing behavior, reproducible steps, expected behavior, likely root cause, and concrete fix guidance for the implementer.
  - `codefleet-reviewer-tools decision changes-requested --epic {{epicId}} --rationale "Repro: ... Expected: ... Cause: ... Fix: ..."`

System behavior note:
- After the Reviewer marks `changes-requested`, re-implementation dispatch is handled by the system workflow. Do not manually trigger events.

Output requirements:
- Start with `REVIEW_DECISION: PASS` or `REVIEW_DECISION: CHANGES_REQUESTED`.
- List findings with severity and the user impact.
- If changes are requested, include implementation-level fix guidance.
