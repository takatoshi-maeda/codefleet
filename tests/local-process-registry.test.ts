import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalProcessRegistry,
  extractProjectIdFromGitRemote,
  resolveProjectIdFromGitRemote,
} from "../src/domain/fleet/local-process-registry.js";

describe("local-process-registry", () => {
  it("extracts projectId from SSH and HTTPS origin URLs", () => {
    expect(extractProjectIdFromGitRemote("git@github.com:acme/codefleet.git")).toBe("acme/codefleet");
    expect(extractProjectIdFromGitRemote("ssh://git@github.com/acme/codefleet.git")).toBe("acme/codefleet");
    expect(extractProjectIdFromGitRemote("https://github.com/acme/codefleet.git")).toBe("acme/codefleet");
    expect(extractProjectIdFromGitRemote("https://github.com/acme/codefleet")).toBe("acme/codefleet");
  });

  it("falls back to directory name when git remote origin is not available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-projectid-"));
    const workspaceDir = path.join(tempDir, "workspace-alpha");
    await fs.mkdir(workspaceDir, { recursive: true });

    await expect(resolveProjectIdFromGitRemote(workspaceDir)).resolves.toBe("workspace-alpha");
  });

  it("discovers only live peer processes with matching projectId", async () => {
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-registry-"));
    const registry = new LocalProcessRegistry({
      registryDir,
      processId: 111,
      resolveProjectId: async () => "acme/codefleet",
      heartbeatTimeoutMs: 10_000,
      isProcessAlive: (pid) => pid !== 333,
    });
    await registry.register({
      host: "127.0.0.1",
      port: 3290,
      startedAt: "2026-03-05T00:00:00.000Z",
    });

    const now = new Date().toISOString();
    const old = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(
      path.join(registryDir, "222.json"),
      JSON.stringify({
        instanceId: "cf-live",
        pid: 222,
        projectId: "acme/codefleet",
        host: "127.0.0.1",
        port: 3291,
        startedAt: now,
        lastHeartbeat: now,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(registryDir, "333.json"),
      JSON.stringify({
        instanceId: "cf-stale",
        pid: 333,
        projectId: "acme/codefleet",
        host: "127.0.0.1",
        port: 3292,
        startedAt: now,
        lastHeartbeat: old,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(registryDir, "444.json"),
      JSON.stringify({
        instanceId: "cf-other-project",
        pid: 444,
        projectId: "other/repo",
        host: "127.0.0.1",
        port: 3293,
        startedAt: now,
        lastHeartbeat: now,
      }),
      "utf8",
    );
    await fs.writeFile(path.join(registryDir, "invalid.json"), "{broken json", "utf8");

    const discovered = await registry.discover();
    expect(discovered).toEqual([
      expect.objectContaining({
        pid: 222,
        projectId: "acme/codefleet",
        host: "127.0.0.1",
        port: 3291,
      }),
    ]);

    await expect(fs.stat(path.join(registryDir, "333.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(registryDir, "invalid.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
