import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recoverStaleQueueProcessingFiles } from "../src/cli/commands/fleetctl.js";

describe("recoverStaleQueueProcessingFiles", () => {
  it("moves stale processing files back to pending", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-stale-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const processingDir = path.join(runtimeDir, "events", "agents", "developer-1", "processing");
    const pendingDir = path.join(runtimeDir, "events", "agents", "developer-1", "pending");
    await fs.mkdir(processingDir, { recursive: true });
    await fs.mkdir(pendingDir, { recursive: true });
    const fileName = "stale-message.json";
    await fs.writeFile(path.join(processingDir, fileName), "{\"id\":\"1\"}\n", "utf8");

    const result = await recoverStaleQueueProcessingFiles(runtimeDir);

    expect(result.recoveredCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    await expect(fs.stat(path.join(pendingDir, fileName))).resolves.toBeDefined();
    await expect(fs.stat(path.join(processingDir, fileName))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a recovered suffix when pending file with same name exists", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-stale-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const processingDir = path.join(runtimeDir, "events", "agents", "developer-1", "processing");
    const pendingDir = path.join(runtimeDir, "events", "agents", "developer-1", "pending");
    await fs.mkdir(processingDir, { recursive: true });
    await fs.mkdir(pendingDir, { recursive: true });
    const fileName = "duplicate.json";
    await fs.writeFile(path.join(processingDir, fileName), "{\"id\":\"processing\"}\n", "utf8");
    await fs.writeFile(path.join(pendingDir, fileName), "{\"id\":\"pending\"}\n", "utf8");

    const result = await recoverStaleQueueProcessingFiles(runtimeDir);
    const pendingFiles = (await fs.readdir(pendingDir)).filter((entry) => entry.endsWith(".json")).sort();

    expect(result.recoveredCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(pendingFiles.some((entry) => entry === fileName)).toBe(true);
    expect(pendingFiles.some((entry) => entry.startsWith("duplicate.recovered-"))).toBe(true);
  });
});
