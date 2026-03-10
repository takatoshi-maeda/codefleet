import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BacklogService } from "../src/domain/backlog/backlog-service.js";
import { CodefleetError } from "../src/shared/errors.js";

describe("BacklogService", () => {
  it("appends change history entries to change-logs.jsonl in chronological order", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-backlog-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const changeLogPath = path.join(backlogDir, "change-logs.jsonl");

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
    await service.addItem({ epicId: epic.id, title: "item", acceptanceTestIds: [], actorId: "dev-agent" });

    const raw = await fs.readFile(changeLogPath, "utf8");
    const entries = raw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            createdAt: string;
            operation: string;
            parameters: Record<string, unknown>;
            actor?: unknown;
            reason: string;
            targetType?: string;
            targetId?: string;
            targets?: Array<{ type: string; id: string }>;
          },
      );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.id).toMatch(/^CHG-\d{8}-001$/);
    expect(entries[1]?.id).toMatch(/^CHG-\d{8}-002$/);
    expect(entries[0]?.createdAt <= entries[1]?.createdAt).toBe(true);
    expect(entries[0]?.actor).toBeUndefined();
    expect(entries[0]?.operation).toBe("epic.add");
    expect(entries[0]?.parameters).toEqual({ title: "epic", acceptanceTestIds: [] });
    expect(entries[0]?.targetType).toBe("epic");
    expect(entries[0]?.targetId).toBe("E-001");
    expect(entries[0]?.targets).toEqual([{ type: "epic", id: "E-001" }]);
    expect(entries[1]?.operation).toBe("item.add");
    expect(entries[1]?.parameters).toEqual({ epicId: "E-001", title: "item", acceptanceTestIds: [], actorId: "dev-agent" });
    expect(entries[1]?.targetType).toBe("item");
    expect(entries[1]?.targetId).toBe("I-001");
    expect(entries[1]?.targets).toEqual([{ type: "item", id: "I-001" }]);
    expect(entries[0]?.reason).toContain("epic added: E-001");
    expect(entries[0]?.reason).toContain("trigger: system");
    expect(entries[1]?.reason).toContain("item added: I-001");
    expect(entries[1]?.reason).toContain("trigger: actor:dev-agent");
  });

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

    const changeLogPath = path.join(backlogDir, "change-logs.jsonl");
    await fs.unlink(changeLogPath);

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

  it("stores and updates epic developmentScopes with legacy fallback", async () => {
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

    const service = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    const epic = await service.addEpic({
      title: "scoped epic",
      developmentScopes: ["frontend", "backend", "other", "frontend"],
      acceptanceTestIds: [],
    });

    expect(epic.developmentScopes).toEqual(["frontend", "backend", "other"]);

    const updated = await service.updateEpic({ id: epic.id, developmentScopes: ["backend", "backend"] });
    expect(updated.developmentScopes).toEqual(["backend"]);

    await fs.mkdir(path.dirname(backlogItemsPath), { recursive: true });
    await fs.writeFile(
      backlogItemsPath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          epics: [
            {
              id: "E-001",
              title: "legacy epic",
              status: "todo",
              visibility: { type: "always-visible", dependsOnEpicIds: [] },
              acceptanceTestIds: [],
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          items: [],
          questions: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const legacyService = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    const listed = await legacyService.list({ includeHidden: true });
    expect(listed.epics[0]?.developmentScopes).toEqual([]);
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

    expect(updatedEpic.notes?.map((note) => note.content)).toEqual(["epic note 1", "epic note 2"]);
    expect(updatedItem.notes?.map((note) => note.content)).toEqual(["item note 1", "item note 2"]);
    expect(updatedEpic.notes?.every((note) => note.id.length > 0 && note.createdAt.length > 0)).toBe(true);
    expect(updatedItem.notes?.every((note) => note.id.length > 0 && note.createdAt.length > 0)).toBe(true);

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

    expect(updatedEpicAgain.notes?.map((note) => note.content)).toEqual(["epic note 2", "epic note 3"]);
    expect(updatedItemAgain.notes?.map((note) => note.content)).toEqual(["item note 2", "item note 3"]);
  });

  it("tracks per-status changedAt timestamps for new and updated epics/items", async () => {
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
    const item = await service.addItem({ epicId: epic.id, title: "item", acceptanceTestIds: [], status: "wait-implementation" });

    expect(epic.statusChangeHistory).toEqual([{ from: "todo", to: "todo", changedAt: epic.updatedAt }]);
    expect(item.statusChangeHistory).toEqual([{ from: "wait-implementation", to: "wait-implementation", changedAt: item.updatedAt }]);

    const startedEpic = await service.updateEpic({ id: epic.id, status: "in-progress" });
    expect(startedEpic.statusChangeHistory).toEqual([
      { from: "todo", to: "todo", changedAt: epic.updatedAt },
      { from: "todo", to: "in-progress", changedAt: startedEpic.updatedAt },
    ]);

    const doneItem = await service.updateItem({ id: item.id, status: "in-progress" });
    const blockedItem = await service.updateItem({ id: item.id, status: "blocked" });
    expect(doneItem.statusChangeHistory).toEqual([
      { from: "wait-implementation", to: "wait-implementation", changedAt: item.updatedAt },
      { from: "wait-implementation", to: "in-progress", changedAt: doneItem.updatedAt },
    ]);
    expect(blockedItem.statusChangeHistory).toEqual([
      { from: "wait-implementation", to: "wait-implementation", changedAt: item.updatedAt },
      { from: "wait-implementation", to: "in-progress", changedAt: doneItem.updatedAt },
      { from: "in-progress", to: "blocked", changedAt: blockedItem.updatedAt },
    ]);
  });

  it("retains repeated status timestamps in visit order", async () => {
    vi.useFakeTimers();
    try {
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

      vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
      const service = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
      const epic = await service.addEpic({ title: "epic", acceptanceTestIds: [] });

      vi.setSystemTime(new Date("2026-01-10T01:00:00.000Z"));
      await service.updateEpic({ id: epic.id, status: "in-progress" });
      vi.setSystemTime(new Date("2026-01-10T02:00:00.000Z"));
      await service.updateEpic({ id: epic.id, status: "in-review" });
      vi.setSystemTime(new Date("2026-01-10T03:00:00.000Z"));
      await service.updateEpic({ id: epic.id, status: "changes-requested" });
      vi.setSystemTime(new Date("2026-01-10T04:00:00.000Z"));
      await service.updateEpic({ id: epic.id, status: "in-progress" });
      vi.setSystemTime(new Date("2026-01-10T05:00:00.000Z"));
      await service.updateEpic({ id: epic.id, status: "in-review" });
      vi.setSystemTime(new Date("2026-01-10T06:00:00.000Z"));
      const done = await service.updateEpic({ id: epic.id, status: "done" });

      expect(done.statusChangeHistory).toEqual([
        { from: "todo", to: "todo", changedAt: "2026-01-10T00:00:00.000Z" },
        { from: "todo", to: "in-progress", changedAt: "2026-01-10T01:00:00.000Z" },
        { from: "in-progress", to: "in-review", changedAt: "2026-01-10T02:00:00.000Z" },
        { from: "in-review", to: "changes-requested", changedAt: "2026-01-10T03:00:00.000Z" },
        { from: "changes-requested", to: "in-progress", changedAt: "2026-01-10T04:00:00.000Z" },
        { from: "in-progress", to: "in-review", changedAt: "2026-01-10T05:00:00.000Z" },
        { from: "in-review", to: "done", changedAt: "2026-01-10T06:00:00.000Z" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows items to move directly from todo to in-progress", async () => {
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
    const startedItem = await service.updateItem({ id: item.id, status: "in-progress" });

    expect(startedItem.status).toBe("in-progress");
    expect(startedItem.statusChangeHistory).toEqual([
      { from: "todo", to: "todo", changedAt: item.updatedAt },
      { from: "todo", to: "in-progress", changedAt: startedItem.updatedAt },
    ]);
  });

  it("does not change per-status changedAt timestamps for non-status updates", async () => {
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

    const epicStatusChangeHistory = epic.statusChangeHistory.map((entry) => ({ ...entry }));
    const itemStatusChangeHistory = item.statusChangeHistory.map((entry) => ({ ...entry }));

    const updatedEpic = await service.updateEpic({ id: epic.id, addNotes: ["note"] });
    const updatedItem = await service.updateItem({ id: item.id, title: "renamed item" });

    expect(updatedEpic.statusChangeHistory).toEqual(epicStatusChangeHistory);
    expect(updatedItem.statusChangeHistory).toEqual(itemStatusChangeHistory);
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

  it("normalizes legacy string notes into note objects", async () => {
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
        {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          epics: [
            {
              id: "E-001",
              title: "legacy epic",
              status: "todo",
              visibility: { type: "always-visible", dependsOnEpicIds: [] },
              acceptanceTestIds: [],
              notes: ["legacy epic note"],
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          items: [
            {
              id: "I-001",
              epicId: "E-001",
              title: "legacy item",
              status: "todo",
              acceptanceTestIds: [],
              notes: ["legacy item note"],
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          questions: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const service = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    const listed = await service.list();
    expect(listed.epics[0]?.notes?.[0]).toMatchObject({
      content: "legacy epic note",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(listed.epics[0]?.developmentScopes).toEqual([]);
    expect(listed.items[0]?.notes?.[0]).toMatchObject({
      content: "legacy item note",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("normalizes missing per-status changedAt from current status and updatedAt", async () => {
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
        {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          epics: [
            {
              id: "E-001",
              title: "legacy epic",
              status: "in-review",
              visibility: { type: "always-visible", dependsOnEpicIds: [] },
              acceptanceTestIds: [],
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          ],
          items: [
            {
              id: "I-001",
              epicId: "E-001",
              title: "legacy item",
              status: "blocked",
              acceptanceTestIds: [],
              updatedAt: "2026-01-03T00:00:00.000Z",
            },
          ],
          questions: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const service = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    const listed = await service.list();

    expect(listed.epics[0]?.statusChangeHistory).toEqual([
      { from: "in-review", to: "in-review", changedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(listed.items[0]?.statusChangeHistory).toEqual([
      { from: "blocked", to: "blocked", changedAt: "2026-01-03T00:00:00.000Z" },
    ]);
  });

  it("reads item by id and returns ERR_NOT_FOUND for unknown ids", async () => {
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

    const read = await service.readItem({ id: item.id });
    expect(read.id).toBe(item.id);
    expect(read.epicId).toBe(epic.id);

    await expect(service.readItem({ id: "I-999" })).rejects.toMatchObject<Partial<CodefleetError>>({
      code: "ERR_NOT_FOUND",
    });
  });

  it("lists only ready epics from visibility dependencies", async () => {
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
    await service.updateEpic({ id: first.id, status: "in-review" });
    await service.updateEpic({ id: first.id, status: "done" });
    const readyAfter = await service.listReadyEpics();
    expect(readyAfter.map((epic) => epic.id)).toEqual(["E-002"]);
  });

  it("includes todo/changes-requested/failed in ready epics", async () => {
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
    const todo = await service.addEpic({ title: "todo", acceptanceTestIds: [], status: "todo" });
    const rework = await service.addEpic({ title: "rework", acceptanceTestIds: [], status: "changes-requested" });
    const failed = await service.addEpic({ title: "failed", acceptanceTestIds: [], status: "failed" });
    await service.addEpic({ title: "done", acceptanceTestIds: [], status: "done" });

    const ready = await service.listReadyEpics();
    expect(ready.map((epic) => epic.id)).toEqual([todo.id, rework.id, failed.id]);
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

  it("does not claim a new todo epic while another epic is in-review", async () => {
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
    await service.addEpic({ title: "second", acceptanceTestIds: [] });
    await service.updateEpic({ id: first.id, status: "in-progress" });
    await service.updateEpic({ id: first.id, status: "in-review" });

    const claimed = await service.claimReadyEpicForImplementation("developer-1");
    expect(claimed).toBeNull();
  });

  it("claims changes-requested epic as ready for re-implementation", async () => {
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
    const rework = await service.addEpic({ title: "rework", acceptanceTestIds: [], status: "changes-requested" });
    await service.addEpic({ title: "new", acceptanceTestIds: [], status: "todo" });

    const claimed = await service.claimReadyEpicForImplementation("developer-1");
    expect(claimed?.id).toBe(rework.id);
    expect(claimed?.status).toBe("in-progress");
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

  it("resets only in-progress epic/item statuses to todo", async () => {
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
    const activeEpic = await service.addEpic({ title: "active epic", status: "in-progress", acceptanceTestIds: [] });
    const doneEpic = await service.addEpic({ title: "done epic", status: "done", acceptanceTestIds: [] });
    const activeItem = await service.addItem({
      epicId: activeEpic.id,
      title: "active item",
      status: "in-progress",
      acceptanceTestIds: [],
    });
    const blockedItem = await service.addItem({
      epicId: doneEpic.id,
      title: "blocked item",
      status: "blocked",
      acceptanceTestIds: [],
    });

    const reset = await service.resetInProgressToTodo();
    expect(reset).toEqual({
      updatedEpicIds: [activeEpic.id],
      updatedItemIds: [activeItem.id],
    });

    const listed = await service.list({ includeHidden: true });
    const listedActiveEpic = listed.epics.find((epic) => epic.id === activeEpic.id);
    const listedDoneEpic = listed.epics.find((epic) => epic.id === doneEpic.id);
    const listedActiveItem = listed.items.find((item) => item.id === activeItem.id);
    const listedBlockedItem = listed.items.find((item) => item.id === blockedItem.id);
    expect(listedActiveEpic?.status).toBe("todo");
    expect(listedDoneEpic?.status).toBe("done");
    expect(listedActiveItem?.status).toBe("todo");
    expect(listedBlockedItem?.status).toBe("blocked");
  });

});
