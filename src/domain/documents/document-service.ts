import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_DOCUMENTS_ROOT_DIR = "docs/spec";

export type DocumentActor = {
  type: "user" | "agent" | "system" | "external";
  id: string;
};

export type DocumentLanguage = "markdown" | "python" | "text" | "image";

export type DocumentTreeNode = {
  id: string;
  name: string;
  path: string;
  kind: "file" | "folder";
  children?: DocumentTreeNode[];
  language?: DocumentLanguage;
};

export type DocumentFile = {
  path: string;
  name: string;
  language: DocumentLanguage;
  content: string;
  version: string;
  updatedAt: string;
  updatedBy: DocumentActor | null;
};

export type DocumentIndexEntry = {
  path: string;
  version: string;
  updatedAt: string;
  size: number;
};

export type DocumentWriteInput = {
  path: string;
  content: string;
  baseVersion?: string | null;
  actor?: DocumentActor | null;
};

export class DocumentConflictError extends Error {
  readonly code = "ERR_DOCUMENT_CONFLICT";

  constructor(
    readonly documentPath: string,
    readonly expectedVersion: string | null,
    readonly actualVersion: string,
  ) {
    super(`document version conflict for ${documentPath}`);
  }
}

/**
 * The document workspace is intentionally rooted under a single directory so
 * both browser edits and agent edits stay constrained to shared spec files.
 */
export class DocumentService {
  private readonly workspaceRoot: string;
  private readonly rootDirName: string;
  private readonly actorByPath = new Map<string, DocumentActor>();

  constructor(rootDir: string = DEFAULT_DOCUMENTS_ROOT_DIR, workspaceRoot: string = process.cwd()) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.rootDirName = path.normalize(rootDir).replace(/\\/g, "/");
  }

  getRootDir(): string {
    return this.rootDirName;
  }

  async listTree(): Promise<{ root: DocumentTreeNode[]; updatedAt: string }> {
    await fs.mkdir(this.resolveRootAbsolutePath(), { recursive: true });
    const rootNode = await this.buildTreeNode(this.rootDirName);
    return {
      root: [rootNode],
      updatedAt: new Date().toISOString(),
    };
  }

  async listIndex(): Promise<Map<string, DocumentIndexEntry>> {
    await fs.mkdir(this.resolveRootAbsolutePath(), { recursive: true });
    const entries = new Map<string, DocumentIndexEntry>();
    await this.walkFiles(this.rootDirName, async (documentPath, absolutePath) => {
      const [content, stats] = await Promise.all([fs.readFile(absolutePath, "utf8"), fs.stat(absolutePath)]);
      entries.set(documentPath, {
        path: documentPath,
        version: computeVersion(content),
        updatedAt: stats.mtime.toISOString(),
        size: stats.size,
      });
    });
    return entries;
  }

  async readFile(documentPath: string): Promise<DocumentFile> {
    const absolutePath = this.resolveDocumentAbsolutePath(documentPath);
    const [content, stats] = await Promise.all([fs.readFile(absolutePath, "utf8"), fs.stat(absolutePath)]);
    return {
      path: this.normalizeDocumentPath(documentPath),
      name: path.basename(documentPath),
      language: inferLanguage(documentPath),
      content,
      version: computeVersion(content),
      updatedAt: stats.mtime.toISOString(),
      updatedBy: this.actorByPath.get(this.normalizeDocumentPath(documentPath)) ?? null,
    };
  }

  async writeFile(input: DocumentWriteInput): Promise<DocumentFile> {
    const documentPath = this.normalizeDocumentPath(input.path);
    const absolutePath = this.resolveDocumentAbsolutePath(documentPath);
    let currentVersion: string | null = null;

    try {
      const existing = await fs.readFile(absolutePath, "utf8");
      currentVersion = computeVersion(existing);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    if (input.baseVersion && currentVersion && input.baseVersion !== currentVersion) {
      throw new DocumentConflictError(documentPath, input.baseVersion, currentVersion);
    }

    if (input.baseVersion && !currentVersion) {
      throw new DocumentConflictError(documentPath, input.baseVersion, "missing");
    }

    await atomicWriteText(absolutePath, input.content);
    const actor = input.actor ?? null;
    if (actor) {
      this.actorByPath.set(documentPath, actor);
    } else {
      this.actorByPath.delete(documentPath);
    }
    return this.readFile(documentPath);
  }

  private async buildTreeNode(documentPath: string): Promise<DocumentTreeNode> {
    const absolutePath = this.resolveDocumentAbsolutePath(documentPath);
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      const children = await Promise.all(
        entries
          .filter((entry) => !entry.name.startsWith("."))
          .sort((left, right) => {
            if (left.isDirectory() !== right.isDirectory()) {
              return left.isDirectory() ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
          })
          .map((entry) =>
            this.buildTreeNode(path.posix.join(documentPath.replace(/\\/g, "/"), entry.name)),
          ),
      );
      return {
        id: documentPath,
        name: path.posix.basename(documentPath),
        path: documentPath,
        kind: "folder",
        children,
      };
    }

    return {
      id: documentPath,
      name: path.posix.basename(documentPath),
      path: documentPath,
      kind: "file",
      language: inferLanguage(documentPath),
    };
  }

  private async walkFiles(
    documentPath: string,
    visitor: (documentPath: string, absolutePath: string) => Promise<void>,
  ): Promise<void> {
    const absolutePath = this.resolveDocumentAbsolutePath(documentPath);
    const stats = await fs.stat(absolutePath);
    if (stats.isFile()) {
      await visitor(documentPath, absolutePath);
      return;
    }

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const childDocumentPath = path.posix.join(documentPath.replace(/\\/g, "/"), entry.name);
      await this.walkFiles(childDocumentPath, visitor);
    }
  }

  private resolveRootAbsolutePath(): string {
    return path.resolve(this.workspaceRoot, this.rootDirName);
  }

  private resolveDocumentAbsolutePath(documentPath: string): string {
    const normalized = this.normalizeDocumentPath(documentPath);
    const absolutePath = path.resolve(this.workspaceRoot, normalized);
    const allowedRoot = this.resolveRootAbsolutePath();
    if (absolutePath !== allowedRoot && !absolutePath.startsWith(`${allowedRoot}${path.sep}`)) {
      throw new Error(`document path is outside configured root: ${documentPath}`);
    }
    return absolutePath;
  }

  private normalizeDocumentPath(documentPath: string): string {
    const normalized = path.posix.normalize(documentPath.replace(/\\/g, "/"));
    if (normalized === "." || normalized.length === 0) {
      return this.rootDirName;
    }
    if (normalized.startsWith("../") || normalized === "..") {
      throw new Error(`document path traversal is not allowed: ${documentPath}`);
    }
    if (normalized === this.rootDirName || normalized.startsWith(`${this.rootDirName}/`)) {
      return normalized;
    }
    return path.posix.join(this.rootDirName, normalized);
  }
}

async function atomicWriteText(filePath: string, value: string): Promise<void> {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(dirPath, `.${path.basename(filePath)}.${randomUUID()}.tmp`);

  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(tempPath, value, "utf8");
  await fs.rename(tempPath, filePath);
}

function computeVersion(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function inferLanguage(documentPath: string): DocumentLanguage {
  const extension = path.extname(documentPath).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  if (extension === ".py") {
    return "python";
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) {
    return "image";
  }
  return "text";
}
