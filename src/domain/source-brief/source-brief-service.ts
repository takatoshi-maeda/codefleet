import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson } from "../../infra/fs/atomic-write.js";
import {
  DEFAULT_SOURCE_BRIEF_DIR,
  DEFAULT_SOURCE_BRIEF_MARKDOWN_PATH,
  DEFAULT_SOURCE_BRIEF_METADATA_PATH,
  type SourceBriefDocument,
  type SourceBriefMetadata,
  type WriteSourceBriefInput,
} from "../source-brief-model.js";

export class SourceBriefService {
  private readonly briefPath: string;
  private readonly metadataPath: string;

  constructor(private readonly baseDir: string = DEFAULT_SOURCE_BRIEF_DIR) {
    this.briefPath =
      baseDir === DEFAULT_SOURCE_BRIEF_DIR ? DEFAULT_SOURCE_BRIEF_MARKDOWN_PATH : path.join(baseDir, "latest.md");
    this.metadataPath =
      baseDir === DEFAULT_SOURCE_BRIEF_DIR ? DEFAULT_SOURCE_BRIEF_METADATA_PATH : path.join(baseDir, "latest.json");
  }

  async readLatest(): Promise<SourceBriefDocument | null> {
    try {
      const [markdown, rawMetadata] = await Promise.all([
        fs.readFile(this.briefPath, "utf8"),
        fs.readFile(this.metadataPath, "utf8"),
      ]);
      const metadata = parseMetadata(JSON.parse(rawMetadata), this.briefPath);
      return {
        ...metadata,
        markdown,
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeLatest(input: WriteSourceBriefInput): Promise<SourceBriefDocument> {
    const markdown = input.markdown.trim();
    if (markdown.length === 0) {
      throw new Error("source brief markdown must be non-empty");
    }

    const sourcePaths = uniqueNonEmpty(input.sourcePaths);
    if (sourcePaths.length === 0) {
      throw new Error("source brief requires at least one source path");
    }

    const document: SourceBriefDocument = {
      version: 1,
      updatedAt: new Date().toISOString(),
      briefPath: this.briefPath,
      sourcePaths,
      actorId: input.actorId?.trim() ? input.actorId.trim() : null,
      markdown: `${markdown}\n`,
    };

    await atomicWriteText(this.briefPath, document.markdown);
    await atomicWriteJson(this.metadataPath, {
      version: document.version,
      updatedAt: document.updatedAt,
      briefPath: document.briefPath,
      sourcePaths: document.sourcePaths,
      actorId: document.actorId,
    } satisfies SourceBriefMetadata);

    return document;
  }
}

function parseMetadata(value: unknown, expectedBriefPath: string): SourceBriefMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("source brief metadata must be an object");
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new Error("source brief metadata version must be 1");
  }
  if (typeof candidate.updatedAt !== "string" || Number.isNaN(Date.parse(candidate.updatedAt))) {
    throw new Error("source brief metadata updatedAt must be an ISO date-time string");
  }
  if (typeof candidate.briefPath !== "string" || candidate.briefPath.length === 0) {
    throw new Error("source brief metadata briefPath must be a non-empty string");
  }
  if (candidate.briefPath !== expectedBriefPath) {
    throw new Error(`source brief metadata briefPath mismatch: ${candidate.briefPath}`);
  }
  if (!Array.isArray(candidate.sourcePaths) || !candidate.sourcePaths.every((entry) => typeof entry === "string")) {
    throw new Error("source brief metadata sourcePaths must be string[]");
  }
  if (candidate.actorId !== null && candidate.actorId !== undefined && typeof candidate.actorId !== "string") {
    throw new Error("source brief metadata actorId must be string|null");
  }

  return {
    version: 1,
    updatedAt: candidate.updatedAt,
    briefPath: candidate.briefPath,
    sourcePaths: uniqueNonEmpty(candidate.sourcePaths),
    actorId: typeof candidate.actorId === "string" ? candidate.actorId : null,
  };
}

async function atomicWriteText(filePath: string, value: string): Promise<void> {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(dirPath, `.${path.basename(filePath)}.${randomUUID()}.tmp`);

  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(tempPath, value, "utf8");
  await fs.rename(tempPath, filePath);
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}
