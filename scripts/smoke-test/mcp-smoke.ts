#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:3290";
const DEFAULT_AGENT = "codefleet.front-desk";
const DEFAULT_TIMEOUT_MS = 10_000;

interface CliOptions {
  baseUrl: string;
  agent: string;
  timeoutMs: number;
}

interface ToolCallResponse {
  result?: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}

interface HttpRequestDefinition {
  label: string;
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const failures: string[] = [];

  console.log("# MCP Smoke Test Report");
  console.log("");
  console.log(`- target: \`${options.baseUrl}\``);
  console.log(`- agent: \`${options.agent}\``);
  console.log(`- timeoutMs: \`${options.timeoutMs}\``);

  const listAgents = await sendAndPrint(options, {
    label: "List Agents",
    method: "GET",
    path: "/api/mcp",
  });
  if (!listAgents.ok) {
    failures.push("GET /api/mcp failed");
  }

  const status = await sendAndPrint(options, {
    label: "Agent Status",
    method: "GET",
    path: `/api/mcp/${encodeURIComponent(options.agent)}/status`,
  });
  if (!status.ok) {
    failures.push(`GET /api/mcp/${options.agent}/status failed`);
  }

  const epicList = await sendAndPrint(options, {
    label: "Tool backlog.epic.list",
    method: "POST",
    path: `/api/mcp/${encodeURIComponent(options.agent)}/tools/call/backlog.epic.list`,
    headers: { "content-type": "application/json" },
    body: { arguments: {} },
  });
  if (!epicList.ok) {
    failures.push("backlog.epic.list failed");
  }
  const epicListPayload = parseToolCallResponse(epicList.parsedBody);
  const epicId = findFirstId(epicListPayload?.result?.structuredContent?.epics);

  const epicGet = await sendAndPrint(options, {
    label: `Tool backlog.epic.get (${epicId ? "existing" : "fallback"})`,
    method: "POST",
    path: `/api/mcp/${encodeURIComponent(options.agent)}/tools/call/backlog.epic.get`,
    headers: { "content-type": "application/json" },
    body: { arguments: epicId ? { id: epicId } : { id: "E-404" } },
  });
  if (!epicGet.ok) {
    failures.push("backlog.epic.get failed");
  }

  const itemList = await sendAndPrint(options, {
    label: "Tool backlog.item.list",
    method: "POST",
    path: `/api/mcp/${encodeURIComponent(options.agent)}/tools/call/backlog.item.list`,
    headers: { "content-type": "application/json" },
    body: { arguments: {} },
  });
  if (!itemList.ok) {
    failures.push("backlog.item.list failed");
  }
  const itemListPayload = parseToolCallResponse(itemList.parsedBody);
  const itemId = findFirstId(itemListPayload?.result?.structuredContent?.items);

  const itemGet = await sendAndPrint(options, {
    label: `Tool backlog.item.get (${itemId ? "existing" : "fallback"})`,
    method: "POST",
    path: `/api/mcp/${encodeURIComponent(options.agent)}/tools/call/backlog.item.get`,
    headers: { "content-type": "application/json" },
    body: { arguments: itemId ? { id: itemId } : { id: "I-404" } },
  });
  if (!itemGet.ok) {
    failures.push("backlog.item.get failed");
  }

