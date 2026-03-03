import { describe, expect, it } from "vitest";
import {
  getAgentRoleDefinition,
  getRoleEventPromptDefinition,
  isRoleSubscribedToEvent,
} from "../src/domain/fleet/agent-role-definitions.js";

describe("agent-role-definitions", () => {
  it("keeps event subscriptions by role", () => {
    expect(getAgentRoleDefinition("Orchestrator").role).toBe("Orchestrator");
    expect(getAgentRoleDefinition("Developer").role).toBe("Developer");
    expect(getAgentRoleDefinition("Polisher").role).toBe("Polisher");
    expect(getAgentRoleDefinition("Gatekeeper").role).toBe("Gatekeeper");
    expect(getAgentRoleDefinition("Reviewer").role).toBe("Reviewer");

    expect(isRoleSubscribedToEvent("Orchestrator", { type: "docs.update", paths: ["docs/a.md"] })).toBe(false);
    expect(isRoleSubscribedToEvent("Developer", { type: "docs.update", paths: ["docs/a.md"] })).toBe(false);
    expect(isRoleSubscribedToEvent("Developer", { type: "acceptance-test.update" })).toBe(false);
    expect(isRoleSubscribedToEvent("Developer", { type: "backlog.epic.ready" })).toBe(true);
    expect(isRoleSubscribedToEvent("Polisher", { type: "backlog.epic.polish.ready", epicId: "E-001" })).toBe(true);
    expect(isRoleSubscribedToEvent("Reviewer", { type: "backlog.epic.review.ready", epicId: "E-001" })).toBe(true);
    expect(isRoleSubscribedToEvent("Reviewer", { type: "debug.playwright-test" })).toBe(true);
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
    expect(gatekeeperPrompt.emitEventType).toBe("acceptance-test.update");

    const orchestratorPrompt = getRoleEventPromptDefinition("Orchestrator", "acceptance-test.update");
    expect(orchestratorPrompt.promptEventType).toBe("backlog.update");
    expect(orchestratorPrompt.emitEventType).toBe("backlog.update");

    const defaultPrompt = getRoleEventPromptDefinition("Developer", "docs.update");
    expect(defaultPrompt.promptEventType).toBe("docs.update");
    expect(defaultPrompt.emitEventType).toBeNull();

    const developerPrompt = getRoleEventPromptDefinition("Developer", "backlog.epic.ready");
    expect(developerPrompt.promptEventType).toBe("implementation");
    expect(developerPrompt.emitEventType).toBe("backlog.epic.polish.ready");

    const polisherPrompt = getRoleEventPromptDefinition("Polisher", "backlog.epic.polish.ready");
    expect(polisherPrompt.promptEventType).toBe("polishing");
    expect(polisherPrompt.emitEventType).toBe("backlog.epic.review.ready");

    const reviewerPrompt = getRoleEventPromptDefinition("Reviewer", "backlog.epic.review.ready");
    expect(reviewerPrompt.promptEventType).toBe("review");
    expect(reviewerPrompt.emitEventType).toBeNull();

    const reviewerDebugPrompt = getRoleEventPromptDefinition("Reviewer", "debug.playwright-test");
    expect(reviewerDebugPrompt.promptEventType).toBe("debug.playwright-test");
    expect(reviewerDebugPrompt.emitEventType).toBeNull();
  });
});
