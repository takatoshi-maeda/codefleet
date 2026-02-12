import { describe, expect, it } from "vitest";
import { CodefleetError } from "../src/shared/errors.js";
import { renderEventPromptTemplate } from "../src/domain/agents/event-prompt-template.js";

describe("event-prompt-template", () => {
  it("renders received parameters directly and via event namespace", () => {
    const rendered = renderEventPromptTemplate(
      "type={{type}} namespaced={{event.type}} paths={{paths}} nested={{payload.level}}",
      {
        type: "docs.update",
        paths: ["docs/a.md", "docs/b.md"],
        payload: { level: "high" },
        event: { type: "docs.update", paths: ["docs/a.md", "docs/b.md"] },
      },
    );

    expect(rendered).toContain("type=docs.update");
    expect(rendered).toContain("namespaced=docs.update");
    expect(rendered).toContain("paths=docs/a.md, docs/b.md");
    expect(rendered).toContain("nested=high");
  });

  it("throws when template references undefined variables", () => {
    expect(() =>
      renderEventPromptTemplate("missing={{event.unknown}}", { type: "docs.update", event: { type: "docs.update" } }),
    ).toThrowError(CodefleetError);
  });
});
