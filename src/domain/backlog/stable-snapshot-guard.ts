import { promises as fs } from "node:fs";
import path from "node:path";
import { CodefleetError } from "../../shared/errors.js";

export async function ensureStableBacklogSnapshot(backlogDir: string): Promise<void> {
  const itemsPath = path.join(backlogDir, "items.json");
  let itemsMtimeMs = 0;
  try {
    const stat = await fs.stat(itemsPath);
    itemsMtimeMs = stat.mtimeMs;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return;
    }
    throw error;
  }

  // A newer items.json than change-log implies an in-flight or interrupted update.
  // We fail closed so consumers do not act on potentially stale planning state.
  const latestChangeLogMtimeMs = await latestChangeLogMtime(backlogDir);
  if (latestChangeLogMtimeMs < itemsMtimeMs) {
    throw new CodefleetError("ERR_BACKLOG_SNAPSHOT_NOT_STABLE", "backlog is being updated; retry later");
  }
}

async function latestChangeLogMtime(backlogDir: string): Promise<number> {
  const changeLogPath = path.join(backlogDir, "change_logs.jsonl");
  try {
    const stat = await fs.stat(changeLogPath);
    return stat.mtimeMs;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}
