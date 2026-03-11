import {
  decodeCodefleetEpicGet,
  decodeCodefleetEpicList,
  decodeCodefleetItemGet,
  decodeCodefleetItemList,
  decodeCodefleetWatchResult,
} from './decoders';
import type {
  CodefleetEpicGetResult,
  CodefleetEpicListResult,
  CodefleetItemGetResult,
  CodefleetItemListResult,
  CodefleetWatchResult,
} from './types';

const MCP_PROTOCOL_VERSION = '2025-03-26';

export type JsonRpcId = string | number;

export type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type StreamRequestOptions = {
  signal?: AbortSignal;
  onNotification?: (message: JsonRpcNotification) => void;
};

export type FleetStatusResponse = {
  nodes?: {
    self?: {
      projectId?: string;
      endpoint?: string;
    };
    peers?: {
      projectId?: string;
      endpoint?: string;
    }[];
  };
};

export type ConversationSummary = {
  sessionId: string;
  title?: string | null;
  createdAt: string;
  updatedAt: string;
  status?: 'idle' | 'progress';
  turnCount: number;
  latestUserMessage?: string | null;
};

export type ConversationsListResult = {
  sessions: ConversationSummary[];
};

export type ConversationTurn = {
  turnId: string;
  runId: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  status: 'success' | 'error' | 'cancelled';
  errorMessage?: string | null;
};

export type ConversationInProgress = {
  runId?: string | null;
  turnId?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  userMessage?: string | null;
  assistantMessage?: string | null;
};

export type ConversationGetResult = {
  sessionId: string;
  title?: string | null;
  createdAt: string;
  updatedAt: string;
  agentName?: string | null;
  status?: 'idle' | 'progress';
  inProgress?: ConversationInProgress | null;
  turns: ConversationTurn[];
};

export type AgentRunResult = {
  sessionId: string;
  runId: string;
  status: 'success' | 'error' | 'cancelled';
  turnId?: string;
  responseId?: string;
  message?: string;
  notificationToken?: string;
  errorMessage?: string;
};

export type DocumentActor = {
  type: 'user' | 'agent' | 'system' | 'external';
  id: string;
};

export type DocumentTreeNode = {
  id: string;
  name: string;
  path: string;
  kind: 'file' | 'folder';
  children?: DocumentTreeNode[];
  language?: 'markdown' | 'python' | 'text' | 'image' | 'video' | 'pdf' | 'binary';
};

export type DocumentTreeResult = {
  root: DocumentTreeNode[];
  updatedAt: string;
};

export type DocumentFileResult = {
  path: string;
  name: string;
  language: 'markdown' | 'python' | 'text' | 'image' | 'video' | 'pdf' | 'binary';
  content: string | null;
  version: string;
  updatedAt: string;
  updatedBy?: DocumentActor | null;
  mimeType: string;
  isBinary: boolean;
};

export type DocumentWatchEvent =
  | {
      type: 'document.snapshot';
      payload: {
        root: DocumentTreeNode[];
        updatedAt: string;
        rootDir: string;
      };
    }
  | {
      type: 'document.changed';
      payload: {
        path: string;
        version: string;
        updatedAt: string;
        updatedBy?: DocumentActor | null;
        change: { kind: 'created' | 'updated' };
      };
    }
  | {
      type: 'document.deleted';
      payload: {
        path: string;
        updatedAt: string;
        change: { kind: 'deleted' };
      };
    }
  | {
      type: 'document.heartbeat';
      payload: { timestamp: string };
    }
  | {
      type: 'document.error';
      payload: { message?: string };
    };

