import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRole } from "../roles-model.js";

export type FleetExecutionStatus = "running" | "success" | "failed";

export interface FleetExecutionRecord {
  executionId: string;
  agentId: string;
  role: AgentRole;
  eventType: string;
  epicId?: string;
  queuedAt?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: FleetExecutionStatus;
  error?: {
    code?: string;
    message: string;
  };
}

export interface FleetExecutionQueryInput {
  role?: AgentRole;
  status?: FleetExecutionStatus;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface FleetExecutionQueryResult {
  executions: FleetExecutionRecord[];
  nextCursor?: string;
}

const DEFAULT_EXECUTION_LOG_PATH = path.join(".codefleet", "runtime", "fleet", "executions.jsonl");
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface DecodedCursor {
  startedAt: string;
  executionId: string;
}

export class FleetExecutionLog {
  constructor(private readonly filePath: string = DEFAULT_EXECUTION_LOG_PATH) {}

  async append(record: FleetExecutionRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async list(input: FleetExecutionQueryInput = {}): Promise<FleetExecutionQueryResult> {
    const allRecords = await this.readLatestRecords();
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const limit = clampLimit(input.limit);

    const filtered = allRecords
      .filter((record) => (input.role ? record.role === input.role : true))
      .filter((record) => (input.status ? record.status === input.status : true))
      .filter((record) => (input.from ? record.startedAt >= input.from : true))
      .filter((record) => (input.to ? record.startedAt <= input.to : true))
      .sort(compareExecutionRecordDesc)
      .filter((record) => (cursor ? isBeforeCursor(record, cursor) : true));

    const executions = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    const last = executions[executions.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last) : undefined;
    return { executions, ...(nextCursor ? { nextCursor } : {}) };
  }

  private async readLatestRecords(): Promise<FleetExecutionRecord[]> {
    const lines = await readJsonlLines(this.filePath);
    const latestByExecutionId = new Map<string, FleetExecutionRecord>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        const record = parseExecutionRecord(parsed);
        latestByExecutionId.set(record.executionId, record);
      } catch {
        // Ignore malformed lines to keep append-only log query resilient.
      }
    }
    return [...latestByExecutionId.values()];
  }
}

function compareExecutionRecordDesc(left: FleetExecutionRecord, right: FleetExecutionRecord): number {
  if (left.startedAt !== right.startedAt) {
    return right.startedAt.localeCompare(left.startedAt);
  }
  return right.executionId.localeCompare(left.executionId);
}

function isBeforeCursor(record: FleetExecutionRecord, cursor: DecodedCursor): boolean {
  if (record.startedAt !== cursor.startedAt) {
    return record.startedAt < cursor.startedAt;
  }
  return record.executionId < cursor.executionId;
}

function parseExecutionRecord(value: unknown): FleetExecutionRecord {
  if (!value || typeof value !== "object") {
    throw new Error("invalid record");
  }
  const record = value as Partial<FleetExecutionRecord>;
  if (
    typeof record.executionId !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.role !== "string" ||
    typeof record.eventType !== "string" ||
    typeof record.startedAt !== "string" ||
    (record.status !== "running" && record.status !== "success" && record.status !== "failed")
  ) {
    throw new Error("invalid record");
  }
  return record as FleetExecutionRecord;
}

async function readJsonlLines(filePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function clampLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(value ?? DEFAULT_LIMIT, MAX_LIMIT);
}

function encodeCursor(record: Pick<FleetExecutionRecord, "startedAt" | "executionId">): string {
  return Buffer.from(`${record.startedAt}|${record.executionId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): DecodedCursor {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator <= 0 || separator >= decoded.length - 1) {
    throw new Error("invalid cursor");
  }
  return {
    startedAt: decoded.slice(0, separator),
    executionId: decoded.slice(separator + 1),
  };
}
