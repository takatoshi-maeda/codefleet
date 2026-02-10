import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteJson } from "../src/infra/fs/atomic-write.js";

describe("atomicWriteJson", () => {
  it("writes JSON with temp-file rename and leaves no temp file behind", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-atomic-"));
    const targetFile = path.join(tempDir, "state.json");

    await atomicWriteJson(targetFile, { id: "A-001", status: "ready" });

    const raw = await fs.readFile(targetFile, "utf8");
    expect(JSON.parse(raw)).toEqual({ id: "A-001", status: "ready" });

    const files = await fs.readdir(tempDir);
    expect(files).toEqual(["state.json"]);
  });
});
