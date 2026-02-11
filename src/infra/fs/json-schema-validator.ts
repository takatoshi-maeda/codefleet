import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv";
import * as Ajv2020Module from "ajv/dist/2020.js";
import * as AjvFormatsModule from "ajv-formats";
import { CodefleetError } from "../../shared/errors.js";

const Ajv2020Ctor = ((Ajv2020Module as unknown) as { default?: new (...args: unknown[]) => unknown }).default ??
  ((Ajv2020Module as unknown) as new (...args: unknown[]) => unknown);
const addFormats =
  ((AjvFormatsModule as unknown) as { default?: (ajvInstance: unknown) => void }).default ??
  ((AjvFormatsModule as unknown) as (ajvInstance: unknown) => void);

const ajv = new Ajv2020Ctor({ allErrors: true, strict: false }) as {
  compile: (schema: unknown) => ValidateFunction;
};
addFormats(ajv);

const validatorCache = new Map<string, ValidateFunction>();
const packageRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "schema validation failed";
  }

  return errors
    .map((error) => {
      const location = error.instancePath.length > 0 ? error.instancePath : "/";
      return `${location} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

async function loadValidator(schemaPath: string): Promise<ValidateFunction> {
  // Schema paths are package-owned assets; resolve them from package root so CLI behavior
  // stays stable regardless of the user's current working directory.
  const resolvedPath = path.isAbsolute(schemaPath) ? schemaPath : path.resolve(packageRootDir, schemaPath);

  const cached = validatorCache.get(resolvedPath);
  if (cached) {
    return cached;
  }

  let schemaRaw: string;
  try {
    schemaRaw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new CodefleetError("ERR_VALIDATION", `schema file could not be read: ${resolvedPath}`, error);
  }

  let schema: unknown;
  try {
    schema = JSON.parse(schemaRaw);
  } catch (error) {
    throw new CodefleetError("ERR_VALIDATION", `schema file is not valid JSON: ${resolvedPath}`, error);
  }

  let validator: ValidateFunction;
  try {
    validator = ajv.compile(schema);
  } catch (error) {
    throw new CodefleetError("ERR_VALIDATION", `schema file could not be compiled: ${resolvedPath}`, error);
  }

  validatorCache.set(resolvedPath, validator);
  return validator;
}

export async function validateAgainstSchema<T>(schemaPath: string, data: unknown, context: string): Promise<T> {
  const validator = await loadValidator(schemaPath);

  const valid = validator(data);
  if (!valid) {
    throw new CodefleetError(
      "ERR_VALIDATION",
      `${context}: ${formatValidationErrors(validator.errors)}`,
      validator.errors,
    );
  }

  return data as T;
}