export type CodefleetClient = {
  listBacklogEpics(): Promise<CodefleetEpicListResult>;
  getBacklogEpic(id: string): Promise<CodefleetEpicGetResult>;
  listBacklogItems(): Promise<CodefleetItemListResult>;
  getBacklogItem(id: string): Promise<CodefleetItemGetResult>;
  watchFleet(
    args: {
      heartbeatSec?: number;
      notificationToken?: string;
    },
    options?: StreamRequestOptions,
  ): Promise<CodefleetWatchResult>;
  fetchFleetStatus(endpoint: string): Promise<FleetStatusResponse | null>;
  listConversations(limit?: number): Promise<ConversationsListResult>;
  getConversation(sessionId: string): Promise<ConversationGetResult>;
  runAgent(args: {
    message: string;
    sessionId?: string | null;
    signal?: AbortSignal;
    onStreamEvent?: (message: JsonRpcNotification) => void;
  }): Promise<AgentRunResult>;
  listDocumentsTree(): Promise<DocumentTreeResult>;
  getDocumentFile(path: string): Promise<DocumentFileResult>;
  saveDocumentFile(args: {
    path: string;
    content: string;
    baseVersion?: string | null;
    actor?: DocumentActor | null;
  }): Promise<DocumentFileResult>;
  watchDocuments(
    args: {
      signal?: AbortSignal;
      onEvent?: (event: DocumentWatchEvent) => void;
    },
  ): Promise<void>;
  getDocumentAssetUrl(path: string): string;
};

type CreateCodefleetMcpClientOptions = {
  getBaseUrl: () => string;
  agentName?: string;
  protocolVersion?: string;
  clientInfo?: {
    name: string;
    version: string;
  };
};

const initPromiseByKey = new Map<string, Promise<void>>();
let requestCounter = 0;

function createNotificationToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `token-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function nextRequestId(): JsonRpcId {
  requestCounter += 1;
  return `mcp-${Date.now().toString(16)}-${requestCounter}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function parseSseEventBlock(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

function getEndpoints(baseUrl: string, agentName: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  return {
    init: `${normalized}/api/mcp/${agentName}`,
    toolCall: (toolName: string) =>
      `${normalized}/api/mcp/${agentName}/tools/call/${toolName}`,
    status: `${normalized}/api/codefleet/status`,
    documentsTree: `${normalized}/api/codefleet/documents/tree`,
    documentFile: `${normalized}/api/codefleet/documents/file`,
    documentAsset: `${normalized}/api/codefleet/documents/asset`,
    documentsWatch: `${normalized}/api/codefleet/documents/watch`,
  } as const;
}

function parseSseBlock(block: string): { event: string; data: string | null } | null {
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return {
    event: eventName,
    data: dataLines.length > 0 ? dataLines.join('\n') : null,
  };
}

async function sendNotification(
  endpoint: string,
  protocolVersion: string,
  message: JsonRpcNotification,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': protocolVersion,
    },
    body: JSON.stringify(message),
    signal,
  });
  if (!response.ok) {
    throw new Error(`MCP notification failed: HTTP ${response.status}`);
  }
}

async function sendJsonRequestTo(
  endpoint: string,
  protocolVersion: string,
  message: unknown,
  options: StreamRequestOptions = {},
): Promise<JsonRpcResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': protocolVersion,
    },
    body: JSON.stringify(message),
    signal: options.signal,
  });
  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({}))) as { error?: string };
    const messageText =
      typeof errorPayload.error === 'string' && errorPayload.error.trim().length > 0
        ? errorPayload.error
        : `HTTP ${response.status}`;
    throw new Error(messageText);
  }
  return (await response.json()) as JsonRpcResponse;
}

async function sendStreamableRequestTo(
  endpoint: string,
  protocolVersion: string,
  message: unknown,
  options: StreamRequestOptions = {},
  expectedId?: JsonRpcId | null,
): Promise<JsonRpcResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      'MCP-Protocol-Version': protocolVersion,
    },
    body: JSON.stringify(message),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({}))) as { error?: string };
    const messageText =
      typeof errorPayload.error === 'string' && errorPayload.error.trim().length > 0
        ? errorPayload.error
        : `HTTP ${response.status}`;
    throw new Error(messageText);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await response.json()) as JsonRpcResponse;
  }

  const body = response.body;
  if (!body) {
    throw new Error('MCP response stream was not available.');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let responseMessage: JsonRpcResponse | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundaryIndex = buffer.indexOf('\n\n');
      while (boundaryIndex >= 0) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);

        const data = parseSseEventBlock(block);
        if (!data) {
          boundaryIndex = buffer.indexOf('\n\n');
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed !== 'object') {
          boundaryIndex = buffer.indexOf('\n\n');
          continue;
        }

        const candidate = parsed as JsonRpcResponse | JsonRpcNotification;
        if ('id' in candidate) {
          if (
            responseMessage === null &&
            (expectedId === undefined || expectedId === null || candidate.id === expectedId)
          ) {
            responseMessage = candidate as JsonRpcResponse;
          }
        } else if ('method' in candidate) {
          options.onNotification?.(candidate as JsonRpcNotification);
        }

        boundaryIndex = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!responseMessage) {
    throw new Error('MCP response did not include a result.');
  }
  return responseMessage;
}

function extractStructuredResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (record.structuredContent !== undefined) {
    return record.structuredContent;
  }
  const content = record.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as Record<string, unknown> | undefined;
    if (first && typeof first === 'object' && typeof first.text === 'string') {
      try {
        return JSON.parse(first.text);
      } catch {
        return first.text;
      }
    }
  }
  return result;
}

async function ensureInitialized(
  baseUrl: string,
  agentName: string,
  protocolVersion: string,
  clientInfo: { name: string; version: string },
  signal?: AbortSignal,
): Promise<void> {
  const endpoints = getEndpoints(baseUrl, agentName);
  const initKey = `${agentName}@@${endpoints.init}`;
  const existing = initPromiseByKey.get(initKey);
  if (!existing) {
    const initPromise = (async () => {
      try {
        const initRequest = {
          jsonrpc: '2.0' as const,
          id: nextRequestId(),
          method: 'initialize',
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo,
          },
        };
        await sendStreamableRequestTo(
          endpoints.init,
          protocolVersion,
          initRequest,
          { signal },
          initRequest.id,
        );
        await sendNotification(
          endpoints.init,
          protocolVersion,
          { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
          signal,
        );
      } catch (error) {
        initPromiseByKey.delete(initKey);
        throw error;
      }
    })();
    initPromiseByKey.set(initKey, initPromise);
  }

  const activeInitPromise = initPromiseByKey.get(initKey);
  if (!activeInitPromise) {
    throw new Error(`MCP initialization state missing for agent: ${agentName}`);
  }
  return activeInitPromise;
}

async function callTool<T>(
  toolName: string,
  args: Record<string, unknown>,
  options: StreamRequestOptions,
  config: {
    baseUrl: string;
    agentName: string;
    protocolVersion: string;
    clientInfo: { name: string; version: string };
  },
  mode: 'json' | 'stream',
): Promise<T> {
  await ensureInitialized(
    config.baseUrl,
    config.agentName,
    config.protocolVersion,
    config.clientInfo,
    options.signal,
  );
  const endpoint = getEndpoints(config.baseUrl, config.agentName).toolCall(toolName);
  const response =
    mode === 'stream'
      ? await sendStreamableRequestTo(endpoint, config.protocolVersion, args, options, null)
      : await sendJsonRequestTo(endpoint, config.protocolVersion, args, options);

  if (response.error) {
    throw new Error(
      typeof response.error.message === 'string' ? response.error.message : 'MCP error',
    );
  }

  return extractStructuredResult(response.result) as T;
}

