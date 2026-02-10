import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AcceptanceTestingSpec } from "../src/domain/acceptance-testing-spec-model.js";
import { SCHEMA_PATHS } from "../src/domain/schema-paths.js";
import { JsonRepository } from "../src/infra/fs/json-repository.js";
import { BuildfleetError } from "../src/shared/errors.js";

const validSpec: AcceptanceTestingSpec = {
  version: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  tests: [
    {
      id: "AT-001",
      title: "happy path",
      status: "ready",
      lastExecutionStatus: "not-run",
      epicIds: ["E-001"],
      itemIds: ["I-001"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("JsonRepository", () => {
  it("loads valid JSON and validates against schema", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-json-repo-"));
    const targetFile = path.join(tempDir, "spec.json");
    await fs.writeFile(targetFile, JSON.stringify(validSpec), "utf8");

    const repo = new JsonRepository<AcceptanceTestingSpec>(targetFile, SCHEMA_PATHS.acceptanceTestingSpec);

    await expect(repo.get()).resolves.toEqual(validSpec);
  });

  it("fails with ERR_VALIDATION for invalid JSON content", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-json-repo-"));
    const targetFile = path.join(tempDir, "spec.json");

    const invalidSpec = { ...validSpec, tests: [{ ...validSpec.tests[0], id: "INVALID-ID" }] };
    await fs.writeFile(targetFile, JSON.stringify(invalidSpec), "utf8");

    const repo = new JsonRepository<AcceptanceTestingSpec>(targetFile, SCHEMA_PATHS.acceptanceTestingSpec);

    await expect(repo.get()).rejects.toMatchObject<Partial<BuildfleetError>>({
      code: "ERR_VALIDATION",
    });
  });

  it("fails pre-validation before save for invalid entity", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-json-repo-"));
    const targetFile = path.join(tempDir, "spec.json");

    const repo = new JsonRepository<AcceptanceTestingSpec>(targetFile, SCHEMA_PATHS.acceptanceTestingSpec);

    const invalidSpec = { ...validSpec, version: 0 } as AcceptanceTestingSpec;

    await expect(repo.save(invalidSpec)).rejects.toMatchObject<Partial<BuildfleetError>>({
      code: "ERR_VALIDATION",
    });
  });
});
