import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFeedbackNoteAgentTools } from "../src/agents/tools/feedback-note-agent-tools.js";

describe("feedback note agent tools", () => {
  it("creates a feedback note and lists it from storage", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-feedback-notes-"));
    const tools = createFeedbackNoteAgentTools(tempDir);
    const createTool = tools.find((tool) => tool.name === "feedback_note_create");
    const listTool = tools.find((tool) => tool.name === "feedback_note_list");

    expect(createTool).toBeDefined();
    expect(listTool).toBeDefined();

    const createResult = (await createTool?.execute?.({
      summary: "CLI output is hard to read",
      details: "Long JSON blobs should be summarized by default.",
      tags: ["ux", "cli"],
      priority: "high",
      reporter: "test-user",
    })) as { note?: { id: string; summary: string; tags: string[]; priority: string } };

    expect(createResult.note?.id).toBeTruthy();
    expect(createResult.note?.summary).toBe("CLI output is hard to read");
    expect(createResult.note?.tags).toEqual(["ux", "cli"]);
    expect(createResult.note?.priority).toBe("high");
    const files = await fs.readdir(tempDir);
    expect(files.some((file) => file.endsWith(".md"))).toBe(true);

    const listResult = (await listTool?.execute?.({ tag: "ux", limit: 10 })) as {
      notes?: Array<{ id: string; summary: string; reporter: string | null }>;
      count?: number;
    };
    expect(listResult.count).toBe(1);
    expect(listResult.notes?.[0]?.summary).toBe("CLI output is hard to read");
    expect(listResult.notes?.[0]?.reporter).toBe("test-user");
  });
});