export function createCodefleetMcpClient(
  options: CreateCodefleetMcpClientOptions,
): CodefleetClient {
  const agentName = options.agentName ?? 'codefleet.front-desk';
  const protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
  const clientInfo = options.clientInfo ?? {
    name: 'codefleet-ui',
    version: '0.1.0',
  };

  const buildConfig = () => ({
    baseUrl: options.getBaseUrl(),
    agentName,
    protocolVersion,
    clientInfo,
  });

  return {
    async listBacklogEpics() {
      const raw = await callTool<unknown>('backlog.epic.list', {}, {}, buildConfig(), 'json');
      return decodeCodefleetEpicList(raw);
    },
    async getBacklogEpic(id: string) {
      const raw = await callTool<unknown>('backlog.epic.get', { id }, {}, buildConfig(), 'json');
      return decodeCodefleetEpicGet(raw);
    },
    async listBacklogItems() {
      const raw = await callTool<unknown>('backlog.item.list', {}, {}, buildConfig(), 'json');
      return decodeCodefleetItemList(raw);
    },
    async getBacklogItem(id: string) {
      const raw = await callTool<unknown>('backlog.item.get', { id }, {}, buildConfig(), 'json');
      return decodeCodefleetItemGet(raw);
    },
    async watchFleet(args, requestOptions = {}) {
      const raw = await callTool<unknown>(
        'fleet.watch',
        args,
        requestOptions,
        buildConfig(),
        'stream',
      );
      return decodeCodefleetWatchResult(raw);
    },
    async fetchFleetStatus(endpoint: string) {
      const response = await fetch(getEndpoints(endpoint, agentName).status);
      if (!response.ok) return null;
      return (await response.json()) as FleetStatusResponse;
    },
    async listConversations(limit = 50) {
      return callTool<ConversationsListResult>(
        'conversations.list',
        { limit },
        {},
        buildConfig(),
        'json',
      );
    },
    async getConversation(sessionId: string) {
      return callTool<ConversationGetResult>(
        'conversations.get',
        { sessionId },
        {},
        buildConfig(),
        'json',
      );
    },
    async runAgent(args) {
      const notificationToken = createNotificationToken();
      const payload: Record<string, unknown> = {
        stream: true,
        notificationToken,
        message: args.message,
      };
      if (args.sessionId) {
        payload.sessionId = args.sessionId;
      }

      return callTool<AgentRunResult>(
        'agent.run',
        { arguments: payload },
        {
          signal: args.signal,
          onNotification: (message) => {
            if (message.method !== 'agent/stream-response') return;
            const params =
              message.params && typeof message.params === 'object'
                ? (message.params as Record<string, unknown>)
                : null;
            const token =
              params?.notificationToken ?? params?.notification_token;
            if (typeof token === 'string' && token !== notificationToken) return;
            args.onStreamEvent?.(message);
          },
        },
        buildConfig(),
        'stream',
      );
    },
    async listDocumentsTree() {
      const response = await fetch(getEndpoints(buildConfig().baseUrl, agentName).documentsTree, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return (await response.json()) as DocumentTreeResult;
    },
    async getDocumentFile(path) {
      const endpoint = getEndpoints(buildConfig().baseUrl, agentName).documentFile;
      const response = await fetch(`${endpoint}?path=${encodeURIComponent(path)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      return (await response.json()) as DocumentFileResult;
    },
    async saveDocumentFile(args) {
      const response = await fetch(getEndpoints(buildConfig().baseUrl, agentName).documentFile, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(args),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      return (await response.json()) as DocumentFileResult;
    },
    async watchDocuments(args) {
      const response = await fetch(getEndpoints(buildConfig().baseUrl, agentName).documentsWatch, {
        headers: {
          Accept: 'text/event-stream',
        },
        signal: args.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = response.body;
      if (!body) {
        throw new Error('Document watch stream was not available.');
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let boundaryIndex = buffer.indexOf('\n\n');
          while (boundaryIndex >= 0) {
            const block = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + 2);
            const parsed = parseSseBlock(block);
            if (!parsed?.data) {
              boundaryIndex = buffer.indexOf('\n\n');
              continue;
            }
            try {
              args.onEvent?.({
                type: parsed.event as DocumentWatchEvent['type'],
                payload: JSON.parse(parsed.data) as DocumentWatchEvent['payload'],
              } as DocumentWatchEvent);
            } catch {
              // Ignore malformed events so a single bad frame does not kill the stream.
            }
            boundaryIndex = buffer.indexOf('\n\n');
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
    getDocumentAssetUrl(path) {
      const endpoint = getEndpoints(buildConfig().baseUrl, agentName).documentAsset;
      return `${endpoint}?path=${encodeURIComponent(path)}`;
    },
  };
}