  if (failures.length > 0) {
    console.log("");
    console.log("## Result");
    console.log("");
    console.log(`- status: FAILED`);
    console.log(`- failureCount: ${failures.length}`);
    console.log("- failures:");
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("## Result");
  console.log("");
  console.log("- status: OK");
  console.log("- failureCount: 0");
}

function parseArgs(argv: string[]): CliOptions {
  let baseUrl = DEFAULT_BASE_URL;
  let agent = DEFAULT_AGENT;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--help" || current === "-h") {
      printHelp();
      process.exit(0);
    }
    if (current === "--base-url") {
      baseUrl = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (current === "--agent") {
      agent = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (current === "--timeout-ms") {
      timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${current}`);
  }

  if (!baseUrl) {
    throw new Error("--base-url is required");
  }
  if (!agent) {
    throw new Error("--agent is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), agent, timeoutMs };
}

function printHelp(): void {
  console.log("Usage: tsx scripts/smoke-test/mcp-smoke.ts [options]");
  console.log("");
  console.log("Options:");
  console.log(`  --base-url <url>    MCP server base URL (default: ${DEFAULT_BASE_URL})`);
  console.log(`  --agent <name>      Agent name (default: ${DEFAULT_AGENT})`);
  console.log(`  --timeout-ms <ms>   HTTP timeout in ms (default: ${DEFAULT_TIMEOUT_MS})`);
  console.log("  -h, --help          Show help");
}

async function sendAndPrint(
  options: CliOptions,
  request: HttpRequestDefinition,
): Promise<{ ok: boolean; parsedBody: unknown }> {
  const url = `${options.baseUrl}${request.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const requestHeaders = {
    accept: "application/json",
    ...(request.headers ?? {}),
  };
  const requestBodyText = request.body === undefined ? undefined : JSON.stringify(request.body, null, 2);
  const host = new URL(options.baseUrl).host;

  console.log("");
  console.log(`## ${request.label}`);
  console.log("");
  console.log("### HTTP Request");
  console.log("");
  console.log("```http");
  console.log(`${request.method} ${request.path} HTTP/1.1`);
  console.log(`Host: ${host}`);
  for (const [name, value] of Object.entries(requestHeaders)) {
    console.log(`${name}: ${value}`);
  }
  if (requestBodyText !== undefined) {
    console.log("");
    console.log(requestBodyText);
  }
  console.log("```");

  try {
    const response = await fetch(url, {
      method: request.method,
      headers: requestHeaders,
      body: requestBodyText,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const bodyText = await response.text();
    const parsedBody = parseHttpBody(bodyText, response.headers.get("content-type"));
    console.log("");
    console.log("### HTTP Response");
    console.log("");
    console.log("```http");
    console.log(`HTTP/1.1 ${response.status} ${response.statusText}`);
    response.headers.forEach((value, key) => {
      console.log(`${key}: ${value}`);
    });
    console.log("");
    console.log(renderBody(parsedBody, bodyText));
    console.log("```");

    return {
      ok: response.ok,
      parsedBody,
    };
  } catch (error) {
    clearTimeout(timer);
    console.log("");
    console.log("### HTTP Response");
    console.log("");
    console.log("```http");
    console.log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    console.log("```");
    return { ok: false, parsedBody: null };
  }
}

function parseHttpBody(bodyText: string, contentType: string | null): unknown {
  const normalizedContentType = contentType ?? "";
  if (normalizedContentType.includes("text/event-stream")) {
    const dataLines = bodyText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .filter((line) => line.length > 0);
    const lastData = dataLines[dataLines.length - 1] ?? "{}";
    try {
      return JSON.parse(lastData);
    } catch {
      return lastData;
    }
  }

  if (!bodyText.trim()) {
    return "";
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

function renderBody(parsedBody: unknown, rawBodyText: string): string {
  if (typeof parsedBody === "string") {
    return parsedBody.length > 0 ? parsedBody : "(empty)";
  }
  if (parsedBody === null || parsedBody === undefined || rawBodyText.trim().length === 0) {
    return "(empty)";
  }
  return JSON.stringify(parsedBody, null, 2);
}

function parseToolCallResponse(payload: unknown): ToolCallResponse | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as ToolCallResponse;
}

function findFirstId(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const first = value.find((entry) => entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string");
  return first ? String((first as { id: string }).id) : null;
}

void main().catch((error) => {
  console.error("# MCP Smoke Test Report");
  console.error("");
  console.error("## Result");
  console.error("");
  console.error("- status: ERROR");
  console.error(`- message: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
