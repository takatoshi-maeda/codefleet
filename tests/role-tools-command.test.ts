import { describe, expect, it, vi, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { AcceptanceTestService } from "../src/domain/acceptance/acceptance-test-service.js";
import { BacklogService } from "../src/domain/backlog/backlog-service.js";
import { createCuratorToolsCli } from "../src/cli/codefleet-curator-tools.js";
import { createDeveloperToolsCli } from "../src/cli/codefleet-developer-tools.js";
import { createGatekeeperToolsCli } from "../src/cli/codefleet-gatekeeper-tools.js";
import { createOrchestratorToolsCli } from "../src/cli/codefleet-orchestrator-tools.js";
import { createPolisherToolsCli } from "../src/cli/codefleet-polisher-tools.js";
import { createReviewerToolsCli } from "../src/cli/codefleet-reviewer-tools.js";
import { SourceBriefService } from "../src/domain/source-brief/source-brief-service.js";

describe("role tools commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("curator source-brief save persists markdown and source paths", async () => {
    const writeSpy = vi.spyOn(SourceBriefService.prototype, "writeLatest").mockResolvedValue({
      version: 1,
      updatedAt: "2026-03-04T00:00:00.000Z",
      briefPath: ".codefleet/data/source-brief/latest.md",
      sourcePaths: ["docs/spec", "docs/requirements.md"],
      actorId: "curator-1",
      markdown: "# Source Brief\n",
    });

    await createCuratorToolsCli().parseAsync(
      [
        "--actor-id",
        "curator-1",
        "source-brief",
        "save",
        "--text",
        "# Source Brief",
        "--source-path",
        "docs/spec",
        "--source-path",
        "docs/requirements.md",
      ],
      {
        from: "user",
      },
    );

    expect(writeSpy).toHaveBeenCalledWith({
      markdown: "# Source Brief",
      sourcePaths: ["docs/spec", "docs/requirements.md"],
      actorId: "curator-1",
    });
  });

  it("all role tool CLIs expose agents-md view and print AGENTS.md contents", async () => {
    const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValue("# AGENTS\nuse this\n");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const commands = [
      createCuratorToolsCli(),
      createDeveloperToolsCli(),
      createGatekeeperToolsCli(),
      createOrchestratorToolsCli(),
      createPolisherToolsCli(),
      createReviewerToolsCli(),
    ];

    for (const command of commands) {
      await command.parseAsync(["agents-md", "view"], { from: "user" });
    }

    expect(readFileSpy).toHaveBeenCalledWith("/workspace/AGENTS.md", "utf8");
    expect(logSpy).toHaveBeenCalledTimes(commands.length);
    expect(logSpy).toHaveBeenNthCalledWith(1, "# AGENTS\nuse this\n");
    expect(logSpy).toHaveBeenNthCalledWith(commands.length, "# AGENTS\nuse this\n");
  });

  it("agents-md view throws when AGENTS.md is missing", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValue(missing);

    await expect(createOrchestratorToolsCli().parseAsync(["agents-md", "view"], { from: "user" })).rejects.toThrow(
      "AGENTS.md not found at /workspace/AGENTS.md",
    );
  });

  it("orchestrator item view reads and prints item summary", async () => {
    const readSpy = vi.spyOn(BacklogService.prototype, "readItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Implement",
      kind: "technical",
      notes: [{ id: "N-001", content: "orchestrator note", createdAt: "2026-03-04T00:00:00.000Z" }],
      status: "todo",
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createOrchestratorToolsCli().parseAsync(["item", "view", "--id", "I-104"], {
      from: "user",
    });

    expect(readSpy).toHaveBeenCalledWith({ id: "I-104" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("I-104 (E-012) | todo | Implement"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("orchestrator note"));
  });

  it("orchestrator epic upsert appends a note on update", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateEpic").mockResolvedValue({
      id: "E-012",
      title: "Checkout Revamp",
      kind: "product",
      developmentScopes: ["frontend"],
      status: "todo",
      notes: [{ id: "N-001", content: "Scope aligned with latest acceptance plan", createdAt: "2026-03-04T00:00:00.000Z" }],
      visibility: { type: "always-visible", dependsOnEpicIds: [] },
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createOrchestratorToolsCli().parseAsync(
      [
        "epic",
        "upsert",
        "--id",
        "E-012",
        "--title",
        "Checkout Revamp",
        "--development-scope",
        "frontend",
        "--note",
        "Scope aligned with latest acceptance plan",
      ],
      { from: "user" },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "E-012",
        developmentScopes: ["frontend"],
        addNotes: ["Scope aligned with latest acceptance plan"],
      }),
    );
  });

  it("orchestrator item upsert appends a note on update", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Add E2E coverage",
      kind: "technical",
      status: "todo",
      notes: [{ id: "N-001", content: "Waiting on API contract confirmation", createdAt: "2026-03-04T00:00:00.000Z" }],
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createOrchestratorToolsCli().parseAsync(
      [
        "item",
        "upsert",
        "--id",
        "I-104",
        "--title",
        "Add E2E coverage",
        "--note",
        "Waiting on API contract confirmation",
      ],
      { from: "user" },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "I-104",
        addNotes: ["Waiting on API contract confirmation"],
      }),
    );
  });

  it("orchestrator current-context view prints only planning data fields", async () => {
    vi.spyOn(BacklogService.prototype, "list").mockResolvedValue({
      epics: [],
      items: [],
    });
    vi.spyOn(BacklogService.prototype, "listQuestions").mockResolvedValue([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createOrchestratorToolsCli().parseAsync(["current-context", "view"], {
      from: "user",
    });

    expect(logSpy).toHaveBeenCalledWith('{\n  "epics": [],\n  "items": [],\n  "openQuestions": []\n}');
  });

  it("developer item start updates status and note", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Implement",
      kind: "technical",
      notes: [{ id: "N-001", content: "start", createdAt: "2026-03-04T00:00:00.000Z" }],
      status: "in-progress",
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createDeveloperToolsCli().parseAsync(["item", "start", "--id", "I-104", "--note", "start"], {
      from: "user",
    });

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "I-104",
        status: "in-progress",
        addNotes: ["start"],
      }),
    );
  });

  it("developer item view reads and prints item summary", async () => {
    const readSpy = vi.spyOn(BacklogService.prototype, "readItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Implement",
      kind: "technical",
      notes: [{ id: "N-002", content: "developer note", createdAt: "2026-03-04T00:00:00.000Z" }],
      status: "todo",
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createDeveloperToolsCli().parseAsync(["item", "view", "--id", "I-104"], {
      from: "user",
    });

    expect(readSpy).toHaveBeenCalledWith({ id: "I-104" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("I-104 (E-012) | todo | Implement"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("developer note"));
  });

  it("developer epic add-note appends a note", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateEpic").mockResolvedValue({
      id: "E-012",
      title: "Checkout",
      kind: "product",
      developmentScopes: [],
      status: "in-progress",
      notes: [{ id: "N-101", content: "Need API clarification", createdAt: "2026-03-04T00:00:00.000Z" }],
      visibility: { type: "always-visible", dependsOnEpicIds: [] },
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createDeveloperToolsCli().parseAsync(
      ["epic", "add-note", "--id", "E-012", "--note", "Need API clarification"],
      { from: "user" },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "E-012",
        addNotes: ["Need API clarification"],
      }),
    );
  });

  it("developer item add-note appends a note", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Implement",
      kind: "technical",
      notes: [{ id: "N-102", content: "Investigating flaky checkout assertion", createdAt: "2026-03-04T00:00:00.000Z" }],
      status: "in-progress",
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createDeveloperToolsCli().parseAsync(
      ["item", "add-note", "--id", "I-104", "--note", "Investigating flaky checkout assertion"],
      { from: "user" },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "I-104",
        addNotes: ["Investigating flaky checkout assertion"],
      }),
    );
  });

  it("developer current-context view prints only implementation data fields", async () => {
    vi.spyOn(BacklogService.prototype, "readEpic").mockResolvedValue({
      id: "E-012",
      title: "Checkout",
      kind: "product",
      developmentScopes: [],
      status: "in-progress",
      notes: [],
      visibility: { type: "always-visible", dependsOnEpicIds: [] },
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    vi.spyOn(BacklogService.prototype, "list").mockResolvedValue({
      epics: [],
      items: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createDeveloperToolsCli().parseAsync(["current-context", "view", "--epic", "E-012"], {
      from: "user",
    });

    expect(logSpy).toHaveBeenCalledWith(`{
  "epic": {
    "id": "E-012",
    "title": "Checkout",
    "kind": "product",
    "developmentScopes": [],
    "status": "in-progress",
    "notes": [],
    "visibility": {
      "type": "always-visible",
      "dependsOnEpicIds": []
    },
    "acceptanceTestIds": [],
    "updatedAt": "2026-03-04T00:00:00.000Z"
  },
  "items": []
}`);
  });

  it("gatekeeper result save forwards lastExecutionNote and actor", async () => {
    const addResultSpy = vi.spyOn(AcceptanceTestService.prototype, "addResult").mockResolvedValue({
      resultId: "ATR-20260304-001",
      testId: "AT-001",
      executedAt: "2026-03-04T00:00:00.000Z",
      executor: "gatekeeper-1",
      status: "passed",
      summary: "ok",
    });

    await createGatekeeperToolsCli().parseAsync(
      [
        "--actor-id",
        "gatekeeper-1",
        "result",
        "save",
        "--id",
        "AT-001",
        "--status",
        "passed",
        "--summary",
        "ok",
        "--last-execution-note",
        "run 2026-03-04",
      ],
      { from: "user" },
    );

    expect(addResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        testId: "AT-001",
        status: "passed",
        lastExecutionNote: "run 2026-03-04",
        executor: "gatekeeper-1",
      }),
    );
  });

  it("reviewer current-context view prints only review data fields", async () => {
    vi.spyOn(BacklogService.prototype, "readEpic").mockResolvedValue({
      id: "E-012",
      title: "Checkout",
      kind: "product",
      developmentScopes: [],
      status: "done",
      notes: [],
      visibility: { type: "always-visible", dependsOnEpicIds: [] },
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    vi.spyOn(BacklogService.prototype, "list").mockResolvedValue({
      epics: [],
      items: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createReviewerToolsCli().parseAsync(["current-context", "view", "--epic", "E-012"], {
      from: "user",
    });

    expect(logSpy).toHaveBeenCalledWith(`{
  "epic": {
    "id": "E-012",
    "title": "Checkout",
    "kind": "product",
    "developmentScopes": [],
    "status": "done",
    "notes": [],
    "visibility": {
      "type": "always-visible",
      "dependsOnEpicIds": []
    },
    "acceptanceTestIds": [],
    "updatedAt": "2026-03-04T00:00:00.000Z"
  },
  "items": []
}`);
  });

  it("reviewer changes-requested validates rationale shape", async () => {
    await expect(
      createReviewerToolsCli().parseAsync(
        ["decision", "changes-requested", "--epic", "E-012", "--rationale", "Repro: ... only"],
        { from: "user" },
      ),
    ).rejects.toThrow("--rationale must include these elements");
  });

  it("reviewer changes-requested updates epic on valid rationale", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateEpic").mockResolvedValue({
      id: "E-012",
      title: "Checkout",
      kind: "product",
      developmentScopes: [],
      status: "changes-requested",
      notes: [{ id: "N-001", content: "Repro: ... Expected: ... Cause: ... Fix: ...", createdAt: "2026-03-04T00:00:00.000Z" }],
      visibility: { type: "always-visible", dependsOnEpicIds: [] },
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createReviewerToolsCli().parseAsync(
      [
        "decision",
        "changes-requested",
        "--epic",
        "E-012",
        "--rationale",
        "Repro: ... Expected: ... Cause: ... Fix: ...",
      ],
      { from: "user" },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "E-012",
        status: "changes-requested",
      }),
    );
  });

  it("polisher item view reads and prints item summary", async () => {
    const readSpy = vi.spyOn(BacklogService.prototype, "readItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Implement",
      kind: "technical",
      notes: [{ id: "N-003", content: "polisher note", createdAt: "2026-03-04T00:00:00.000Z" }],
      status: "todo",
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createPolisherToolsCli().parseAsync(["item", "view", "--id", "I-104"], {
      from: "user",
    });

    expect(readSpy).toHaveBeenCalledWith({ id: "I-104" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("I-104 (E-012) | todo | Implement"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("polisher note"));
  });

  it("polisher epic add-note appends a note", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateEpic").mockResolvedValue({
      id: "E-012",
      title: "Checkout",
      kind: "product",
      developmentScopes: [],
      status: "in-review",
      notes: [{ id: "N-201", content: "Homepage hero still feels visually dense on tablet", createdAt: "2026-03-04T00:00:00.000Z" }],
      visibility: { type: "always-visible", dependsOnEpicIds: [] },
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createPolisherToolsCli().parseAsync(
      ["epic", "add-note", "--id", "E-012", "--note", "Homepage hero still feels visually dense on tablet"],
      { from: "user" },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "E-012",
        addNotes: ["Homepage hero still feels visually dense on tablet"],
      }),
    );
  });

  it("polisher item add-note appends a note", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Implement",
      kind: "technical",
      notes: [{ id: "N-202", content: "Simplified CTA hierarchy for readability", createdAt: "2026-03-04T00:00:00.000Z" }],
      status: "todo",
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createPolisherToolsCli().parseAsync(
      ["item", "add-note", "--id", "I-104", "--note", "Simplified CTA hierarchy for readability"],
      { from: "user" },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "I-104",
        addNotes: ["Simplified CTA hierarchy for readability"],
      }),
    );
  });

  it("reviewer item view reads and prints item summary", async () => {
    const readSpy = vi.spyOn(BacklogService.prototype, "readItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Implement",
      kind: "technical",
      notes: [{ id: "N-004", content: "reviewer note", createdAt: "2026-03-04T00:00:00.000Z" }],
      status: "todo",
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createReviewerToolsCli().parseAsync(["item", "view", "--id", "I-104"], {
      from: "user",
    });

    expect(readSpy).toHaveBeenCalledWith({ id: "I-104" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("I-104 (E-012) | todo | Implement"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("reviewer note"));
  });

  it("reviewer epic add-note appends a note", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateEpic").mockResolvedValue({
      id: "E-012",
      title: "Checkout",
      kind: "product",
      developmentScopes: [],
      status: "in-review",
      notes: [{ id: "N-301", content: "Observed borderline mobile overflow in Safari", createdAt: "2026-03-04T00:00:00.000Z" }],
      visibility: { type: "always-visible", dependsOnEpicIds: [] },
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createReviewerToolsCli().parseAsync(
      ["epic", "add-note", "--id", "E-012", "--note", "Observed borderline mobile overflow in Safari"],
      { from: "user" },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "E-012",
        addNotes: ["Observed borderline mobile overflow in Safari"],
      }),
    );
  });

  it("reviewer item add-note appends a note", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Implement",
      kind: "technical",
      notes: [{ id: "N-302", content: "Need a regression check for empty-state rendering", createdAt: "2026-03-04T00:00:00.000Z" }],
      status: "todo",
      acceptanceTestIds: [],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    await createReviewerToolsCli().parseAsync(
      ["item", "add-note", "--id", "I-104", "--note", "Need a regression check for empty-state rendering"],
      { from: "user" },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "I-104",
        addNotes: ["Need a regression check for empty-state rendering"],
      }),
    );
  });

  it("prints markdown-oriented manuals via --help", async () => {
    const command = createDeveloperToolsCli();
    let output = "";

    command
      .exitOverride()
      .configureOutput({
        writeOut: (line) => {
          output += line;
        },
        writeErr: (line) => {
          output += line;
        },
      });

    await expect(command.parseAsync(["--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("Developer Tools Manual");
    expect(output).toContain("## Purpose");
    expect(output).toContain("## Subcommands");
    expect(output).toContain("## Typical Examples");
    expect(output).toContain("epic add-note --id <E-xxx> --note <text>");
    expect(output).toContain("item add-note --id <I-xxx> --note <text>");
    expect(output).not.toContain("item note --id <I-xxx> --note <text>");
  });

  it("rejects deprecated --dry-run option", async () => {
    await expect(
      createDeveloperToolsCli().parseAsync(["--dry-run", "item", "start", "--id", "I-104"], {
        from: "user",
      }),
    ).rejects.toBeDefined();
  });
});
