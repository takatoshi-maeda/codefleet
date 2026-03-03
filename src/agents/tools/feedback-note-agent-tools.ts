import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "ai-kit";
import { createUlid } from "../../shared/ulid.js";

const DEFAULT_FEEDBACK_NOTES_DIR = ".codefleet/data/feedback-notes";

const FeedbackNoteCreateInputSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  details: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  reporter: z.string().trim().min(1).max(120).optional(),
});

const FeedbackNoteListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
});

interface FeedbackNoteRecord {
  id: string;
  summary: string;
  details: string;
  tags: string[];
  priority: "low" | "medium" | "high";
  reporter: string | null;
  createdAt: string;
}

export function createFeedbackNoteAgentTools(notesDir: string = DEFAULT_FEEDBACK_NOTES_DIR): ToolDefinition[] {
  return [
    {
      name: "feedback_note_create",
      description: "Create a user feedback note to hand off to Orchestrator",
      parameters: FeedbackNoteCreateInputSchema,
      execute: async (params) => {
        const input = FeedbackNoteCreateInputSchema.parse(params);
        const now = new Date().toISOString();
        const record: FeedbackNoteRecord = {
          id: createUlid(),
          summary: input.summary,
          details: input.details,
          tags: input.tags ?? [],
          priority: input.priority ?? "medium",
          reporter: input.reporter ?? null,
          createdAt: now,
        };
        await fs.mkdir(notesDir, { recursive: true });
        // One-file-per-note keeps append operations simple and avoids coordination
        // hazards when multiple front-desk runs write feedback concurrently.
        await fs.writeFile(path.join(notesDir, `${record.id}.md`), serializeFeedbackNote(record), "utf8");
        return { note: record };
      },
    },
    {
      name: "feedback_note_list",
      description: "List stored user feedback notes for Orchestrator hand-off",
      parameters: FeedbackNoteListInputSchema,
      execute: async (params) => {
        const input = FeedbackNoteListInputSchema.parse(params ?? {});
        const listed = await readFeedbackNotes(notesDir);
        const filtered = input.tag ? listed.filter((note) => note.tags.includes(input.tag ?? "")) : listed;
        const limit = input.limit ?? 20;
        return {
          notes: filtered.slice(0, limit),
          count: filtered.length,
        };
      },
    },
  ];
}

async function readFeedbackNotes(notesDir: string): Promise<FeedbackNoteRecord[]> {
  let files: string[];
  try {
    files = await fs.readdir(notesDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const notes = await Promise.all(
    files
      .filter((file) => file.endsWith(".md"))
      .map(async (file) => {
        const raw = await fs.readFile(path.join(notesDir, file), "utf8");
        const parsed = parseFeedbackNote(raw);
        return parsed;
      }),
  );

  return notes.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function parseFeedbackNote(raw: string): FeedbackNoteRecord {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw new Error("invalid feedback note format: missing front matter start");
  }

  const frontMatterEnd = lines.indexOf("---", 1);
  if (frontMatterEnd < 0) {
    throw new Error("invalid feedback note format: missing front matter end");
  }

  const frontMatterLines = lines.slice(1, frontMatterEnd);
  const body = lines.slice(frontMatterEnd + 1).join("\n").trim();
  const entries = new Map<string, string>();
  for (const line of frontMatterLines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    entries.set(key, value);
  }

  return FeedbackNoteCreateInputSchema.extend({
    id: z.string().min(1),
    tags: z.array(z.string().trim().min(1).max(64)),
    priority: z.enum(["low", "medium", "high"]),
    reporter: z.string().trim().min(1).max(120).nullable(),
    createdAt: z.string().datetime(),
  }).parse({
    id: entries.get("id"),
    summary: entries.get("summary"),
    details: body,
    tags: (entries.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
    priority: entries.get("priority"),
    reporter: toNullable(entries.get("reporter")),
    createdAt: entries.get("createdAt"),
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function serializeFeedbackNote(note: FeedbackNoteRecord): string {
  const tags = note.tags.join(", ");
  const reporter = note.reporter ?? "null";
  return [
    "---",
    `id: ${note.id}`,
    `summary: ${note.summary}`,
    `tags: ${tags}`,
    `priority: ${note.priority}`,
    `reporter: ${reporter}`,
    `createdAt: ${note.createdAt}`,
    "---",
    note.details,
    "",
  ].join("\n");
}

function toNullable(value: string | undefined): string | null {
  if (!value || value === "null") {
    return null;
  }
  return value;
}
