import { describe, expect, it, vi } from "vitest";
import { createSupervisorCommand } from "../src/cli/commands/supervisor.js";

describe("supervisor loader propagation", () => {
  it("passes foreground startup args to runner while command is created in test process", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const command = createSupervisorCommand({
      loadConfig: async () => ({ configPath: "/tmp/supervisor.json", fleets: ["/tmp/a"] }),
      runFleetCommand: async (input) => {
        calls.push(input);
        return {
          cwd: input.cwd,
          args: input.args,
          ok: true,
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
        };
      },
    });

    await command.parseAsync(["up"], { from: "user" });

    expect(calls[0]?.args).toEqual(["up", "--skip-startup-preflight"]);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
