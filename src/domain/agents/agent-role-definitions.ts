import type { SystemEvent } from "../../events/router.js";
import type { AgentEventDelivery } from "../events/agent-event-queue-message-model.js";
import type { AgentRole } from "../roles-model.js";

export interface AgentRoleDefinition {
  role: AgentRole;
  startupPromptFile: string;
  subscribedEvents: ReadonlySet<SystemEvent["type"]>;
  eventDeliveryPolicy: Readonly<Partial<Record<SystemEvent["type"], AgentEventDeliveryPolicy>>>;
}

interface AgentEventDeliveryPolicy {
  promptFile?: string;
}

// Keep role behavior in one place so routing, prompts, and queueing policies
// evolve together instead of diverging across separate modules.
const AGENT_ROLE_DEFINITIONS: Record<AgentRole, AgentRoleDefinition> = {
  Orchestrator: {
    role: "Orchestrator",
    startupPromptFile: "orchestrator-startup.md",
    subscribedEvents: new Set([]),
    eventDeliveryPolicy: {},
  },
  Developer: {
    role: "Developer",
    startupPromptFile: "developer-startup.md",
    subscribedEvents: new Set([]),
    eventDeliveryPolicy: {},
  },
  Gatekeeper: {
    role: "Gatekeeper",
    startupPromptFile: "gatekeeper-startup.md",
    subscribedEvents: new Set(["docs.update"]),
    // Event-specific prompt selection stays in role policy so additional events
    // can be introduced without changing queueing and dispatch infrastructure.
    eventDeliveryPolicy: {
      "docs.update": {
        promptFile: "gatekeeper/docs.event.md",
      },
    },
  },
};

export function getAgentRoleDefinition(role: AgentRole): AgentRoleDefinition {
  return AGENT_ROLE_DEFINITIONS[role];
}

export function isRoleSubscribedToEvent(role: AgentRole, event: SystemEvent): boolean {
  return AGENT_ROLE_DEFINITIONS[role].subscribedEvents.has(event.type);
}

export function getRoleEventDelivery(role: AgentRole, event: SystemEvent): AgentEventDelivery {
  const policy = AGENT_ROLE_DEFINITIONS[role].eventDeliveryPolicy[event.type];
  return policy ? { promptFile: policy.promptFile } : {};
}
