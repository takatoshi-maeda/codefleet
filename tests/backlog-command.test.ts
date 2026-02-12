import { afterEach, describe, expect, it, vi } from "vitest";
import { createBacklogCli } from "../src/cli/codefleet-backlog.js";

describe("backlog command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints role-specific guidance with --help-for-agent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createBacklogCli().parseAsync(["--help-for-agent"], { from: "user" });

    const output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Orchestrator");
    expect(output).toContain("Developer");
    expect(output).toContain("Gatekeeper");
    expect(output).toContain("codefleet-backlog epic add");
    expect(output).toContain("codefleet-backlog item update");
    expect(output).not.toContain("codefleet codefleet-backlog");
  });
});
