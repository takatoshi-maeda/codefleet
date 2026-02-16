import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import type {
  AcceptanceTestCaseStatus,
  AcceptanceTestExecutionStatus,
} from "../../domain/acceptance-testing-spec-model.js";
import { AcceptanceTestService } from "../../domain/acceptance/acceptance-test-service.js";

interface AcceptanceTestCommandOptions {
  commandName?: string;
  executableName?: string;
}

type ListOutputFormat = "json" | "table";

export function createAcceptanceTestCommand(options: AcceptanceTestCommandOptions = {}): Command {
  const service = new AcceptanceTestService();
  const commandName = options.commandName ?? "acceptance-test";
  const executableName = options.executableName ?? `codefleet ${commandName}`;

  const cmd = new Command(commandName);
  cmd.description("Manage acceptance test specifications and results.");
  cmd.option(
    "--help-for-agent",
    "Show role-specific guidance for acceptance-test command usage by agents",
  );
  cmd.action((options: { helpForAgent?: boolean }) => {
    if (!options.helpForAgent) {
      return;
    }
    console.log(buildAgentUsageHelp(executableName));
  });

  cmd
    .command("list")
    .description("List acceptance tests")
    .option("--format <format>", "Output format: json or table", "json")
    .action(async (options: { format: ListOutputFormat }) => {
      const tests = await service.list();
      if (options.format === "table") {
        console.log(formatAcceptanceTestsAsTable(tests));
        return;
      }
      console.log(JSON.stringify(tests, null, 2));
    });

  cmd
    .command("update-last-execution-status-all")
    .description("Rebuild lastExecutionStatus cache for all acceptance tests from results history")
    .option("--status <status>", "Manually set all lastExecutionStatus values (not-run|passed|failed)")
    .action(async (options: { status?: string }) => {
      const manualStatus = parseExecutionStatusOption(options.status);
      if (manualStatus) {
        await service.updateLastExecutionStatusAll(manualStatus);
        console.log(`updated lastExecutionStatus for all acceptance tests: ${manualStatus}`);
        return;
      }
      await service.selfHealLastExecutionStatus();
      console.log("updated lastExecutionStatus for all acceptance tests from results.");
    });

  cmd
    .command("add")
    .description("Add an acceptance test")
    .requiredOption("--title <title>", "Title")
    .option("--note <note>", "Note", collectRepeatable, [])
    .option("--status <status>", "Status", "draft")
    .option("--epic <epicId>", "Epic ID", collectRepeatable, [])
    .option("--item <itemId>", "Item ID", collectRepeatable, [])
    .action(async (options) => {
      const test = await service.add({
        title: options.title,
        notes: options.note,
        status: options.status as AcceptanceTestCaseStatus,
        epicIds: options.epic,
        itemIds: options.item,
      });
      console.log(JSON.stringify(test, null, 2));
    });

  cmd
    .command("update")
    .description("Update an acceptance test")
    .requiredOption("--id <id>", "Acceptance test ID")
    .option("--title <title>", "Title")
    .option("--add-note <note>", "Append note", collectRepeatable, [])
    .option("--remove-note <note>", "Remove note by exact match", collectRepeatable, [])
    .option("--status <status>", "Status")
    .option("--epic <epicId>", "Epic IDs (replace)", collectRepeatable)
    .option("--item <itemId>", "Item IDs (replace)", collectRepeatable)
    .action(async (options) => {
      const test = await service.update({
        id: options.id,
        title: options.title,
        addNotes: options.addNote,
        removeNotes: options.removeNote,
        status: options.status as AcceptanceTestCaseStatus | undefined,
        epicIds: options.epic,
        itemIds: options.item,
      });
      console.log(JSON.stringify(test, null, 2));
    });

  cmd
    .command("delete")
    .description("Delete an acceptance test")
    .requiredOption("--id <id>", "Acceptance test ID")
    .action(async (options) => {
      await service.delete(options.id);
      console.log(`deleted: ${options.id}`);
    });

  cmd
    .command("clear")
    .description("Delete all acceptance test data")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      const confirmed = options.yes
        ? true
        : await confirmClearAllData({
            input: process.stdin,
            output: process.stdout,
          });
      if (!confirmed) {
        console.log("clear cancelled.");
        return;
      }
      await service.clearAllData();
      console.log("cleared all acceptance-test data.");
    });

  const result = cmd.command("result").description("Manage acceptance test execution results");
  result
    .command("add")
    .description("Add execution result")
    .requiredOption("--id <id>", "Acceptance test ID")
    .requiredOption("--status <status>", "Result status")
    .requiredOption("--summary <summary>", "Summary")
    .option("--executor <executor>", "Executor", "manual")
    .option("--duration-ms <durationMs>", "Duration milliseconds")
    .option("--artifact <artifact>", "Artifact path", collectRepeatable, [])
    .option("--log <log>", "Log message", collectRepeatable, [])
    .action(async (options) => {
      const execution = await service.addResult({
        testId: options.id,
        status: options.status as AcceptanceTestExecutionStatus,
        summary: options.summary,
        executor: options.executor,
        durationMs: options.durationMs ? Number(options.durationMs) : undefined,
        artifacts: options.artifact,
        logs: options.log,
      });
      console.log(JSON.stringify(execution, null, 2));
    });

  return cmd;
}

function collectRepeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseExecutionStatusOption(value: string | undefined): AcceptanceTestExecutionStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "not-run" || value === "passed" || value === "failed") {
    return value;
  }
  throw new Error(`invalid --status: ${value}. Expected one of: not-run, passed, failed`);
}

function formatAcceptanceTestsAsTable(tests: ReadonlyArray<{
  id: string;
  title: string;
  status: string;
  lastExecutionStatus: string;
  epicIds: string[];
  itemIds: string[];
}>): string {
  const headers = ["ID", "Title", "Status", "Last Execution", "Epic IDs", "Item IDs"] as const;
  const rows = tests.map((test) => [
    test.id,
    test.title.replace(/\s+/g, " ").trim(),
    test.status,
    test.lastExecutionStatus,
    test.epicIds.join(", "),
    test.itemIds.join(", "),
  ]);
  if (rows.length === 0) {
    return "(no acceptance tests)";
  }
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const line = (values: readonly string[]) => values.map((value, index) => value.padEnd(widths[index])).join(" | ");
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  return [line(headers), separator, ...rows.map((row) => line(row))].join("\n");
}

async function confirmClearAllData(input: {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}): Promise<boolean> {
  if (!input.input.isTTY) {
    throw new Error("clear requires an interactive terminal confirmation. Use --yes to skip confirmation.");
  }

  const rl = createInterface({
    input: input.input,
    output: input.output,
  });
  try {
    const answer = await rl.question(
      "This will permanently delete all acceptance-test data (.codefleet/data/acceptance-testing). Continue? [y/N] ",
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function buildAgentUsageHelp(executableName: string): string {
  return [
    "# acceptance-test --help-for-agent",
    "",
    "## Role-specific use cases and recommended usage",
    "",
    "### Orchestrator",
    "- Use case: Define and maintain acceptance criteria aligned with backlog planning.",
    "- Recommended usage:",
    "  - Add or update acceptance tests before implementation starts.",
    "  - Keep epic/item links synchronized when plans change.",
    "- Key commands:",
    "```bash",
    `${executableName} add --title "..." --epic E-001 --item I-001`,
    `${executableName} update --id AT-001 --status ready --epic E-001 --item I-001`,
    `${executableName} list`,
    "```",
    "",
    "### Developer",
    "- Use case: Confirm expected behavior and readiness before coding.",
    "- Recommended usage:",
    "  - Review tests linked to your assigned item to clarify implementation intent.",
    "  - Update linked items after scope changes with orchestrator agreement.",
    "- Key commands:",
    "```bash",
    `${executableName} list`,
    `${executableName} update --id AT-001 --item I-002`,
    "```",
    "",
    "### Gatekeeper",
    "- Use case: Record verification outcomes and maintain evidence.",
    "- Recommended usage:",
    "  - Record pass/fail results with concise summaries and artifact paths.",
    "  - Keep logs and artifacts linked for traceability and audits.",
    "- Key commands:",
    "```bash",
    `${executableName} result add --id AT-001 --status passed --summary "..." --artifact path/to/report`,
    "```",
  ].join("\n");
}
