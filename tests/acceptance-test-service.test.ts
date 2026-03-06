import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AcceptanceTestService } from "../src/domain/acceptance/acceptance-test-service.js";
import { CodefleetError } from "../src/shared/errors.js";

describe("AcceptanceTestService", () => {
  it("adds a result to results/*.json and updates spec lastExecutionStatus", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-acceptance-"));
    const dataDir = path.join(tempDir, ".codefleet/data/acceptance-testing");
    const service = new AcceptanceTestService(dataDir);

    const test = await service.add({
      title: "smoke",
      notes: ["smoke test notes"],
      epicIds: ["E-001"],
      itemIds: ["I-001"],
    });

    const result = await service.addResult({
      testId: test.id,
      status: "passed",
      summary: "ok",
      lastExecutionNote: "all happy paths passed",
      executor: "qa",
      artifacts: [],
      logs: [],
    });

    const specRaw = await fs.readFile(path.join(dataDir, "spec.json"), "utf8");
    const spec = JSON.parse(specRaw);

    const resultRaw = await fs.readFile(path.join(dataDir, "results", `${result.resultId}.json`), "utf8");
    const savedResult = JSON.parse(resultRaw);

    expect(savedResult.status).toBe("passed");
    expect(spec.tests[0].lastExecutionStatus).toBe("passed");
    expect(spec.tests[0].lastExecutionNote).toBe("all happy paths passed");
    expect(spec.tests[0].notes).toHaveLength(1);
    expect(spec.tests[0].notes[0]).toMatchObject({ content: "smoke test notes" });
  });

  it("self-heals cached status from latest result json when explicitly requested", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-acceptance-"));
    const dataDir = path.join(tempDir, ".codefleet/data/acceptance-testing");
    const service = new AcceptanceTestService(dataDir);

    const test = await service.add({
      title: "regression",
      epicIds: ["E-002"],
      itemIds: ["I-002"],
    });

    await fs.mkdir(path.join(dataDir, "results"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "results", "ATR-20260101-001.json"),
      JSON.stringify(
        {
          resultId: "ATR-20260101-001",
          testId: test.id,
          executedAt: "2026-01-01T00:00:00.000Z",
          executor: "qa",
          status: "failed",
          summary: "failed",
        },
        null,
        2,
      ),
      "utf8",
    );

    await service.selfHealLastExecutionStatus();
    const listed = await service.list();
    expect(listed[0].lastExecutionStatus).toBe("failed");
    expect(listed[0].lastExecutionNote).toBe("failed");
  });

  it("validates forbidden status transitions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-acceptance-"));
    const dataDir = path.join(tempDir, ".codefleet/data/acceptance-testing");
    const service = new AcceptanceTestService(dataDir);

    const test = await service.add({
      title: "status test",
      status: "draft",
      epicIds: ["E-003"],
      itemIds: ["I-003"],
    });

    await expect(
      service.update({
        id: test.id,
        status: "in-progress",
      }),
    ).rejects.toMatchObject<Partial<CodefleetError>>({
      code: "ERR_VALIDATION",
    });
  });

  it("appends and removes notes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-acceptance-"));
    const dataDir = path.join(tempDir, ".codefleet/data/acceptance-testing");
    const service = new AcceptanceTestService(dataDir);

    const test = await service.add({
      title: "notes target",
      epicIds: ["E-004"],
      itemIds: ["I-004"],
    });

    const updated = await service.update({
      id: test.id,
      addNotes: ["first", "second"],
    });
    expect(updated.notes?.map((note) => note.content)).toEqual(["first", "second"]);
    expect(updated.notes?.every((note) => note.id.length > 0 && note.createdAt.length > 0)).toBe(true);

    const updatedAgain = await service.update({
      id: test.id,
      addNotes: ["third", "second"],
      removeNotes: ["first"],
    });

    expect(updatedAgain.notes?.map((note) => note.content)).toEqual(["second", "third"]);
  });

  it("normalizes legacy string notes into note objects on read", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-acceptance-"));
    const dataDir = path.join(tempDir, ".codefleet/data/acceptance-testing");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "spec.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          tests: [
            {
              id: "AT-001",
              title: "legacy",
              notes: ["legacy note"],
              status: "ready",
              lastExecutionStatus: "not-run",
              epicIds: ["E-001"],
              itemIds: ["I-001"],
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const service = new AcceptanceTestService(dataDir);
    const listed = await service.list();

    expect(listed[0]?.notes?.[0]).toMatchObject({
      id: "legacy-note-1",
      content: "legacy note",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("clears all acceptance-test data files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-acceptance-"));
    const dataDir = path.join(tempDir, ".codefleet/data/acceptance-testing");
    const service = new AcceptanceTestService(dataDir);

    const test = await service.add({
      title: "clear target",
      epicIds: ["E-005"],
      itemIds: ["I-005"],
    });
    await service.addResult({
      testId: test.id,
      status: "passed",
      summary: "ok",
      executor: "qa",
      artifacts: [],
      logs: [],
    });

    await service.clearAllData();

    await expect(fs.access(path.join(dataDir, "spec.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(dataDir, "results"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("manually updates lastExecutionStatus for all tests", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-acceptance-"));
    const dataDir = path.join(tempDir, ".codefleet/data/acceptance-testing");
    const service = new AcceptanceTestService(dataDir);

    await service.add({
      title: "manual status 1",
      epicIds: ["E-006"],
      itemIds: ["I-006"],
    });
    const second = await service.add({
      title: "manual status 2",
      epicIds: ["E-007"],
      itemIds: ["I-007"],
    });
    await service.addResult({
      testId: second.id,
      status: "passed",
      summary: "ok",
      executor: "qa",
      artifacts: [],
      logs: [],
    });

    await service.updateLastExecutionStatusAll("failed", "forced reset by gatekeeper");

    const specRaw = await fs.readFile(path.join(dataDir, "spec.json"), "utf8");
    const spec = JSON.parse(specRaw) as { tests: Array<{ lastExecutionStatus: string; lastExecutionNote?: string }> };
    expect(spec.tests.every((test) => test.lastExecutionStatus === "failed")).toBe(true);
    expect(spec.tests.every((test) => test.lastExecutionNote === "forced reset by gatekeeper")).toBe(true);
  });
});
