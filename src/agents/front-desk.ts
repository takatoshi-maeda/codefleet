import { ConversationalAgent, createFileTools, FileHistory } from "ai-kit";
import type { LLMClient, LLMClientOptions, LLMProvider } from "ai-kit";
import type { AgentContext } from "ai-kit";
import type { LLMChatInput, LLMResult } from "ai-kit";
import type { LLMStreamEvent } from "ai-kit";
import type { ConversationHistory } from "ai-kit";
import type { ZodType } from "zod";
import type { BacklogService } from "../domain/backlog/backlog-service.js";
import { createBacklogAgentTools } from "./tools/backlog-agent-tools.js";
import { createFeedbackNoteAgentTools } from "./tools/feedback-note-agent-tools.js";

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
  feedbackNotesDir?: string;
  fileToolWorkingDir?: string;
  historyBaseDir?: string;
  clientFactory?: (options: LLMClientOptions) => LLMClient;
}

interface ResolvedCodefleetFrontDeskRuntimeConfig {
  maxTurns: number;
  feedbackNotesDir: string;
  fileToolWorkingDir: string;
  historyBaseDir: string;
  llm: CodefleetFrontDeskLlmConfig;
  clientFactory: (options: LLMClientOptions) => LLMClient;
}

const DEFAULT_LLM_PROVIDER: LLMProvider = "openai";
const DEFAULT_LLM_MODEL = "gpt-5.3-codex";
const DEFAULT_MAX_TURNS = 6;
const DEFAULT_FEEDBACK_NOTES_DIR = ".codefleet/data/feedback-notes";
const DEFAULT_HISTORY_BASE_DIR = ".codefleet/runtime/front-desk-history";

const DEFAULT_API_KEY_ENV_BY_PROVIDER: Record<LLMProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

export const CODEFLEET_FRONT_DESK_SYSTEM_PROMPT = [
  "You are codefleet.front-desk, the feedback intake desk for Orchestrator.",
  "Your primary responsibility is to proactively draw out concrete user feedback, clarify ambiguities, and summarize it.",
  "When enough detail is collected, persist it with feedback_note_create so Orchestrator can act on it.",
  "Use feedback_note_list when the user asks to review past feedback notes.",
  "Use ListDirectory and ReadFile to inspect implementation and documentation files when needed.",
  "You can also use backlog_epic_* and backlog_item_* tools for context when feedback references backlog work.",
  "When an Epic ID or Item ID is explicitly specified, prefer *.get tools; for lists/overviews, prefer *.list tools.",
  "If no data is found, clearly say that nothing was detected and ask targeted follow-up questions to refine feedback.",
].join("\n");

export function createCodefleetFrontDeskAgent(
  backlogService: BacklogService,
  runtimeConfig: CodefleetFrontDeskRuntimeConfig = {},
) {
  const resolvedConfig = resolveCodefleetFrontDeskRuntimeConfig(runtimeConfig);
  const llmClient = resolvedConfig.clientFactory(toLlmClientOptions(resolvedConfig.llm));
  const tools = [
    ...createBacklogAgentTools(backlogService),
    ...createFeedbackNoteAgentTools(resolvedConfig.feedbackNotesDir),
    ...createFrontDeskFileReadTools(resolvedConfig.fileToolWorkingDir),
  ];

  return (context: AgentContext) => {
    const persistentContext = withPersistentThreadHistory(context, resolvedConfig.historyBaseDir);
    return new ConversationalAgent({
      context: persistentContext,
      client: llmClient,
      instructions: CODEFLEET_FRONT_DESK_SYSTEM_PROMPT,
      tools,
      maxTurns: resolvedConfig.maxTurns,
    });
  };
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
    feedbackNotesDir: runtimeConfig.feedbackNotesDir ?? DEFAULT_FEEDBACK_NOTES_DIR,
    fileToolWorkingDir: runtimeConfig.fileToolWorkingDir ?? process.cwd(),
    historyBaseDir: runtimeConfig.historyBaseDir ?? DEFAULT_HISTORY_BASE_DIR,
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

function createFrontDeskFileReadTools(workingDir: string) {
  const fileTools = createFileTools({ workingDir });
  const listDirectory = fileTools.find((tool) => tool.name === "ListDirectory");
  const readFile = fileTools.find((tool) => tool.name === "ReadFile");
  if (!listDirectory || !readFile) {
    throw new Error("front-desk file tools are unavailable");
  }
  return [listDirectory, readFile];
}

function withPersistentThreadHistory(context: AgentContext, baseDir: string): AgentContext {
  if (context.history instanceof FileHistory) {
    return context;
  }

  const sessionId = sanitizeSessionIdForFilename(context.sessionId);
  const persistentHistory = new FileHistory({
    // sessionId can be user-provided (e.g., MCP agent.run params.sessionId),
    // so normalize to a filesystem-safe filename segment.
    sessionId,
    baseDir,
  });
  return new FrontDeskContextWithOverriddenHistory(context, persistentHistory);
}

function sanitizeSessionIdForFilename(sessionId: string): string {
  const normalized = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized.length > 0 ? normalized : "default";
}

class FrontDeskContextWithOverriddenHistory implements AgentContext {
  constructor(
    private readonly base: AgentContext,
    readonly history: ConversationHistory,
  ) {}

  get sessionId() {
    return this.base.sessionId;
  }

  get progress() {
    return this.base.progress;
  }

  get toolCallResults() {
    return this.base.toolCallResults;
  }

  get turns() {
    return this.base.turns;
  }

  get selectedAgentName() {
    return this.base.selectedAgentName;
  }

  set selectedAgentName(value: string | undefined) {
    this.base.selectedAgentName = value;
  }

  get metadata() {
    return this.base.metadata;
  }

  collectToolResults<T>(schema: ZodType<T>): T[] {
    return this.base.collectToolResults(schema);
  }
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
