import { describe, expect, it } from "vitest";
import {
  getAgentRoleDefinition,
  getRoleEventPromptDefinition,
  isRoleSubscribedToEvent,
} from "../src/domain/agents/agent-role-definitions.js";

describe("agent-role-definitions", () => {
  it("keeps event subscriptions by role", () => {
    expect(getAgentRoleDefinition("Orchestrator").role).toBe("Orchestrator");
    expect(getAgentRoleDefinition("Developer").role).toBe("Developer");
    expect(getAgentRoleDefinition("Gatekeeper").role).toBe("Gatekeeper");

    expect(isRoleSubscribedToEvent("Orchestrator", { type: "docs.update", paths: ["docs/a.md"] })).toBe(false);
    expect(isRoleSubscribedToEvent("Developer", { type: "docs.update", paths: ["docs/a.md"] })).toBe(false);
    expect(isRoleSubscribedToEvent("Developer", { type: "acceptance-test.update" })).toBe(false);
    expect(isRoleSubscribedToEvent("Orchestrator", { type: "acceptance-test.update" })).toBe(true);
    expect(isRoleSubscribedToEvent("Orchestrator", { type: "backlog.update" })).toBe(false);
    expect(isRoleSubscribedToEvent("Gatekeeper", { type: "docs.update", paths: ["docs/a.md"] })).toBe(true);
  });

  it("maps trigger events to role task prompts", () => {
    const gatekeeper = getAgentRoleDefinition("Gatekeeper");
    const mapped = gatekeeper.subscribedEvents["docs.update"];
    expect(mapped?.triggerEvent).toBe("acceptance-test.update");

    const gatekeeperPrompt = getRoleEventPromptDefinition("Gatekeeper", "docs.update");
    expect(gatekeeperPrompt.promptEventType).toBe("acceptance-test.update");

    const orchestratorPrompt = getRoleEventPromptDefinition("Orchestrator", "acceptance-test.update");
    expect(orchestratorPrompt.promptEventType).toBe("backlog.update");

    const defaultPrompt = getRoleEventPromptDefinition("Developer", "docs.update");
    expect(defaultPrompt.promptEventType).toBe("docs.update");
  });
});
