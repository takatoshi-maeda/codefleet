import { BuildfleetError } from "../../shared/errors.js";
import type { AcceptanceTestCaseStatus } from "../acceptance-testing-spec-model.js";

const ALLOWED_STATUS_TRANSITIONS: Record<AcceptanceTestCaseStatus, AcceptanceTestCaseStatus[]> = {
  draft: ["ready", "archived"],
  ready: ["in-progress", "archived"],
  "in-progress": ["ready", "archived"],
  archived: [],
};

export function ensureValidStatusTransition(
  from: AcceptanceTestCaseStatus,
  to: AcceptanceTestCaseStatus,
): void {
  if (from === to) {
    return;
  }

  if (!ALLOWED_STATUS_TRANSITIONS[from].includes(to)) {
    throw new BuildfleetError(
      "ERR_VALIDATION",
      `invalid status transition: ${from} -> ${to}`,
    );
  }
}
