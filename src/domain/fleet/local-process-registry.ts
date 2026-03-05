import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson } from "../../infra/fs/atomic-write.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

export interface LocalProcessRegistryEntry {
  instanceId: string;
  pid: number;
  projectId: string;
  host: string;
  port: number;
  startedAt: string;
  lastHeartbeat: string;
}

interface LocalProcessRegistryOptions {
  registryDir?: string;
  cwd?: string;
  processId?: number;
  heartbeatTimeoutMs?: number;
  resolveProjectId?: () => Promise<string>;
  isProcessAlive?: (pid: number) => boolean;
}

export class LocalProcessRegistry {
  private readonly registryDir: string;
  private readonly cwd: string;
  private readonly processId: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly resolveProjectIdFn: () => Promise<string>;
  private readonly isProcessAliveFn: (pid: number) => boolean;
  private currentEntry: LocalProcessRegistryEntry | null = null;

  constructor(options: LocalProcessRegistryOptions = {}) {
    this.registryDir = options.registryDir ?? resolveDefaultRegistryDir();
    this.cwd = options.cwd ?? process.cwd();
    this.processId = options.processId ?? process.pid;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.resolveProjectIdFn = options.resolveProjectId ?? (() => resolveProjectIdFromGitRemote(this.cwd));
    this.isProcessAliveFn = options.isProcessAlive ?? isProcessAlive;
  }

  async register(input: { host: string; port: number; startedAt: string }): Promise<LocalProcessRegistryEntry> {
    const projectId = await this.resolveProjectIdFn();
    const now = new Date().toISOString();
    const entry: LocalProcessRegistryEntry = {
      instanceId: `cf_${randomUUID()}`,
      pid: this.processId,
      projectId,
      host: input.host,
      port: input.port,
      startedAt: input.startedAt,
      lastHeartbeat: now,
    };
    await this.writeEntry(entry);
    this.currentEntry = entry;
    return entry;
  }

  async heartbeat(): Promise<void> {
    if (!this.currentEntry) {
      return;
    }
    const next: LocalProcessRegistryEntry = {
      ...this.currentEntry,
      lastHeartbeat: new Date().toISOString(),
    };
    await this.writeEntry(next);
    this.currentEntry = next;
  }

  async unregister(): Promise<void> {
    const filePath = path.join(this.registryDir, `${this.processId}.json`);
    this.currentEntry = null;
    await fs.rm(filePath, { force: true });
  }

  async discover(): Promise<LocalProcessRegistryEntry[]> {
    const projectId = this.currentEntry?.projectId ?? (await this.resolveProjectIdFn());
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.registryDir);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const now = Date.now();
    const discovered: LocalProcessRegistryEntry[] = [];
    for (const fileName of entries) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.registryDir, fileName);
      const parsed = await this.readEntryFile(filePath);
      if (!parsed) {
        continue;
      }
      const stale = isStaleEntry(parsed, now, this.heartbeatTimeoutMs, this.isProcessAliveFn);
      if (stale) {
        await safeRemove(filePath);
        continue;
      }
      // Discovery is project-scoped to prevent unrelated workspaces on the same
      // machine from being treated as a single fleet cluster.
      if (parsed.projectId !== projectId || parsed.pid === this.processId) {
        continue;
      }
      discovered.push(parsed);
    }
    discovered.sort((left, right) => left.pid - right.pid);
    return discovered;
  }

  private async writeEntry(entry: LocalProcessRegistryEntry): Promise<void> {
    await fs.mkdir(this.registryDir, { recursive: true, mode: 0o700 });
    await atomicWriteJson(path.join(this.registryDir, `${this.processId}.json`), entry);
  }

  private async readEntryFile(filePath: string): Promise<LocalProcessRegistryEntry | null> {
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parseLocalProcessRegistryEntry(parsed);
    } catch {
      await safeRemove(filePath);
      return null;
    }
  }
}

export function extractProjectIdFromGitRemote(remoteUrl: string): string | null {
  const normalized = remoteUrl.trim();
  if (normalized.length === 0) {
    return null;
  }
  const sshLikeMatch = /^([^@/:]+)@[^:]+:([^/]+)\/(.+)$/u.exec(normalized);
  if (sshLikeMatch) {
    const userName = sshLikeMatch[2];
    const repoName = stripGitSuffix(sshLikeMatch[3]);
    return buildProjectId(userName, repoName);
  }

  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length < 2) {
      return null;
    }
    const userName = segments[segments.length - 2] ?? "";
    const repoName = stripGitSuffix(segments[segments.length - 1] ?? "");
    return buildProjectId(userName, repoName);
  } catch {
    return null;
  }
}

export async function resolveProjectIdFromGitRemote(cwd: string = process.cwd()): Promise<string> {
  const fallback = path.basename(path.resolve(cwd));
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
    });
    const projectId = extractProjectIdFromGitRemote(stdout);
    if (projectId) {
      return projectId;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function parseLocalProcessRegistryEntry(value: unknown): LocalProcessRegistryEntry {
  if (!value || typeof value !== "object") {
    throw new Error("invalid registry entry");
  }
  const record = value as Record<string, unknown>;
  const instanceId = asNonEmptyString(record.instanceId, "instanceId");
  const pid = asNumber(record.pid, "pid");
  const projectId = asNonEmptyString(record.projectId, "projectId");
  const host = asNonEmptyString(record.host, "host");
  const port = asNumber(record.port, "port");
  const startedAt = asNonEmptyString(record.startedAt, "startedAt");
  const lastHeartbeat = asNonEmptyString(record.lastHeartbeat, "lastHeartbeat");
  return {
    instanceId,
    pid,
    projectId,
    host,
    port,
    startedAt,
    lastHeartbeat,
  };
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`invalid ${field}`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return normalized;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function isStaleEntry(
  entry: LocalProcessRegistryEntry,
  nowMs: number,
  heartbeatTimeoutMs: number,
  checkProcessAlive: (pid: number) => boolean,
): boolean {
  const heartbeatMs = Date.parse(entry.lastHeartbeat);
  if (!Number.isFinite(heartbeatMs)) {
    return true;
  }
  if (nowMs - heartbeatMs > heartbeatTimeoutMs) {
    return true;
  }
  return !checkProcessAlive(entry.pid);
}

function buildProjectId(userName: string, repoName: string): string | null {
  const normalizedUser = userName.trim();
  const normalizedRepo = repoName.trim();
  if (normalizedUser.length === 0 || normalizedRepo.length === 0) {
    return null;
  }
  return `${normalizedUser}/${normalizedRepo}`;
}

function stripGitSuffix(repoName: string): string {
  return repoName.replace(/\.git$/u, "");
}

function resolveDefaultRegistryDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome && xdgStateHome.length > 0) {
    return path.join(xdgStateHome, "codefleet", "registry");
  }
  return path.join(os.homedir(), ".local", "state", "codefleet", "registry");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

async function safeRemove(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Best-effort GC: concurrent writers/readers can race on file lifecycle.
  }
}
