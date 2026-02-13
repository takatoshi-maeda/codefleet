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
    const listedWithoutActor = await service.list({ includeHidden: true });
    expect(listedWithoutActor.epics).toHaveLength(1);
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

  it("supports backlog question add/list/update/answer/delete", async () => {
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
    const added = await service.addQuestion({ title: "Need API retry policy?", details: "timeout/retry numbers" });
    expect(added.id).toBe("Q-001");
    expect(added.status).toBe("open");

    const listed = await service.listQuestions();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("Need API retry policy?");

    const updated = await service.updateQuestion({ id: added.id, title: "Need retry policy?", status: "open" });
    expect(updated.title).toBe("Need retry policy?");

    const answered = await service.answerQuestion({ id: added.id, answer: "Use exponential backoff with 3 retries." });
    expect(answered.status).toBe("answered");
    expect(answered.answer).toContain("exponential backoff");

    await service.deleteQuestion(added.id);
    expect(await service.listQuestions()).toHaveLength(0);
  });

  it("normalizes backlog items without questions field", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-backlog-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const backlogItemsPath = path.join(backlogDir, "items.json");

    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [] }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(rolesPath, JSON.stringify({ agents: [] }, null, 2), "utf8");
    await fs.mkdir(path.dirname(backlogItemsPath), { recursive: true });
    await fs.writeFile(
      backlogItemsPath,
      JSON.stringify(
        { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", epics: [], items: [] },
        null,
        2,
      ),
      "utf8",
    );

    const service = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    expect(await service.listQuestions()).toEqual([]);
  });

  it("lists only startable epics from visibility dependencies", async () => {
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
    const first = await service.addEpic({ title: "first", acceptanceTestIds: [] });
    await service.addEpic({
      title: "second",
      acceptanceTestIds: [],
      visibility: { type: "blocked-until-epic-complete", dependsOnEpicIds: [first.id] },
    });

    const readyBefore = await service.listReadyEpics();
    expect(readyBefore.map((epic) => epic.id)).toEqual([first.id]);

    await service.updateEpic({ id: first.id, status: "in-progress" });
    await service.updateEpic({ id: first.id, status: "done" });
    const readyAfter = await service.listReadyEpics();
    expect(readyAfter.map((epic) => epic.id)).toEqual(["E-001", "E-002"]);
  });

  it("claims a single ready epic for implementation and removes it from ready(todo) candidates", async () => {
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
    const first = await service.addEpic({ title: "first", acceptanceTestIds: [] });
    const second = await service.addEpic({ title: "second", acceptanceTestIds: [] });

    const claimed = await service.claimReadyEpicForImplementation("developer-1");
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("in-progress");

    const readyTodo = await service.listReadyEpics("todo");
    expect(readyTodo.map((epic) => epic.id)).toEqual([second.id]);
  });

  it("supports kind classification and filtering for epics/items", async () => {
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
    const productEpic = await service.addEpic({ title: "product epic", acceptanceTestIds: [] });
    const technicalEpic = await service.addEpic({ title: "technical epic", kind: "technical", acceptanceTestIds: [] });
    await service.addItem({ epicId: productEpic.id, title: "product item", acceptanceTestIds: [] });
    await service.addItem({ epicId: technicalEpic.id, title: "technical item", kind: "technical", acceptanceTestIds: [] });

    const listedAll = await service.list();
    expect(listedAll.epics.map((epic) => epic.kind)).toEqual(["product", "technical"]);
    expect(listedAll.items.map((item) => item.kind)).toEqual(["product", "technical"]);

    const listedTechnical = await service.list({ kind: "technical", includeHidden: true });
    expect(listedTechnical.epics.map((epic) => epic.id)).toEqual([technicalEpic.id]);
    expect(listedTechnical.items.map((item) => item.epicId)).toEqual([technicalEpic.id]);
  });

  it("filters listed items by epicId", async () => {
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
    const firstEpic = await service.addEpic({ title: "first epic", acceptanceTestIds: [] });
    const secondEpic = await service.addEpic({ title: "second epic", acceptanceTestIds: [] });
    await service.addItem({ epicId: firstEpic.id, title: "item 1", acceptanceTestIds: [] });
    await service.addItem({ epicId: secondEpic.id, title: "item 2", acceptanceTestIds: [] });

    const filtered = await service.list({ epicId: firstEpic.id, includeHidden: true });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.epicId).toBe(firstEpic.id);
  });

  it("reads epic/item by id and rejects unknown ids", async () => {
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
    const epic = await service.addEpic({ title: "read target", acceptanceTestIds: [] });
    const item = await service.addItem({ epicId: epic.id, title: "read item", acceptanceTestIds: [] });

    const loadedEpic = await service.readEpic({ id: epic.id });
    expect(loadedEpic.id).toBe(epic.id);
    const loadedItem = await service.readItem({ id: item.id });
    expect(loadedItem.id).toBe(item.id);

    await expect(service.readEpic({ id: "E-999" })).rejects.toMatchObject<Partial<CodefleetError>>({
      code: "ERR_NOT_FOUND",
    });
    await expect(service.readItem({ id: "I-999" })).rejects.toMatchObject<Partial<CodefleetError>>({
      code: "ERR_NOT_FOUND",
    });
  });

  it("allows bypassing epic status transition guard with force option", async () => {
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
    const epic = await service.addEpic({ title: "force transition", acceptanceTestIds: [] });
    await service.updateEpic({ id: epic.id, status: "in-progress" });

    await expect(service.updateEpic({ id: epic.id, status: "todo" })).rejects.toMatchObject<Partial<CodefleetError>>({
      code: "ERR_VALIDATION",
    });

    const forced = await service.updateEpic({ id: epic.id, status: "todo", force: true });
    expect(forced.status).toBe("todo");
  });

  it("resets all epic/item statuses to todo in a single operation", async () => {
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
    const doneEpic = await service.addEpic({ title: "done epic", status: "done", acceptanceTestIds: [] });
    const todoEpic = await service.addEpic({ title: "todo epic", acceptanceTestIds: [] });
    const activeItem = await service.addItem({
      epicId: doneEpic.id,
      title: "active item",
      status: "in-progress",
      acceptanceTestIds: [],
    });
    await service.addItem({ epicId: todoEpic.id, title: "todo item", acceptanceTestIds: [] });

    const reset = await service.updateStatusAllTodo();
    expect(reset).toEqual({
      updatedEpicIds: [doneEpic.id],
      updatedItemIds: [activeItem.id],
    });

    const listed = await service.list({ includeHidden: true });
    expect(listed.epics.every((epic) => epic.status === "todo")).toBe(true);
    expect(listed.items.every((item) => item.status === "todo")).toBe(true);

    const secondReset = await service.updateStatusAllTodo();
    expect(secondReset).toEqual({ updatedEpicIds: [], updatedItemIds: [] });
  });

  it("reads and writes single requirements text", async () => {
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
    expect(await service.readRequirements()).toBe("");

    await service.writeRequirements("first requirement");
    expect(await service.readRequirements()).toBe("first requirement");

    await service.writeRequirements("second requirement");
    expect(await service.readRequirements()).toBe("second requirement");
  });
});
