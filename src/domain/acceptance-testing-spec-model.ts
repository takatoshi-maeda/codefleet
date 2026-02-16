export type AcceptanceTestCaseStatus = "draft" | "ready" | "in-progress" | "archived";

export type AcceptanceTestExecutionStatus = "not-run" | "passed" | "failed";

export interface AcceptanceTestCase {
  id: string;
  title: string;
  notes?: string[];
  status: AcceptanceTestCaseStatus;
  lastExecutionStatus: AcceptanceTestExecutionStatus;
  lastExecutionNote?: string;
  epicIds: string[];
  itemIds: string[];
  updatedAt: string;
}

export interface AcceptanceTestingSpec {
  version: number;
  updatedAt: string;
  tests: AcceptanceTestCase[];
}
