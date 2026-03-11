import type { SystemEvent } from "../../events/router.js";
import type { AgentRole } from "../roles-model.js";

export interface RoleEventPromptDefinition {
  triggerEventType: SystemEvent["type"];
  promptEventType: string;
  emitEventType: SystemEvent["type"] | null;
}

export interface SubscribedEventDefinition {
  triggerEvent: string;
  emitEvent: SystemEvent["type"] | null;
}

export interface AgentRoleDefinition {
  role: AgentRole;
  // Map-like shape keeps "which event wakes this role" and
  // "which task prompt should be used" readable in one place.
  subscribedEvents: Readonly<Partial<Record<SystemEvent["type"], SubscribedEventDefinition>>>;
}

// Keep role behavior in one place so routing, prompts, and queueing policies
// evolve together instead of diverging across separate modules.
const AGENT_ROLE_DEFINITIONS: Record<AgentRole, AgentRoleDefinition> = {
  Orchestrator: {
    role: "Orchestrator",
    subscribedEvents: {
      "acceptance-test.update": {
        triggerEvent: "backlog.update",
        emitEvent: "backlog.update",
      },
    },
  },
  Curator: {
    role: "Curator",
    subscribedEvents: {
      "release-plan.create": {
        triggerEvent: "release-plan.create",
        emitEvent: "source-brief.update",
      },
    },
  },
  FrontendDeveloper: {
    role: "FrontendDeveloper",
    subscribedEvents: {
      "backlog.epic.frontend.ready": {
        triggerEvent: "implementation-frontend",
        emitEvent: "backlog.epic.frontend.completed",
      },
    },
  },
  Developer: {
    role: "Developer",
    subscribedEvents: {
      "backlog.epic.ready": {
        triggerEvent: "implementation",
        emitEvent: "backlog.epic.polish.ready",
      },
      "backlog.epic.frontend.completed": {
        triggerEvent: "implementation-after-frontend",
        emitEvent: "backlog.epic.polish.ready",
      },
    },
  },
  Polisher: {
    role: "Polisher",
    subscribedEvents: {
      "backlog.epic.polish.ready": {
        triggerEvent: "polishing",
        emitEvent: "backlog.epic.review.ready",
      },
    },
  },
  Reviewer: {
    role: "Reviewer",
    subscribedEvents: {
      "backlog.epic.review.ready": {
        triggerEvent: "review",
        emitEvent: null,
      },
      // Dedicated debug event allows validating Playwright execution capability
      // without coupling to backlog lifecycle transitions.
      "debug.playwright-test": {
        triggerEvent: "debug.playwright-test",
        emitEvent: null,
      },
    },
  },
  Gatekeeper: {
    role: "Gatekeeper",
    subscribedEvents: {
      "source-brief.update": {
        triggerEvent: "acceptance-test.update",
        emitEvent: "acceptance-test.update",
      },
      "acceptance-test.required": {
        triggerEvent: "acceptance-test.run",
        emitEvent: null,
      },
    },
  },
};

export function getAgentRoleDefinition(role: AgentRole): AgentRoleDefinition {
  return AGENT_ROLE_DEFINITIONS[role];
}

export function isRoleSubscribedToEvent(role: AgentRole, event: SystemEvent): boolean {
  return AGENT_ROLE_DEFINITIONS[role].subscribedEvents[event.type] !== undefined;
}

export function getRoleEventPromptDefinition(
  role: AgentRole,
  triggerEventType: SystemEvent["type"],
): RoleEventPromptDefinition {
  const roleDefinition = AGENT_ROLE_DEFINITIONS[role];
  const subscribedEvent = roleDefinition.subscribedEvents[triggerEventType];
  if (!subscribedEvent) {
    return {
      triggerEventType,
      promptEventType: triggerEventType,
      emitEventType: null,
    };
  }
  return {
    triggerEventType,
    promptEventType: subscribedEvent.triggerEvent,
    emitEventType: subscribedEvent.emitEvent,
  };
}
