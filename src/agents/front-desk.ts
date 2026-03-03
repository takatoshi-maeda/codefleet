import { ConversationalAgent } from "ai-kit";
import type { LLMClient, LLMClientOptions, LLMProvider } from "ai-kit";
import type { AgentContext } from "ai-kit";
import type { LLMChatInput, LLMResult } from "ai-kit";
import type { LLMStreamEvent } from "ai-kit";
import type { BacklogService } from "../domain/backlog/backlog-service.js";
import { createBacklogAgentTools } from "./tools/backlog-agent-tools.js";

export interface CodefleetFrontDeskLlmConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CodefleetFrontDeskRuntimeConfig {
  llm?: Partial<CodefleetFrontDeskLlmConfig>;
  maxTurns?: number;
  clientFactory?: (options: LLMClientOptions) => LLMClient;
}

interface ResolvedCodefleetFrontDeskRuntimeConfig {
  maxTurns: number;
  llm: CodefleetFrontDeskLlmConfig;
  clientFactory: (options: LLMClientOptions) => LLMClient;
}

const DEFAULT_LLM_PROVIDER: LLMProvider = "openai";
const DEFAULT_LLM_MODEL = "gpt-5.3-codex";
const DEFAULT_MAX_TURNS = 6;

const DEFAULT_API_KEY_ENV_BY_PROVIDER: Record<LLMProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

export const CODEFLEET_FRONT_DESK_SYSTEM_PROMPT = [
  "You are codefleet.front-desk, a read-only support desk for backlog visibility.",
  "Use only the provided backlog tools. backlog_epic_* maps to backlog.epic.*, backlog_item_* maps to backlog.item.*.",
  "If an Epic ID or Item ID is explicitly specified, prefer *.get tools.",
  "If the user asks for lists, filters, or overviews, prefer *.list tools.",
  "If no data is found, clearly say that nothing was detected.",
].join("\n");

export function createCodefleetFrontDeskAgent(
  backlogService: BacklogService,
  runtimeConfig: CodefleetFrontDeskRuntimeConfig = {},
) {
  const resolvedConfig = resolveCodefleetFrontDeskRuntimeConfig(runtimeConfig);
  const llmClient = resolvedConfig.clientFactory(toLlmClientOptions(resolvedConfig.llm));
  const tools = createBacklogAgentTools(backlogService);

  return (context: AgentContext) =>
    new ConversationalAgent({
      context,
      client: llmClient,
      instructions: CODEFLEET_FRONT_DESK_SYSTEM_PROMPT,
      tools,
      maxTurns: resolvedConfig.maxTurns,
    });
}

export function resolveCodefleetFrontDeskRuntimeConfig(
  runtimeConfig: CodefleetFrontDeskRuntimeConfig = {},
): ResolvedCodefleetFrontDeskRuntimeConfig {
  const maxTurns = runtimeConfig.maxTurns ?? DEFAULT_MAX_TURNS;
  const clientFactory = runtimeConfig.clientFactory ?? ((options) => new LazyLoadedLlmClient(options));

  const provider = runtimeConfig.llm?.provider ?? DEFAULT_LLM_PROVIDER;
  const model = runtimeConfig.llm?.model ?? DEFAULT_LLM_MODEL;
  const apiKeyEnv = runtimeConfig.llm?.apiKeyEnv ?? DEFAULT_API_KEY_ENV_BY_PROVIDER[provider];
  const apiKey = runtimeConfig.llm?.apiKey ?? process.env[apiKeyEnv];

  if (!apiKey) {
    throw new Error(
      `front-desk llm requires API key: set ${apiKeyEnv} or pass frontDesk.llm.apiKey`,
    );
  }

  return {
    maxTurns,
    llm: {
      provider,
      model,
      apiKey,
      apiKeyEnv,
      temperature: runtimeConfig.llm?.temperature,
      maxTokens: runtimeConfig.llm?.maxTokens,
    },
    clientFactory,
  };
}

function toLlmClientOptions(config: CodefleetFrontDeskLlmConfig): LLMClientOptions {
  const base = {
    model: config.model,
    apiKey: config.apiKey,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
  switch (config.provider) {
    case "openai":
      return { provider: "openai", ...base };
    case "anthropic":
      return { provider: "anthropic", ...base };
    case "google":
      return { provider: "google", ...base };
    case "perplexity":
      return { provider: "perplexity", ...base };
  }
}

class LazyLoadedLlmClient implements LLMClient {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly capabilities = {
    supportsReasoning: true,
    supportsToolCalls: true,
    supportsStreaming: true,
    supportsImages: true,
    contextWindowSize: 128_000,
  };
  private delegate: LLMClient | null = null;
  private delegatePromise: Promise<LLMClient> | null = null;

  constructor(private readonly options: LLMClientOptions) {
    this.provider = options.provider;
    this.model = options.model;
  }

  async invoke(input: LLMChatInput): Promise<LLMResult> {
    const client = await this.loadDelegate();
    return client.invoke(input);
  }

  stream(input: LLMChatInput): AsyncIterable<LLMStreamEvent> {
    return this.streamViaDelegate(input);
  }

  estimateTokens(content: string): number {
    return this.delegate?.estimateTokens(content) ?? Math.ceil(content.length / 4);
  }

  private async loadDelegate(): Promise<LLMClient> {
    if (this.delegate) {
      return this.delegate;
    }
    if (!this.delegatePromise) {
      this.delegatePromise = import("ai-kit")
        .then((module) => module.createLLMClient(this.options))
        .then((client) => {
          this.delegate = client;
          return client;
        })
        .catch((error) => {
          this.delegatePromise = null;
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`failed to initialize front-desk llm client: ${detail}`);
        });
    }
    return this.delegatePromise;
  }

  private async *streamViaDelegate(input: LLMChatInput): AsyncIterable<LLMStreamEvent> {
    const client = await this.loadDelegate();
    yield* client.stream(input);
  }
}
