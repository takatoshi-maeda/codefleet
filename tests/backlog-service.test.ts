import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BacklogService } from "../src/domain/backlog/backlog-service.js";
import { CodefleetError } from "../src/shared/errors.js";

describe("BacklogService", () => {
  it("returns ERR_BACKLOG_SNAPSHOT_NOT_STABLE when wait-implementation listing is unstable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-backlog-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");

    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [] }, null, 2),
      "utf8",
    );

    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(rolesPath, JSON.stringify({ agents: [] }, null, 2), "utf8");

    const service = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    const epic = await service.addEpic({
      title: "epic",
      notes: ["epic notes"],
      acceptanceTestIds: [],
      actorId: "pm-agent",
    });

    await service.addItem({
      epicId: epic.id,
      title: "item",
      notes: ["item notes"],
      status: "wait-implementation",
      acceptanceTestIds: [],
      actorId: "pm-agent",
    });

    const changeLogDir = path.join(backlogDir, "change-logs");
    const changeLogs = await fs.readdir(changeLogDir);
    for (const changeLog of changeLogs) {
      await fs.unlink(path.join(changeLogDir, changeLog));
    }

    await expect(service.list({ status: "wait-implementation" })).rejects.toMatchObject<Partial<CodefleetError>>({
      code: "ERR_BACKLOG_SNAPSHOT_NOT_STABLE",
    });
  });

  it("allows --include-hidden only for Orchestrator", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-backlog-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");

    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [] }, null, 2),
      "utf8",
    );

    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(
      rolesPath,
      JSON.stringify({ agents: [{ id: "pm-agent", role: "Orchestrator" }, { id: "dev-agent", role: "Developer" }] }, null, 2),
      "utf8",
    );

    const service = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    await service.addEpic({
      title: "secret epic",
      visibility: { type: "blocked-until-epic-complete", dependsOnEpicIds: ["E-999"] },
      acceptanceTestIds: [],
      actorId: "pm-agent",
    });

    await expect(service.list({ includeHidden: true, actorId: "dev-agent" })).rejects.toMatchObject<
      Partial<CodefleetError>
    >({ code: "ERR_VALIDATION" });

    const listedByPm = await service.list({ includeHidden: true, actorId: "pm-agent" });
    expect(listedByPm.epics).toHaveLength(1);
  });

  it("validates acceptanceTestIds references", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-backlog-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");

    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [{ id: "AT-001", title: "t", status: "draft", lastExecutionStatus: "not-run", epicIds: [], itemIds: [], updatedAt: "2026-01-01T00:00:00.000Z" }] }, null, 2),
      "utf8",
    );

    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(rolesPath, JSON.stringify({ agents: [] }, null, 2), "utf8");

    const service = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);

    await expect(
      service.addEpic({ title: "invalid refs", acceptanceTestIds: ["AT-404"] }),
    ).rejects.toMatchObject<Partial<CodefleetError>>({ code: "ERR_VALIDATION" });

    const epic = await service.addEpic({ title: "valid refs", acceptanceTestIds: ["AT-001"] });
    expect(epic.acceptanceTestIds).toEqual(["AT-001"]);
  });

  it("appends and removes notes for epic and item", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-backlog-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");

    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [] }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(rolesPath, JSON.stringify({ agents: [] }, null, 2), "utf8");

    const service = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    const epic = await service.addEpic({ title: "epic", acceptanceTestIds: [] });
    const item = await service.addItem({ epicId: epic.id, title: "item", acceptanceTestIds: [] });

    const updatedEpic = await service.updateEpic({ id: epic.id, addNotes: ["epic note 1", "epic note 2"] });
    const updatedItem = await service.updateItem({ id: item.id, addNotes: ["item note 1", "item note 2"] });

    expect(updatedEpic.notes).toEqual(["epic note 1", "epic note 2"]);
    expect(updatedItem.notes).toEqual(["item note 1", "item note 2"]);

    const updatedEpicAgain = await service.updateEpic({
      id: epic.id,
      addNotes: ["epic note 3", "epic note 2"],
      removeNotes: ["epic note 1"],
    });
    const updatedItemAgain = await service.updateItem({
      id: item.id,
      addNotes: ["item note 3", "item note 2"],
      removeNotes: ["item note 1"],
    });

    expect(updatedEpicAgain.notes).toEqual(["epic note 2", "epic note 3"]);
    expect(updatedItemAgain.notes).toEqual(["item note 2", "item note 3"]);
  });
});
