import { AppServerClient } from "../appserver/app-server-client.js";
import type {
  ExecuteRoleAgentInput,
  ExecuteRoleAgentResult,
  PrepareRoleAgentInput,
  PrepareRoleAgentResult,
  RoleAgentRuntime,
} from "../../domain/fleet/role-agent-runtime.js";

export class CodexAppServerRuntime implements RoleAgentRuntime {
  readonly provider = "codex-app-server" as const;

  constructor(private readonly appServerClient: AppServerClient = new AppServerClient()) {}

  async prepareAgent(input: PrepareRoleAgentInput): Promise<PrepareRoleAgentResult> {
    const started = await this.appServerClient.startAgent({
      agentId: input.agentId,
      role: input.role,
      prompt: input.startupPrompt,
      cwd: input.cwd,
      detached: input.detached,
      playwrightServerUrl: input.playwrightServerUrl,
      codexConfig: input.runtimeConfig,
    });
    const handshake = await this.appServerClient.handshake(input.agentId);

    return {
      provider: this.provider,
      pid: started.pid,
      startedAt: started.startedAt,
      session: {
        conversationId: handshake.threadId ?? null,
        activeInvocationId: handshake.activeTurnId ?? null,
        lastActivityAt: handshake.lastNotificationAt,
      },
    };
  }

  async execute(input: ExecuteRoleAgentInput): Promise<ExecuteRoleAgentResult> {
    const startedThread = await this.appServerClient.startThread(input.agentId, {
      baseInstructions: buildThreadLanguageInstruction(input.responseLanguage),
      codexConfig: input.runtimeConfig,
    });
    const startedTurn = await this.appServerClient.startTurn(input.agentId, {
      threadId: startedThread.threadId,
      input: [{ type: "text", text: input.prompt }],
    });
    if (startedTurn.turnId) {
      await this.appServerClient.waitForTurnCompletion(input.agentId, startedThread.threadId, startedTurn.turnId);
    }

    return {
      provider: this.provider,
      session: {
        conversationId: startedThread.threadId,
        activeInvocationId: startedTurn.turnId,
        lastActivityAt: startedTurn.lastNotificationAt,
      },
    };
  }

  async shutdownAgent(agentId: string): Promise<void> {
    await this.appServerClient.shutdownAgent(agentId);
  }
}

function buildThreadLanguageInstruction(lang: string | undefined): string | undefined {
  if (!lang) {
    return undefined;
  }
  return `All responses must be in ${lang}.`;
}
