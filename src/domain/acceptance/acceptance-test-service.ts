import { promises as fs } from "node:fs";
import path from "node:path";
import { JsonRepository } from "../../infra/fs/json-repository.js";
import { BuildfleetError } from "../../shared/errors.js";
import { SCHEMA_PATHS } from "../schema-paths.js";
import type {
  AcceptanceTestCase,
  AcceptanceTestCaseStatus,
  AcceptanceTestExecutionStatus,
  AcceptanceTestingSpec,
} from "../acceptance-testing-spec-model.js";
import type { AcceptanceTestingResult } from "../acceptance-testing-result-model.js";
import { ensureValidStatusTransition } from "./status-transition.js";

const ACCEPTANCE_DATA_DIR = ".buildfleet/data/acceptance-testing";

interface AddAcceptanceTestInput {
  title: string;
  status?: AcceptanceTestCaseStatus;
  epicIds: string[];
  itemIds: string[];
}

interface UpdateAcceptanceTestInput {
  id: string;
  title?: string;
  status?: AcceptanceTestCaseStatus;
  epicIds?: string[];
  itemIds?: string[];
}

interface AddAcceptanceResultInput {
  testId: string;
  status: AcceptanceTestExecutionStatus;
  summary: string;
  executor: string;
  durationMs?: number;
  artifacts: string[];
  logs: string[];
}

export class AcceptanceTestService {
  private readonly dataDir: string;
  private readonly resultsDir: string;
  private readonly specRepository: JsonRepository<AcceptanceTestingSpec>;

  constructor(dataDir: string = ACCEPTANCE_DATA_DIR) {
    this.dataDir = dataDir;
    this.resultsDir = path.join(dataDir, "results");
    this.specRepository = new JsonRepository<AcceptanceTestingSpec>(
      path.join(this.dataDir, "spec.json"),
      SCHEMA_PATHS.acceptanceTestingSpec,
    );
  }

  async list(): Promise<AcceptanceTestCase[]> {
    await this.selfHealLastExecutionStatus();
    const spec = await this.getOrInitializeSpec();
    return spec.tests;
  }

  async add(input: AddAcceptanceTestInput): Promise<AcceptanceTestCase> {
    const spec = await this.getOrInitializeSpec();
    const now = new Date().toISOString();
    const testCase: AcceptanceTestCase = {
      id: this.nextTestId(spec.tests),
      title: input.title,
      status: input.status ?? "draft",
      lastExecutionStatus: "not-run",
      epicIds: unique(input.epicIds),
      itemIds: unique(input.itemIds),
      updatedAt: now,
    };

    spec.tests.push(testCase);
    spec.updatedAt = now;

    await this.specRepository.save(spec);
    return testCase;
  }

  async update(input: UpdateAcceptanceTestInput): Promise<AcceptanceTestCase> {
    const spec = await this.getOrInitializeSpec();
    const found = spec.tests.find((test) => test.id === input.id);
    if (!found) {
      throw new BuildfleetError("ERR_NOT_FOUND", `acceptance test not found: ${input.id}`);
    }

    if (input.status) {
      ensureValidStatusTransition(found.status, input.status);
      found.status = input.status;
    }

    if (input.title !== undefined) {
      found.title = input.title;
    }

    if (input.epicIds) {
      found.epicIds = unique(input.epicIds);
    }

    if (input.itemIds) {
      found.itemIds = unique(input.itemIds);
    }

    const now = new Date().toISOString();
    found.updatedAt = now;
    spec.updatedAt = now;

    await this.specRepository.save(spec);
    return found;
  }

  async delete(id: string): Promise<void> {
    const spec = await this.getOrInitializeSpec();
    const index = spec.tests.findIndex((test) => test.id === id);
    if (index === -1) {
      throw new BuildfleetError("ERR_NOT_FOUND", `acceptance test not found: ${id}`);
    }

    spec.tests.splice(index, 1);
    spec.updatedAt = new Date().toISOString();
    await this.specRepository.save(spec);
  }

