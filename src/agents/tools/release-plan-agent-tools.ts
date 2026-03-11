import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "ai-kit";
import { createUlid } from "../../shared/ulid.js";

const DEFAULT_RELEASE_PLANS_DIR = ".codefleet/data/release-plan";

export interface ReleasePlanEventPublishResult {
  enqueuedAgentIds: string[];
}

export interface ReleasePlanEventPublisher {
  publishReleasePlanCreated(path: string): Promise<ReleasePlanEventPublishResult>;
}

export interface CreateReleasePlanAgentToolsOptions {
  releasePlansDir?: string;
  projectRootDir?: string;
  eventPublisher?: ReleasePlanEventPublisher;
}

const ReleasePlanCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(2_000),
  details: z.string().trim().min(1),
  sourceRefs: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  reporter: z.string().trim().min(1).max(120).optional(),
});

const ReleasePlanListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

interface ReleasePlanRecord {
  id: string;
  title: string;
  summary: string;
  details: string;
  sourceRefs: string[];
  reporter: string | null;
  createdAt: string;
  createdBy: "codefleet.front-desk";
}

type ReleasePlanAgentToolsInput = string | CreateReleasePlanAgentToolsOptions | undefined;

export function createReleasePlanAgentTools(input: ReleasePlanAgentToolsInput = DEFAULT_RELEASE_PLANS_DIR): ToolDefinition[] {
  const options: CreateReleasePlanAgentToolsOptions = typeof input === "string" ? { releasePlansDir: input } : (input ?? {});
  const releasePlansDir = options.releasePlansDir ?? DEFAULT_RELEASE_PLANS_DIR;
  const projectRootDir = options.projectRootDir ?? process.cwd();
  const eventPublisher = options.eventPublisher;

  return [
    {
      name: "release_plan_create",
      description: "Create a release plan for downstream curation and planning",
      parameters: ReleasePlanCreateInputSchema,
      execute: async (params) => {
        const input = ReleasePlanCreateInputSchema.parse(params);
        const now = new Date().toISOString();
        const record: ReleasePlanRecord = {
          id: createUlid(),
          title: input.title,
          summary: input.summary,
          details: input.details,
          sourceRefs: uniqueNonEmpty(input.sourceRefs ?? []),
          reporter: input.reporter ?? null,
          createdAt: now,
          createdBy: "codefleet.front-desk",
        };

        await fs.mkdir(releasePlansDir, { recursive: true });
        const planPath = path.join(releasePlansDir, `${record.id}.md`);
        await fs.writeFile(planPath, serializeReleasePlan(record), "utf8");
        const event = await publishReleasePlanCreated(eventPublisher, planPath, projectRootDir);
        return { releasePlan: record, path: planPath, event };
      },
    },
    {
      name: "release_plan_list",
      description: "List stored release plans",
      parameters: ReleasePlanListInputSchema,
      execute: async (params) => {
        const input = ReleasePlanListInputSchema.parse(params ?? {});
        const listed = await readReleasePlans(releasePlansDir);
        const limit = input.limit ?? 20;
        return {
          releasePlans: listed.slice(0, limit),
          count: listed.length,
        };
      },
    },
  ];
}

async function publishReleasePlanCreated(
  eventPublisher: ReleasePlanEventPublisher | undefined,
  planPath: string,
  projectRootDir: string,
): Promise<{
  type: "release-plan.create";
  path: string;
  status: "enqueued" | "failed";
  enqueuedAgentIds?: string[];
  error?: string;
} | null> {
  if (!eventPublisher) {
    return null;
  }

  try {
    const relativePath = toProjectRelativeMarkdownPath(planPath, projectRootDir);
    const result = await eventPublisher.publishReleasePlanCreated(relativePath);
    return {
      type: "release-plan.create",
      path: relativePath,
      status: "enqueued",
      enqueuedAgentIds: result.enqueuedAgentIds,
    };
  } catch (error) {
    return {
      type: "release-plan.create",
      path: planPath,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toProjectRelativeMarkdownPath(filePath: string, projectRootDir: string): string {
  const relative = path.relative(projectRootDir, filePath).split(path.sep).join("/");
  if (relative.length === 0) {
    throw new Error("release plan path must be non-empty");
  }
  if (relative.includes("..")) {
    throw new Error("release plan path must be inside project root");
  }
  if (relative.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(relative)) {
    throw new Error("release plan path must be project-root relative");
  }
  if (!relative.endsWith(".md")) {
    throw new Error("release plan path must end with .md");
  }
  if (!relative.startsWith(`${DEFAULT_RELEASE_PLANS_DIR}/`)) {
    throw new Error(`release plan path must be inside ${DEFAULT_RELEASE_PLANS_DIR}`);
  }
  return relative;
}

async function readReleasePlans(releasePlansDir: string): Promise<ReleasePlanRecord[]> {
  let files: string[];
  try {
    files = await fs.readdir(releasePlansDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const plans = await Promise.all(
    files
      .filter((file) => file.endsWith(".md"))
      .map(async (file) => {
        const raw = await fs.readFile(path.join(releasePlansDir, file), "utf8");
        return parseReleasePlan(raw);
      }),
  );

  return plans.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function parseReleasePlan(raw: string): ReleasePlanRecord {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw new Error("invalid release plan format: missing front matter start");
  }

  const frontMatterEnd = lines.indexOf("---", 1);
  if (frontMatterEnd < 0) {
    throw new Error("invalid release plan format: missing front matter end");
  }

  const frontMatterLines = lines.slice(1, frontMatterEnd);
  const body = lines.slice(frontMatterEnd + 1).join("\n").trim();
  const entries = new Map<string, string>();
  for (const line of frontMatterLines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }
    entries.set(line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim());
  }

  return ReleasePlanCreateInputSchema.extend({
    id: z.string().min(1),
    sourceRefs: z.array(z.string().trim().min(1).max(500)),
    reporter: z.string().trim().min(1).max(120).nullable(),
    createdAt: z.string().datetime(),
    createdBy: z.literal("codefleet.front-desk"),
  }).parse({
    id: entries.get("id"),
    title: entries.get("title"),
    summary: entries.get("summary"),
    details: body,
    sourceRefs: (entries.get("sourceRefs") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    reporter: toNullable(entries.get("reporter")),
    createdAt: entries.get("createdAt"),
    createdBy: entries.get("createdBy"),
  });
}

function serializeReleasePlan(plan: ReleasePlanRecord): string {
  const reporter = plan.reporter ?? "null";
  return [
    "---",
    `id: ${plan.id}`,
    `title: ${plan.title}`,
    `summary: ${plan.summary}`,
    `sourceRefs: ${plan.sourceRefs.join(", ")}`,
    `reporter: ${reporter}`,
    `createdAt: ${plan.createdAt}`,
    `createdBy: ${plan.createdBy}`,
    "---",
    plan.details,
    "",
  ].join("\n");
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function toNullable(value: string | undefined): string | null {
  if (!value || value === "null") {
    return null;
  }
  return value;
}
