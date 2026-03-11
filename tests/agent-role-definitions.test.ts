import { describe, expect, it } from "vitest";
import {
  getAgentRoleDefinition,
  getRoleEventPromptDefinition,
  isRoleSubscribedToEvent,
} from "../src/domain/fleet/agent-role-definitions.js";

describe("agent-role-definitions", () => {
  it("keeps event subscriptions by role", () => {
    expect(getAgentRoleDefinition("Orchestrator").role).toBe("Orchestrator");
    expect(getAgentRoleDefinition("Curator").role).toBe("Curator");
    expect(getAgentRoleDefinition("FrontendDeveloper").role).toBe("FrontendDeveloper");
    expect(getAgentRoleDefinition("Developer").role).toBe("Developer");
    expect(getAgentRoleDefinition("Polisher").role).toBe("Polisher");
    expect(getAgentRoleDefinition("Gatekeeper").role).toBe("Gatekeeper");
    expect(getAgentRoleDefinition("Reviewer").role).toBe("Reviewer");

    expect(
      isRoleSubscribedToEvent("Orchestrator", {
        type: "release-plan.create",
        path: ".codefleet/data/release-plan/01HXTEST0000000000000000.md",
      }),
    ).toBe(false);
    expect(
      isRoleSubscribedToEvent("Developer", {
        type: "release-plan.create",
        path: ".codefleet/data/release-plan/01HXTEST0000000000000000.md",
      }),
    ).toBe(false);
    expect(isRoleSubscribedToEvent("Developer", { type: "acceptance-test.update" })).toBe(false);
    expect(isRoleSubscribedToEvent("Developer", { type: "backlog.epic.ready" })).toBe(true);
    expect(isRoleSubscribedToEvent("FrontendDeveloper", { type: "backlog.epic.frontend.ready", epicId: "E-001" })).toBe(
      true,
    );
    expect(isRoleSubscribedToEvent("Developer", { type: "backlog.epic.frontend.completed", epicId: "E-001" })).toBe(
      true,
    );
    expect(isRoleSubscribedToEvent("Polisher", { type: "backlog.epic.polish.ready", epicId: "E-001" })).toBe(true);
    expect(isRoleSubscribedToEvent("Reviewer", { type: "backlog.epic.review.ready", epicId: "E-001" })).toBe(true);
    expect(isRoleSubscribedToEvent("Reviewer", { type: "debug.playwright-test" })).toBe(true);
    expect(isRoleSubscribedToEvent("Orchestrator", { type: "acceptance-test.update" })).toBe(true);
    expect(
      isRoleSubscribedToEvent("Orchestrator", {
        type: "feedback-note.create",
        path: ".codefleet/data/feedback-notes/01HXTEST0000000000000000.md",
      }),
    ).toBe(false);
    expect(isRoleSubscribedToEvent("Orchestrator", { type: "backlog.update" })).toBe(false);
    expect(
      isRoleSubscribedToEvent("Curator", {
        type: "release-plan.create",
        path: ".codefleet/data/release-plan/01HXTEST0000000000000000.md",
      }),
    ).toBe(true);
    expect(
      isRoleSubscribedToEvent("Gatekeeper", {
        type: "source-brief.update",
        briefPath: ".codefleet/data/source-brief/latest.md",
        sourcePaths: ["docs/a.md"],
      }),
    ).toBe(true);
  });

  it("maps trigger events to role task prompts", () => {
    const curator = getAgentRoleDefinition("Curator");
    const curatorMapped = curator.subscribedEvents["release-plan.create"];
    expect(curatorMapped?.triggerEvent).toBe("release-plan.create");

    const curatorPrompt = getRoleEventPromptDefinition("Curator", "release-plan.create");
    expect(curatorPrompt.promptEventType).toBe("release-plan.create");
    expect(curatorPrompt.emitEventType).toBe("source-brief.update");

    const gatekeeper = getAgentRoleDefinition("Gatekeeper");
    const mapped = gatekeeper.subscribedEvents["source-brief.update"];
    expect(mapped?.triggerEvent).toBe("acceptance-test.update");

    const gatekeeperPrompt = getRoleEventPromptDefinition("Gatekeeper", "source-brief.update");
    expect(gatekeeperPrompt.promptEventType).toBe("acceptance-test.update");
    expect(gatekeeperPrompt.emitEventType).toBe("acceptance-test.update");

    const orchestratorPrompt = getRoleEventPromptDefinition("Orchestrator", "acceptance-test.update");
    expect(orchestratorPrompt.promptEventType).toBe("backlog.update");
    expect(orchestratorPrompt.emitEventType).toBe("backlog.update");

    const orchestratorFeedbackPrompt = getRoleEventPromptDefinition("Orchestrator", "feedback-note.create");
    expect(orchestratorFeedbackPrompt.promptEventType).toBe("feedback-note.create");
    expect(orchestratorFeedbackPrompt.emitEventType).toBeNull();

    const defaultPrompt = getRoleEventPromptDefinition("Developer", "release-plan.create");
    expect(defaultPrompt.promptEventType).toBe("release-plan.create");
    expect(defaultPrompt.emitEventType).toBeNull();

    const frontendPrompt = getRoleEventPromptDefinition("FrontendDeveloper", "backlog.epic.frontend.ready");
    expect(frontendPrompt.promptEventType).toBe("implementation-frontend");
    expect(frontendPrompt.emitEventType).toBe("backlog.epic.frontend.completed");

    const developerPrompt = getRoleEventPromptDefinition("Developer", "backlog.epic.ready");
    expect(developerPrompt.promptEventType).toBe("implementation");
    expect(developerPrompt.emitEventType).toBe("backlog.epic.polish.ready");

    const developerHandoffPrompt = getRoleEventPromptDefinition("Developer", "backlog.epic.frontend.completed");
    expect(developerHandoffPrompt.promptEventType).toBe("implementation-after-frontend");
    expect(developerHandoffPrompt.emitEventType).toBe("backlog.epic.polish.ready");

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