  async addResult(input: AddAcceptanceResultInput): Promise<AcceptanceTestingResult> {
    const spec = await this.getOrInitializeSpec();
    const target = spec.tests.find((test) => test.id === input.testId);
    if (!target) {
      throw new BuildfleetError("ERR_NOT_FOUND", `acceptance test not found: ${input.testId}`);
    }

    const now = new Date();
    const result: AcceptanceTestingResult = {
      resultId: await this.nextResultId(now),
      testId: input.testId,
      executedAt: now.toISOString(),
      executor: input.executor,
      status: input.status,
      summary: input.summary,
      durationMs: input.durationMs,
      artifacts: input.artifacts.length > 0 ? input.artifacts : undefined,
      logs: input.logs.length > 0 ? input.logs : undefined,
    };

    const resultPath = path.join(this.resultsDir, `${result.resultId}.json`);
    const resultRepository = new JsonRepository<AcceptanceTestingResult>(
      resultPath,
      SCHEMA_PATHS.acceptanceTestingResult,
    );

    await resultRepository.save(result);

    target.lastExecutionStatus = result.status;
    const isoNow = now.toISOString();
    target.updatedAt = isoNow;
    spec.updatedAt = isoNow;

    try {
      await this.specRepository.save(spec);
    } catch (error) {
      await this.selfHealLastExecutionStatus();
      throw error;
    }

    return result;
  }

  async selfHealLastExecutionStatus(): Promise<void> {
    const spec = await this.getOrInitializeSpec();
    const latestStatusByTestId = await this.latestResultStatuses();

    let changed = false;
    for (const test of spec.tests) {
      const latest = latestStatusByTestId.get(test.id);
      const newStatus = latest?.status ?? "not-run";
      if (test.lastExecutionStatus !== newStatus) {
        changed = true;
        test.lastExecutionStatus = newStatus;
        test.updatedAt = new Date().toISOString();
      }
    }

    if (changed) {
      spec.updatedAt = new Date().toISOString();
      await this.specRepository.save(spec);
    }
  }

  private async getOrInitializeSpec(): Promise<AcceptanceTestingSpec> {
    try {
      return await this.specRepository.get();
    } catch (error) {
      if (error instanceof BuildfleetError && error.code === "ERR_NOT_FOUND") {
        const now = new Date().toISOString();
        const initial: AcceptanceTestingSpec = {
          version: 1,
          updatedAt: now,
          tests: [],
        };
        await this.specRepository.save(initial);
        return initial;
      }

      throw error;
    }
  }

  private nextTestId(tests: AcceptanceTestCase[]): string {
    const maxSequence = tests.reduce((max, test) => {
      const matched = /^AT-(\d+)$/.exec(test.id);
      if (!matched) {
        return max;
      }
      return Math.max(max, Number(matched[1]));
    }, 0);

    return `AT-${String(maxSequence + 1).padStart(3, "0")}`;
  }

  private async nextResultId(now: Date): Promise<string> {
    const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(
      now.getUTCDate(),
    ).padStart(2, "0")}`;

    const files = await this.resultFiles();
    const prefix = `ATR-${stamp}-`;
    const maxSequence = files.reduce((max, file) => {
      const name = path.basename(file, ".json");
      if (!name.startsWith(prefix)) {
        return max;
      }
      const sequence = Number(name.slice(prefix.length));
      return Number.isNaN(sequence) ? max : Math.max(max, sequence);
    }, 0);

    return `${prefix}${String(maxSequence + 1).padStart(3, "0")}`;
  }

  private async latestResultStatuses(): Promise<Map<string, { status: AcceptanceTestExecutionStatus; executedAt: string }>> {
    const files = await this.resultFiles();
    const latest = new Map<string, { status: AcceptanceTestExecutionStatus; executedAt: string }>();

    for (const file of files) {
      const fullPath = path.join(this.resultsDir, file);
      const repository = new JsonRepository<AcceptanceTestingResult>(
        fullPath,
        SCHEMA_PATHS.acceptanceTestingResult,
      );
      const result = await repository.get();

      const existing = latest.get(result.testId);
      if (!existing || result.executedAt > existing.executedAt) {
        latest.set(result.testId, { status: result.status, executedAt: result.executedAt });
      }
    }

    return latest;
  }

  private async resultFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.resultsDir);
      return files.filter((file) => file.endsWith(".json"));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
