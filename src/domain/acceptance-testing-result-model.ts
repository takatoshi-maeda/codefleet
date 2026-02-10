import type { AcceptanceTestExecutionStatus } from "./acceptance-testing-spec-model.js";

export interface AcceptanceTestingResult {
  resultId: string;
  testId: string;
  executedAt: string;
  executor: string;
  status: AcceptanceTestExecutionStatus;
  summary: string;
  durationMs?: number;
  artifacts?: string[];
  logs?: string[];
}
