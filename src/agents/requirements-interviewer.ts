import { ConversationalAgent, createFileTools, FileHistory, MarkdownPromptLoader } from "ai-kit";
import type { AgentContext, ConversationHistory, LLMClient, LLMChatInput, LLMClientOptions, LLMProvider, LLMResult, LLMStreamEvent } from "ai-kit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import type { BacklogService } from "../domain/backlog/backlog-service.js";
import { DEFAULT_DOCUMENTS_ROOT_DIR } from "../domain/documents/document-service.js";
import {
  resolveCodefleetFrontDeskRuntimeConfig,
  type CodefleetFrontDeskLlmConfig,
  type CodefleetFrontDeskRuntimeConfig,
} from "./front-desk.js";

export interface RequirementsInterviewerRuntimeConfig extends CodefleetFrontDeskRuntimeConfig {}

const DEFAULT_HISTORY_BASE_DIR = ".codefleet/runtime/requirements-interviewer-history";

export const CODEFLEET_REQUIREMENTS_INTERVIEWER_SYSTEM_PROMPT =
  createRequirementsInterviewerPromptLoader().format("instructions");

export function createCodefleetRequirementsInterviewerAgent(
  _backlogService: BacklogService,
  runtimeConfig: RequirementsInterviewerRuntimeConfig = {},
) {
  const resolvedConfig = resolveCodefleetFrontDeskRuntimeConfig({
    ...runtimeConfig,
    historyBaseDir: runtimeConfig.historyBaseDir ?? DEFAULT_HISTORY_BASE_DIR,
  });
  const llmClient = resolvedConfig.clientFactory(toLlmClientOptions(resolvedConfig.llm));
  const tools = createSharedFileTools(resolvedConfig.fileToolWorkingDir);

  return (context: AgentContext) => {
    const persistentContext = withPersistentThreadHistory(context, resolvedConfig.historyBaseDir);
    return new ConversationalAgent({
      context: persistentContext,
      client: llmClient,
      instructions: CODEFLEET_REQUIREMENTS_INTERVIEWER_SYSTEM_PROMPT,
      tools,
      maxTurns: resolvedConfig.maxTurns,
    });
  };
}

function createRequirementsInterviewerPromptLoader(): MarkdownPromptLoader {
  const promptsDir = path.join(resolveProjectRoot(), "src", "prompts", "requirements-interviewer");
  return new MarkdownPromptLoader({ baseDir: promptsDir });
}

function createSharedFileTools(workingDir: string) {
  const fileTools = createFileTools({
    workingDir,
    allowedPaths: [".", DEFAULT_DOCUMENTS_ROOT_DIR],
  });
  const listDirectory = fileTools.find((tool) => tool.name === "ListDirectory");
  const readFile = fileTools.find((tool) => tool.name === "ReadFile");
  const writeFile = fileTools.find((tool) => tool.name === "WriteFile");
  const makeDirectory = fileTools.find((tool) => tool.name === "MakeDirectory");
  if (!listDirectory || !readFile || !writeFile || !makeDirectory) {
    throw new Error("requirements-interviewer file tools are unavailable");
  }
  return [listDirectory, readFile, writeFile, makeDirectory];
}

function resolveProjectRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "..");
}

function withPersistentThreadHistory(context: AgentContext, baseDir: string): AgentContext {
  if (context.history instanceof FileHistory) {
    return context;
  }

  const sessionId = sanitizeSessionIdForFilename(context.sessionId);
  const persistentHistory = new FileHistory({
    sessionId,
    baseDir,
  });
  return new ContextWithOverriddenHistory(context, persistentHistory);
}

function sanitizeSessionIdForFilename(sessionId: string): string {
  const normalized = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized.length > 0 ? normalized : "default";
}

class ContextWithOverriddenHistory implements AgentContext {
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
    return Math.ceil(content.length / 4);
  }

  private async *streamViaDelegate(input: LLMChatInput): AsyncIterable<LLMStreamEvent> {
    const client = await this.loadDelegate();
    yield* client.stream(input);
  }

  private async loadDelegate(): Promise<LLMClient> {
    if (this.delegate) {
      return this.delegate;
    }
    if (!this.delegatePromise) {
      this.delegatePromise = import("ai-kit").then(({ createLLMClient }) => {
        const client = createLLMClient(this.options);
        this.delegate = client;
        return client;
      });
    }
    return this.delegatePromise;
  }
}
