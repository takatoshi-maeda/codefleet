export type ErrorCode =
  | "ERR_VALIDATION"
  | "ERR_NOT_FOUND"
  | "ERR_CONFLICT"
  | "ERR_BACKLOG_SNAPSHOT_NOT_STABLE"
  | "ERR_UNEXPECTED";

export class BuildfleetError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BuildfleetError";
  }
}
