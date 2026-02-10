import { BuildfleetError } from "../../shared/errors.js";
import type { AcceptanceTestingSpec } from "../acceptance-testing-spec-model.js";

export function ensureAcceptanceTestIdsExist(
  acceptanceTestIds: string[],
  spec: AcceptanceTestingSpec,
): void {
  const availableIds = new Set(spec.tests.map((test) => test.id));
  const missing = acceptanceTestIds.filter((id) => !availableIds.has(id));
  if (missing.length > 0) {
    throw new BuildfleetError("ERR_VALIDATION", `acceptance tests not found: ${missing.join(", ")}`);
  }
}
