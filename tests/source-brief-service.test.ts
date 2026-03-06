import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SourceBriefService } from "../src/domain/source-brief/source-brief-service.js";

describe("SourceBriefService", () => {
  it("writes and reads the latest source brief", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-source-brief-"));
    const briefDir = path.join(tempDir, ".codefleet/data/source-brief");
    const service = new SourceBriefService(briefDir);

    const saved = await service.writeLatest({
      markdown: "# Source Brief\n\n## Goals\n- Goal A\n",
      sourcePaths: ["docs/spec", "docs/spec", "docs/requirements.md"],
      actorId: "curator-1",
    });

    expect(saved.briefPath).toBe(path.join(briefDir, "latest.md"));
    expect(saved.sourcePaths).toEqual(["docs/spec", "docs/requirements.md"]);

    const loaded = await service.readLatest();
    expect(loaded).toEqual(saved);
  });

  it("returns null when no source brief exists yet", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-source-brief-"));
    const service = new SourceBriefService(path.join(tempDir, ".codefleet/data/source-brief"));

    await expect(service.readLatest()).resolves.toBeNull();
  });
});
