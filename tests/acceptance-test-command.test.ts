import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcceptanceTestCli } from "../src/cli/codefleet-acceptance-test.js";
import { AcceptanceTestService } from "../src/domain/acceptance/acceptance-test-service.js";

describe("acceptance-test command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints role-specific guidance with --help-for-agent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createAcceptanceTestCli().parseAsync(["--help-for-agent"], { from: "user" });

    const output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Orchestrator");
    expect(output).toContain("Developer");
    expect(output).toContain("Gatekeeper");
    expect(output).toContain("codefleet-acceptance-test result add");
  });

  it("clears all data when --yes is specified", async () => {
    const clearSpy = vi.spyOn(AcceptanceTestService.prototype, "clearAllData").mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createAcceptanceTestCli().parseAsync(["clear", "--yes"], { from: "user" });

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("cleared all acceptance-test data.");
  });

  it("requires --yes in non-interactive environments", async () => {
    await expect(createAcceptanceTestCli().parseAsync(["clear"], { from: "user" })).rejects.toThrow(
      "clear requires an interactive terminal confirmation. Use --yes to skip confirmation.",
    );
  });

  it("prints table with list --format=table", async () => {
    vi.spyOn(AcceptanceTestService.prototype, "list").mockResolvedValue([
      {
        id: "AT-001",
        title: "Login works",
        notes: [],
        status: "ready",
        lastExecutionStatus: "passed",
        epicIds: ["E-001"],
        itemIds: ["I-001", "I-002"],
        updatedAt: "2026-02-12T00:00:00.000Z",
      },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createAcceptanceTestCli().parseAsync(["list", "--format=table"], { from: "user" });

    const output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("ID");
    expect(output).toContain("Last Execution");
    expect(output).toContain("AT-001");
    expect(output).toContain("Login works");
    expect(output).toContain("E-001");
    expect(output).toContain("I-001, I-002");
  });

  it("updates lastExecutionStatus cache for all tests", async () => {
    const healSpy = vi.spyOn(AcceptanceTestService.prototype, "selfHealLastExecutionStatus").mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createAcceptanceTestCli().parseAsync(["update-last-execution-status-all"], { from: "user" });

    expect(healSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("updated lastExecutionStatus for all acceptance tests from results.");
  });

  it("manually updates lastExecutionStatus for all tests with --status", async () => {
    const updateSpy = vi.spyOn(AcceptanceTestService.prototype, "updateLastExecutionStatusAll").mockResolvedValue(undefined);
    const healSpy = vi.spyOn(AcceptanceTestService.prototype, "selfHealLastExecutionStatus").mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createAcceptanceTestCli().parseAsync(["update-last-execution-status-all", "--status", "failed"], { from: "user" });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith("failed");
    expect(healSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("updated lastExecutionStatus for all acceptance tests: failed");
  });

  it("rejects invalid --status for update-last-execution-status-all", async () => {
    await expect(
      createAcceptanceTestCli().parseAsync(["update-last-execution-status-all", "--status", "unknown"], { from: "user" }),
    ).rejects.toThrow("invalid --status: unknown. Expected one of: not-run, passed, failed");
  });
});
