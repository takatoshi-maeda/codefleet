import { describe, expect, it, vi } from "vitest";
import { CodefleetError } from "../src/shared/errors.js";
import { executeBacklogTool, normalizeToolArgs } from "../src/api/mcp/tools/backlog-tool-core.js";
import type { BacklogService } from "../src/domain/backlog/backlog-service.js";

describe("backlog-tool-core", () => {
  it("normalizes wrapped tool arguments", () => {
    expect(normalizeToolArgs({ arguments: { id: "I-001" } })).toEqual({ id: "I-001" });
    expect(normalizeToolArgs(undefined)).toEqual({});
  });

  it("maps validation errors to ERR_VALIDATION", async () => {
    const service = createService();
    const result = await executeBacklogTool(service, "backlog.item.get", {});
    expect(result.isError).toBe(true);
    expect(result.payload).toEqual({
      error: {
        code: "ERR_VALIDATION",
        message: "Required",
      },
    });
  });

  it("maps domain errors to codefleet error payload", async () => {
    const service = createService({
      readEpic: vi.fn(async () => {
        throw new CodefleetError("ERR_NOT_FOUND", "epic not found: E-999");
      }),
    });
    const result = await executeBacklogTool(service, "backlog.epic.get", { id: "E-999" });
    expect(result.isError).toBe(true);
    expect(result.payload).toEqual({
      error: {
        code: "ERR_NOT_FOUND",
        message: "epic not found: E-999",
      },
    });
  });

  it("returns normalized list payload for success", async () => {
    const service = createService();
    const result = await executeBacklogTool(service, "backlog.epic.list", {});
    expect(result.isError).toBe(false);
    expect(result.payload.count).toBe(1);
    expect(Array.isArray(result.payload.epics)).toBe(true);
  });
});

function createService(overrides?: Partial<BacklogService>): BacklogService {
  const base = {
    list: vi.fn(async () => ({
      epics: [{ id: "E-001" }],
      items: [{ id: "I-001", epicId: "E-001" }],
      questions: [],
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    readEpic: vi.fn(async ({ id }: { id: string }) => ({ id })),
    readItem: vi.fn(async ({ id }: { id: string }) => ({ id })),
  };
  return { ...base, ...overrides } as unknown as BacklogService;
}
