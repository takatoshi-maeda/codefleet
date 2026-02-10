import { spawn } from "node:child_process";

export interface FleetProcessStartResult {
  pid: number | null;
  startedAt: string;
}

export class FleetProcessManager {
  async start(agentId: string, cwd: string, detached: boolean): Promise<FleetProcessStartResult> {
    const child = spawn(process.execPath, ["-e", `setInterval(() => {}, 1 << 30); // ${agentId}`], {
      cwd,
      detached,
      stdio: "ignore",
    });

    if (detached) {
      child.unref();
    }

    return {
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
    };
  }

  async stop(pid: number | null): Promise<void> {
    if (!pid) {
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ESRCH") {
        throw error;
      }
    }
  }
}
