import { describe, expect, it, vi } from "vitest";
import { assertDockerContainerEnvironment, isRunningInDockerContainer } from "../src/cli/commands/fleetctl.js";

describe("docker environment checks for fleetctl up", () => {
  it("detects docker by /.dockerenv", async () => {
    const detected = await isRunningInDockerContainer({
      fileExists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn(),
    });

    expect(detected).toBe(true);
  });

  it("detects docker from cgroup markers when /.dockerenv is absent", async () => {
    const detected = await isRunningInDockerContainer({
      fileExists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn().mockResolvedValue("12:memory:/docker/abcdef0123456789"),
    });

    expect(detected).toBe(true);
  });

  it("returns false when no docker marker is present", async () => {
    const detected = await isRunningInDockerContainer({
      fileExists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn().mockResolvedValue("12:memory:/user.slice"),
    });

    expect(detected).toBe(false);
  });

  it("throws in non-docker environments", async () => {
    await expect(
      assertDockerContainerEnvironment({
        fileExists: vi.fn().mockResolvedValue(false),
        readFile: vi.fn().mockResolvedValue("12:memory:/user.slice"),
      }),
    ).rejects.toThrow("fleet up requires running inside a Docker container.");
  });
});
