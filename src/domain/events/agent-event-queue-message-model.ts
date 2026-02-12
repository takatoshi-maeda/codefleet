import type { SystemEvent } from "../../events/router.js";

export interface AgentEventDelivery {
  promptFile?: string;
}

export interface AgentEventQueueMessage {
  id: string;
  createdAt: string;
  agentId: string;
  event: SystemEvent;
  delivery: AgentEventDelivery;
  source: {
    command: string;
  };
}
