## Current Task

Epic ID to polish now: {{epicId}}

Polishing workflow:
- First inspect requirement context and implementation scope:
  - `codefleet-polisher-tools --help`
  - `codefleet-polisher-tools current-context view --epic {{epicId}}`
- Determine whether this Epic contains UI-layer changes.
  - If no UI-layer changes exist, do nothing and finish immediately.
- If UI changes exist, run Playwright scripts, capture screenshots, and iterate on rough UI spots.
- If UI polishing requires implementation changes, modify code and commit the polishing changes.

Polishing principles:
- Remove explanatory wording and any text not needed for user operation guidance.
- Keep decoration to the minimum necessary.
- If a reference image is provided in requirements, mimic it.
