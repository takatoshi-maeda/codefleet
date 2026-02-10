import { promises as fs } from "node:fs";
import { BuildfleetError } from "../../shared/errors.js";
import type { Repository } from "../../shared/repository.js";
import { atomicWriteJson } from "./atomic-write.js";
import { validateAgainstSchema } from "./json-schema-validator.js";

export class JsonRepository<TEntity> implements Repository<TEntity> {
  constructor(
    private readonly filePath: string,
    private readonly schemaPath: string,
  ) {}

  async get(): Promise<TEntity> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      throw new BuildfleetError("ERR_NOT_FOUND", `file not found: ${this.filePath}`, error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new BuildfleetError("ERR_VALIDATION", `file is not valid JSON: ${this.filePath}`, error);
    }

    return validateAgainstSchema<TEntity>(this.schemaPath, parsed, `read validation failed (${this.filePath})`);
  }

  async save(entity: TEntity): Promise<void> {
    await validateAgainstSchema<TEntity>(this.schemaPath, entity, `write pre-validation failed (${this.filePath})`);

    await atomicWriteJson(this.filePath, entity);

    const persisted = await this.get();
    await validateAgainstSchema<TEntity>(
      this.schemaPath,
      persisted,
      `write post-validation failed (${this.filePath})`,
    );
  }
}
