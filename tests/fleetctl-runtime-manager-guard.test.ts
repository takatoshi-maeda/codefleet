import { describe, expect, it, vi } from "vitest";
import { ensureNoConflictingRuntimeManagerIsRunning } from "../src/cli/commands/fleetctl.js";

describe("fleetctl runtime manager guard", () => {
  it("allows startup when no pid file exists", async () => {
    await expect(
      ensureNoConflictingRuntimeManagerIsRunning({
        readPid: async () => null,
      }),
    ).resolves.toBeUndefined();
  });

  it("removes stale pid file when process is not alive", async () => {
    const removePidFile = vi.fn(async () => undefined);
    await expect(
      ensureNoConflictingRuntimeManagerIsRunning({
        readPid: async () => 12345,
        isAlive: () => false,
        removePidFile,
      }),
    ).resolves.toBeUndefined();
    expect(removePidFile).toHaveBeenCalledTimes(1);
  });

  it("rejects startup when another runtime manager is alive", async () => {
    await expect(
      ensureNoConflictingRuntimeManagerIsRunning({
        readPid: async () => 12345,
        isAlive: () => true,
      }),
    ).rejects.toThrow(/another agent runtime manager is already running/);
  });
});

