import { describe, expect, it } from "vitest";
import { getAgentRoleDefinition, isRoleSubscribedToEvent } from "../src/domain/agents/agent-role-definitions.js";

describe("agent-role-definitions", () => {
  it("keeps startup prompt path and event subscriptions by role", () => {
    expect(getAgentRoleDefinition("Orchestrator").startupPromptFile).toBe("orchestrator-startup.md");
    expect(getAgentRoleDefinition("Developer").startupPromptFile).toBe("developer-startup.md");
    expect(getAgentRoleDefinition("Gatekeeper").startupPromptFile).toBe("gatekeeper-startup.md");

    expect(isRoleSubscribedToEvent("Orchestrator", { type: "docs.update", paths: ["docs/a.md"] })).toBe(false);
    expect(isRoleSubscribedToEvent("Developer", { type: "docs.update", paths: ["docs/a.md"] })).toBe(false);
    expect(isRoleSubscribedToEvent("Gatekeeper", { type: "docs.update", paths: ["docs/a.md"] })).toBe(true);
  });
});
