import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { createAcceptanceTestCli } from "../src/cli/codefleet-acceptance-test.js";
import { createBacklogCli } from "../src/cli/codefleet-backlog.js";
import { createCodefleetCli } from "../src/cli/codefleet.js";
import { createCuratorToolsCli } from "../src/cli/codefleet-curator-tools.js";
import { createDeveloperToolsCli } from "../src/cli/codefleet-developer-tools.js";
import { createGatekeeperToolsCli } from "../src/cli/codefleet-gatekeeper-tools.js";
import { createOrchestratorToolsCli } from "../src/cli/codefleet-orchestrator-tools.js";
import { createPolisherToolsCli } from "../src/cli/codefleet-polisher-tools.js";
import { createReviewerToolsCli } from "../src/cli/codefleet-reviewer-tools.js";

async function renderHelp(command: Command): Promise<string> {
  let output = "";

  command
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        output += str;
      },
      writeErr: (str) => {
        output += str;
      },
    });

  try {
    await command.parseAsync(["--help"], { from: "user" });
  } catch {
    // `--help` exits intentionally.
  }

  return output;
}

describe("CLI command layout", () => {
  it("keeps fleet control on codefleet and leaves init as subcommand", async () => {
    const output = await renderHelp(createCodefleetCli());

    expect(output).toContain("codefleet [options] [command]");
    expect(output).toContain("status");
    expect(output).toContain("up");
    expect(output).toContain("down");
    expect(output).toContain("restart");
    expect(output).toContain("logs");
    expect(output).toContain("init");
    expect(output).toContain("state");
    expect(output).toContain("trigger");
    expect(output).toContain("supervisor");
    expect(output).not.toContain("acceptance-test");
    expect(output).not.toContain("backlog");
  });

  it("exposes acceptance-test as standalone binary", async () => {
    const output = await renderHelp(createAcceptanceTestCli());

    expect(output).toContain("codefleet-acceptance-test [options] [command]");
    expect(output).toContain("result");
    expect(output).toContain("list");
    expect(output).toContain("clear");
  });

  it("exposes backlog as standalone binary", async () => {
    const output = await renderHelp(createBacklogCli());

    expect(output).toContain("codefleet-backlog [options] [command]");
    expect(output).toContain("epic");
    expect(output).toContain("item");
    expect(output).toContain("list");
  });

  it("exposes orchestrator/developer/gatekeeper tools as standalone binaries", async () => {
    const curator = await renderHelp(createCuratorToolsCli());
    expect(curator).toContain("codefleet-curator-tools [options] [command]");
    expect(curator).toContain("agents-md");
    expect(curator).toContain("source-brief");

    const orchestrator = await renderHelp(createOrchestratorToolsCli());
    expect(orchestrator).toContain("codefleet-orchestrator-tools [options] [command]");
    expect(orchestrator).toContain("agents-md");
    expect(orchestrator).toContain("current-context");
    expect(orchestrator).toContain("epic");
    expect(orchestrator).toContain("item");
    expect(orchestrator).toContain(
      'epic upsert --id E-012 --title "Checkout Revamp" --note "Scope aligned with latest acceptance plan"',
    );
    expect(orchestrator).toContain(
      'item upsert --id I-104 --epic E-012 --title "Add E2E coverage" --note "Waiting on API contract confirmation"',
    );

    const developer = await renderHelp(createDeveloperToolsCli());
    expect(developer).toContain("codefleet-developer-tools [options] [command]");
    expect(developer).toContain("agents-md");
    expect(developer).toContain("current-context");
    expect(developer).toContain("epic");
    expect(developer).toContain("item");
    expect(developer).toContain("question");

    const gatekeeper = await renderHelp(createGatekeeperToolsCli());
    expect(gatekeeper).toContain("codefleet-gatekeeper-tools [options] [command]");
    expect(gatekeeper).toContain("agents-md");
    expect(gatekeeper).toContain("test-case");
    expect(gatekeeper).toContain("result");
    expect(gatekeeper).toContain('test-case view [--epic E-012] [--item I-104]');
    expect(gatekeeper).toContain(
      'test-case upsert --title "Checkout works on mobile" --status ready [--epic E-012] [--item I-104]',
    );
  });

  it("exposes polisher/reviewer tools as standalone binaries", async () => {
    const polisher = await renderHelp(createPolisherToolsCli());
    expect(polisher).toContain("codefleet-polisher-tools [options] [command]");
    expect(polisher).toContain("agents-md");
    expect(polisher).toContain("current-context");
    expect(polisher).toContain("epic");
    expect(polisher).toContain("item");

    const reviewer = await renderHelp(createReviewerToolsCli());
    expect(reviewer).toContain("codefleet-reviewer-tools [options] [command]");
    expect(reviewer).toContain("agents-md");
    expect(reviewer).toContain("current-context");
    expect(reviewer).toContain("epic");
    expect(reviewer).toContain("decision");
  });
});
