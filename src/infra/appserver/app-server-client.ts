import type { AppServerSession } from "../../domain/app-server-session-model.js";

export class AppServerClient {
  async handshake(agentId: string): Promise<Pick<AppServerSession, "threadId" | "activeTurnId" | "lastNotificationAt">> {
    // Simulate initialize -> initialized handshake.
    await Promise.resolve();

    const now = new Date().toISOString();
    return {
      threadId: `${agentId}-thread`,
      activeTurnId: `${agentId}-turn-1`,
      lastNotificationAt: now,
    };
  }
}
