import { describe, expect, it } from "vitest";
import { CodefleetError } from "../src/shared/errors.js";
import { renderEventPromptTemplate } from "../src/domain/fleet/event-prompt-template.js";

describe("event-prompt-template", () => {
  it("renders received parameters directly and via event namespace", () => {
    const rendered = renderEventPromptTemplate(
      "type={{type}} namespaced={{event.type}} path={{path}} nested={{payload.level}}",
      {
        type: "release-plan.create",
        path: ".codefleet/data/release-plan/plan-a.md",
        payload: { level: "high" },
        event: { type: "release-plan.create", path: ".codefleet/data/release-plan/plan-a.md" },
      },
    );

    expect(rendered).toContain("type=release-plan.create");
    expect(rendered).toContain("namespaced=release-plan.create");
    expect(rendered).toContain("path=.codefleet/data/release-plan/plan-a.md");
    expect(rendered).toContain("nested=high");
  });

  it("throws when template references undefined variables", () => {
    expect(() =>
      renderEventPromptTemplate("missing={{event.unknown}}", {
        type: "release-plan.create",
        event: { type: "release-plan.create" },
      }),
    ).toThrowError(CodefleetError);
  });
});
