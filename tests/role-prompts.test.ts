import { describe, expect, it } from "vitest";
import { getRoleEventPromptTemplate, getRoleStartupPrompt } from "../src/domain/fleet/role-prompts.js";

describe("role prompts", () => {
  it("requires Source Brief implementation constraints in curator prompts", async () => {
    const startupPrompt = await getRoleStartupPrompt("Curator");
    const eventPrompt = await getRoleEventPromptTemplate("Curator", "source-brief.update");

    expect(startupPrompt).toContain("Implementation Constraints");
    expect(startupPrompt).toContain("reuse it verbatim as implementation guidance");
    expect(eventPrompt).toContain("Implementation Constraints");
    expect(eventPrompt).not.toContain("Write the `Implementation Constraints` section in English");
  });

  it("treats implementation constraints as normative in gatekeeper planning", async () => {
    const eventPrompt = await getRoleEventPromptTemplate("Gatekeeper", "acceptance-test.update");

    expect(eventPrompt).toContain("Implementation Constraints");
    expect(eventPrompt).toContain("normative implementation guidance");
    expect(eventPrompt).toContain("Do not add backlog Epics or Items");
    expect(eventPrompt).toContain("downstream agents");
  });

  it("requires orchestrator and gatekeeper to preserve downstream guidance in notes", async () => {
    const [orchestratorStartupPrompt, orchestratorEventPrompt, gatekeeperStartupPrompt, gatekeeperRunPrompt] =
      await Promise.all([
        getRoleStartupPrompt("Orchestrator"),
        getRoleEventPromptTemplate("Orchestrator", "backlog.update"),
        getRoleStartupPrompt("Gatekeeper"),
        getRoleEventPromptTemplate("Gatekeeper", "acceptance-test.run"),
      ]);

    expect(orchestratorStartupPrompt).toContain("Acceptance Tests, Epics, and Items");
    expect(orchestratorStartupPrompt).toContain("downstream agents");
    expect(orchestratorEventPrompt).toContain("Persist handoff context in notes");
    expect(orchestratorEventPrompt).toContain("Important downstream guidance was preserved");

    expect(gatekeeperStartupPrompt).toContain("Do not add or update backlog Epics or Items");
    expect(gatekeeperStartupPrompt).toContain("downstream agents");
    expect(gatekeeperRunPrompt).toContain("Do not add backlog Epics or Items");
    expect(gatekeeperRunPrompt).toContain("preserved in Acceptance Test notes");
  });

  it("requires downstream roles to read the Source Brief before acting", async () => {
    const [developerPrompt, reviewerPrompt, polisherPrompt] = await Promise.all([
      getRoleStartupPrompt("Developer"),
      getRoleStartupPrompt("Reviewer"),
      getRoleStartupPrompt("Polisher"),
    ]);

    expect(developerPrompt).toContain("Read `.codefleet/data/source-brief/latest.md` before implementation work");
    expect(developerPrompt).toContain("`Overview`, `Implementation Constraints`, and `Definition of Done`");

    expect(reviewerPrompt).toContain("Read `.codefleet/data/source-brief/latest.md` before reviewing");
    expect(reviewerPrompt).toContain("violations of stated implementation constraints as failing conditions");

    expect(polisherPrompt).toContain("Read `.codefleet/data/source-brief/latest.md` before polishing");
    expect(polisherPrompt).toContain("`Overview`, `Implementation Constraints`, and `Definition of Done`");
  });
});
