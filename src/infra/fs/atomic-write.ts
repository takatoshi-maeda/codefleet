import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Writes JSON data atomically using temp-file + rename.
 */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(dirPath, `.${path.basename(filePath)}.${randomUUID()}.tmp`);

  await fs.mkdir(dirPath, { recursive: true });
  const data = `${JSON.stringify(value, null, 2)}\n`;

  await fs.writeFile(tempPath, data, "utf8");
  await fs.rename(tempPath, filePath);
}
