import { promises as fs } from "node:fs";
import path from "node:path";
import { JsonRepository } from "../../infra/fs/json-repository.js";
import { CodefleetError } from "../../shared/errors.js";
import { createUlid } from "../../shared/ulid.js";
import { SCHEMA_PATHS } from "../schema-paths.js";
import type {
  AcceptanceTestCase,
  AcceptanceTestCaseStatus,
  AcceptanceTestExecutionStatus,
  AcceptanceTestingSpec,
} from "../acceptance-testing-spec-model.js";
import type { AcceptanceTestingResult } from "../acceptance-testing-result-model.js";
import type { BacklogNote } from "../backlog-items-model.js";
import { ensureValidStatusTransition } from "./status-transition.js";

const ACCEPTANCE_DATA_DIR = ".codefleet/data/acceptance-testing";

interface AddAcceptanceTestInput {
  title: string;
  notes?: string[];
  status?: AcceptanceTestCaseStatus;
  epicIds: string[];
  itemIds: string[];
}

interface UpdateAcceptanceTestInput {
  id: string;
  title?: string;
  addNotes?: string[];
  removeNotes?: string[];
  status?: AcceptanceTestCaseStatus;
  lastExecutionNote?: string;
  epicIds?: string[];
  itemIds?: string[];
}

