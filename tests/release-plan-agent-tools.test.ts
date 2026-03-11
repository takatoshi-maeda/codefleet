import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReleasePlanAgentTools } from "../src/agents/tools/release-plan-agent-tools.js";

describe("release plan agent tools", () => {
  it("creates a release plan and lists it from storage", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-release-plans-"));
    const tools = createReleasePlanAgentTools(tempDir);
    const createTool = tools.find((tool) => tool.name === "release_plan_create");
    const listTool = tools.find((tool) => tool.name === "release_plan_list");

    const createResult = (await createTool?.execute?.({
      title: "Improve CLI review flow",
      summary: "Refine review output and reduce noisy logs.",
      details: "Adjust renderer defaults and preserve actionable findings first.",
      sourceRefs: ["docs/spec/review.md", "README.md"],
      reporter: "test-user",
    })) as {
      releasePlan?: { id: string; title: string; sourceRefs: string[] };
      path?: string;
    };

    expect(createResult.releasePlan?.id).toBeTruthy();
    expect(createResult.releasePlan?.title).toBe("Improve CLI review flow");
    expect(createResult.releasePlan?.sourceRefs).toEqual(["docs/spec/review.md", "README.md"]);
    expect(createResult.path?.endsWith(".md")).toBe(true);

    const listResult = (await listTool?.execute?.({ limit: 10 })) as {
      releasePlans?: Array<{ title: string; reporter: string | null }>;
      count?: number;
    };
    expect(listResult.count).toBe(1);
    expect(listResult.releasePlans?.[0]?.title).toBe("Improve CLI review flow");
    expect(listResult.releasePlans?.[0]?.reporter).toBe("test-user");
  });

  it("publishes release-plan.create after creating a release plan", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-release-plans-"));
    const publishReleasePlanCreated = vi.fn(async () => ({ enqueuedAgentIds: ["curator-1"] }));
    const tools = createReleasePlanAgentTools({
      releasePlansDir: path.join(tempDir, ".codefleet/data/release-plan"),
      projectRootDir: tempDir,
      eventPublisher: {
        publishReleasePlanCreated,
      },
    });
    const createTool = tools.find((tool) => tool.name === "release_plan_create");

    const createResult = (await createTool?.execute?.({
      title: "Plan A",
      summary: "Summarize requested changes.",
      details: "Capture references and outcome expectations.",
    })) as {
      event?: { type: string; path: string; status: string; enqueuedAgentIds?: string[] } | null;
    };

    expect(publishReleasePlanCreated).toHaveBeenCalledTimes(1);
    expect(publishReleasePlanCreated.mock.calls[0]?.[0]).toMatch(
      /^\.codefleet\/data\/release-plan\/[0-9A-HJKMNP-TV-Z]{26}\.md$/u,
    );
    expect(createResult.event).toEqual({
      type: "release-plan.create",
      path: expect.stringMatching(/^\.codefleet\/data\/release-plan\/[0-9A-HJKMNP-TV-Z]{26}\.md$/u),
      status: "enqueued",
      enqueuedAgentIds: ["curator-1"],
    });
  });
});
