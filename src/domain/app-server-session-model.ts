export type AppServerSessionStatus = "disconnected" | "initializing" | "ready" | "error";

export interface AppServerSession {
  agentId: string;
  status: AppServerSessionStatus;
  initialized: boolean;
  threadId?: string | null;
  activeTurnId?: string | null;
  lastNotificationAt: string;
  lastError?: string;
}

export interface AppServerSessionCollection {
  version: number;
  updatedAt: string;
  sessions: AppServerSession[];
}
