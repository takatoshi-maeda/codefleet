import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AcceptanceTestService } from "../src/domain/acceptance/acceptance-test-service.js";
import { BuildfleetError } from "../src/shared/errors.js";

describe("AcceptanceTestService", () => {
  it("adds a result to results/*.json and updates spec lastExecutionStatus", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-acceptance-"));
    const dataDir = path.join(tempDir, ".buildfleet/data/acceptance-testing");
    const service = new AcceptanceTestService(dataDir);

    const test = await service.add({
      title: "smoke",
      epicIds: ["E-001"],
      itemIds: ["I-001"],
    });

    const result = await service.addResult({
      testId: test.id,
      status: "passed",
      summary: "ok",
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
  });

  it("self-heals cached status from latest result json", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-acceptance-"));
    const dataDir = path.join(tempDir, ".buildfleet/data/acceptance-testing");
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

    const listed = await service.list();
    expect(listed[0].lastExecutionStatus).toBe("failed");
  });

  it("validates forbidden status transitions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-acceptance-"));
    const dataDir = path.join(tempDir, ".buildfleet/data/acceptance-testing");
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
    ).rejects.toMatchObject<Partial<BuildfleetError>>({
      code: "ERR_VALIDATION",
    });
  });
});