interface AddAcceptanceResultInput {
  testId: string;
  status: AcceptanceTestExecutionStatus;
  summary: string;
  lastExecutionNote?: string;
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
    // list() intentionally returns cached spec state as-is. Manual bulk updates
    // must remain visible without being overwritten by an implicit heal pass.
    const spec = await this.getOrInitializeSpec();
    return spec.tests;
  }

  async add(input: AddAcceptanceTestInput): Promise<AcceptanceTestCase> {
    const spec = await this.getOrInitializeSpec();
    const now = new Date().toISOString();
    const testCase: AcceptanceTestCase = {
      id: this.nextTestId(spec.tests),
      title: input.title,
      notes: buildNotes([], input.notes, now),
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
      throw new CodefleetError("ERR_NOT_FOUND", `acceptance test not found: ${input.id}`);
    }

    if (input.status) {
      ensureValidStatusTransition(found.status, input.status);
      found.status = input.status;
    }

    if (input.title !== undefined) {
      found.title = input.title;
    }

    if (input.addNotes || input.removeNotes) {
      // Notes are deduplicated by content so repeated CLI operations stay deterministic.
      found.notes = updateNotes(found.notes ?? [], input.addNotes, input.removeNotes);
    }

    if (input.epicIds) {
      found.epicIds = unique(input.epicIds);
    }

    if (input.itemIds) {
      found.itemIds = unique(input.itemIds);
    }

    if (input.lastExecutionNote !== undefined) {
      found.lastExecutionNote = input.lastExecutionNote;
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
      throw new CodefleetError("ERR_NOT_FOUND", `acceptance test not found: ${id}`);
    }

    spec.tests.splice(index, 1);
    spec.updatedAt = new Date().toISOString();
    await this.specRepository.save(spec);
  }

  async addResult(input: AddAcceptanceResultInput): Promise<AcceptanceTestingResult> {
    const spec = await this.getOrInitializeSpec();
    const target = spec.tests.find((test) => test.id === input.testId);
    if (!target) {
      throw new CodefleetError("ERR_NOT_FOUND", `acceptance test not found: ${input.testId}`);
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

    // Persist result first by design: docs define results as source of truth and spec as cache.
    // This order guarantees we never publish a cache status that has no backing result file.
    await resultRepository.save(result);

    target.lastExecutionStatus = result.status;
    // Keep the cache-level execution note aligned with the latest persisted result context.
    target.lastExecutionNote = input.lastExecutionNote ?? input.summary;
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

  async clearAllData(): Promise<void> {
    // Deleting the whole acceptance-testing directory guarantees spec cache and
    // results history are reset together without leaving partial state behind.
    await fs.rm(this.dataDir, { recursive: true, force: true });
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
      const nextNote = latest?.note;
      if (test.lastExecutionNote !== nextNote) {
        changed = true;
        test.lastExecutionNote = nextNote;
        test.updatedAt = new Date().toISOString();
      }
    }

    if (changed) {
      spec.updatedAt = new Date().toISOString();
      await this.specRepository.save(spec);
    }
  }

  async updateLastExecutionStatusAll(status: AcceptanceTestExecutionStatus, lastExecutionNote?: string): Promise<void> {
    const spec = await this.getOrInitializeSpec();
    const now = new Date().toISOString();
    let changed = false;

    for (const test of spec.tests) {
      if (test.lastExecutionStatus !== status) {
        changed = true;
        test.lastExecutionStatus = status;
        test.updatedAt = now;
      }
      if (lastExecutionNote !== undefined && test.lastExecutionNote !== lastExecutionNote) {
        changed = true;
        test.lastExecutionNote = lastExecutionNote;
        test.updatedAt = now;
      }
    }

    if (!changed) {
      return;
    }
    spec.updatedAt = now;
    await this.specRepository.save(spec);
  }

  private async getOrInitializeSpec(): Promise<AcceptanceTestingSpec> {
    try {
      const loaded = await this.specRepository.get();
      const normalized = normalizeAcceptanceTestingSpec(loaded);
      if (normalized !== loaded) {
        await this.specRepository.save(normalized);
      }
      return normalized;
    } catch (error) {
      if (error instanceof CodefleetError && error.code === "ERR_NOT_FOUND") {
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

  private async latestResultStatuses(): Promise<Map<string, {
    status: AcceptanceTestExecutionStatus;
    executedAt: string;
    note: string;
  }>> {
    const files = await this.resultFiles();
    const latest = new Map<string, { status: AcceptanceTestExecutionStatus; executedAt: string; note: string }>();

    for (const file of files) {
      const fullPath = path.join(this.resultsDir, file);
      const repository = new JsonRepository<AcceptanceTestingResult>(
        fullPath,
        SCHEMA_PATHS.acceptanceTestingResult,
      );
      const result = await repository.get();

      const existing = latest.get(result.testId);
      // `executedAt` is ISO8601 UTC, so lexical comparison is stable and cheaper than Date parse.
      if (!existing || result.executedAt > existing.executedAt) {
        latest.set(result.testId, { status: result.status, executedAt: result.executedAt, note: result.summary });
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

function normalizeAcceptanceTestingSpec(spec: AcceptanceTestingSpec): AcceptanceTestingSpec {
  let changed = false;
  const tests = spec.tests.map((test) => {
    const normalizedNotes = normalizeNotes(test.notes, test.updatedAt);
    if (normalizedNotes === test.notes) {
      return test;
    }
    changed = true;
    return { ...test, notes: normalizedNotes };
  });

  return changed ? { ...spec, tests } : spec;
}

function normalizeNotes(
  notes: ReadonlyArray<BacklogNote | string> | undefined,
  fallbackCreatedAt: string,
): BacklogNote[] | undefined {
  if (!notes) {
    return undefined;
  }
  if (notes.length === 0) {
    return [];
  }

  let changed = false;
  const normalized = notes
    .map((note, index) => {
      if (typeof note === "string") {
        changed = true;
        return {
          id: `legacy-note-${index + 1}`,
          content: note,
          createdAt: fallbackCreatedAt,
        } satisfies BacklogNote;
      }
      return note;
    })
    .filter((note) => note.content.trim().length > 0);

  return changed ? normalized : (notes as BacklogNote[]);
}

function buildNotes(
  existing: ReadonlyArray<BacklogNote | string>,
  addedContents: ReadonlyArray<string> | undefined,
  createdAt: string,
): BacklogNote[] {
  const normalizedExisting = normalizeNotes(existing, createdAt) ?? [];
  if (!addedContents || addedContents.length === 0) {
    return normalizedExisting;
  }

  const known = new Set(normalizedExisting.map((note) => note.content));
  const added = addedContents
    .map((content) => content.trim())
    .filter((content) => content.length > 0 && !known.has(content))
    .map((content) => {
      known.add(content);
      return {
        id: createUlid(),
        content,
        createdAt,
      } satisfies BacklogNote;
    });

  return [...normalizedExisting, ...added];
}

function updateNotes(
  existing: ReadonlyArray<BacklogNote | string>,
  addNotes: ReadonlyArray<string> | undefined,
  removeNotes: ReadonlyArray<string> | undefined,
): BacklogNote[] {
  const now = new Date().toISOString();
  const removeSet = new Set((removeNotes ?? []).map((note) => note.trim()).filter((note) => note.length > 0));
  const retained = (normalizeNotes(existing, now) ?? []).filter((note) => !removeSet.has(note.content));
  return buildNotes(retained, addNotes, now);
}
