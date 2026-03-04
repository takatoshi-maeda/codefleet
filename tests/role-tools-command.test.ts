import { describe, expect, it, vi, afterEach } from "vitest";
import { AcceptanceTestService } from "../src/domain/acceptance/acceptance-test-service.js";
import { BacklogService } from "../src/domain/backlog/backlog-service.js";
import { createDeveloperToolsCli } from "../src/cli/codefleet-developer-tools.js";
import { createGatekeeperToolsCli } from "../src/cli/codefleet-gatekeeper-tools.js";
import { createOrchestratorToolsCli } from "../src/cli/codefleet-orchestrator-tools.js";
import { createReviewerToolsCli } from "../src/cli/codefleet-reviewer-tools.js";

describe("role tools commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("orchestrator requirements update writes text", async () => {
    const writeSpy = vi.spyOn(BacklogService.prototype, "writeRequirements").mockResolvedValue("next requirements");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createOrchestratorToolsCli().parseAsync(["requirements", "update", "--text", "next requirements"], {
      from: "user",
    });

    expect(writeSpy).toHaveBeenCalledWith("next requirements");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Requirements Updated"));
  });

  it("developer item start updates status and note", async () => {
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateItem").mockResolvedValue({
      id: "I-104",
      epicId: "E-012",
      title: "Implement",
      kind: "technical",
      notes: ["start"],
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
      status: "changes-requested",
      notes: ["Repro: ... Expected: ... Cause: ... Fix: ..."],
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
  });
});
