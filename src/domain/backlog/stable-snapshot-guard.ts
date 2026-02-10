import { promises as fs } from "node:fs";
import path from "node:path";
import { BuildfleetError } from "../../shared/errors.js";

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

  const latestChangeLogMtimeMs = await latestChangeLogMtime(backlogDir);
  if (latestChangeLogMtimeMs < itemsMtimeMs) {
    throw new BuildfleetError("ERR_BACKLOG_SNAPSHOT_NOT_STABLE", "backlog is being updated; retry later");
  }
}

async function latestChangeLogMtime(backlogDir: string): Promise<number> {
  const changeLogDir = path.join(backlogDir, "change-logs");
  let files: string[] = [];
  try {
    files = await fs.readdir(changeLogDir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let latest = 0;
  for (const file of files) {
    if (!file.endsWith(".md")) {
      continue;
    }
    const stat = await fs.stat(path.join(changeLogDir, file));
    latest = Math.max(latest, stat.mtimeMs);
  }

  return latest;
}
