import { Command } from "commander";
import type {
  AcceptanceTestCaseStatus,
  AcceptanceTestExecutionStatus,
} from "../../domain/acceptance-testing-spec-model.js";
import { AcceptanceTestService } from "../../domain/acceptance/acceptance-test-service.js";

export function createAcceptanceTestCommand(): Command {
  const service = new AcceptanceTestService();

  const cmd = new Command("acceptance-test");
  cmd.description("Manage acceptance test specifications and results.");
  cmd.option(
    "--help-for-agent",
    "Show role-specific guidance for acceptance-test command usage by agents",
  );
  cmd.action((options: { helpForAgent?: boolean }) => {
    if (!options.helpForAgent) {
      return;
    }
    console.log(buildAgentUsageHelp());
  });

  cmd
    .command("list")
    .description("List acceptance tests")
    .action(async () => {
      const tests = await service.list();
      console.log(JSON.stringify(tests, null, 2));
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

function buildAgentUsageHelp(): string {
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
    "codefleet acceptance-test add --title \"...\" --epic E-001 --item I-001",
    "codefleet acceptance-test update --id AT-001 --status ready --epic E-001 --item I-001",
    "codefleet acceptance-test list",
    "```",
    "",
    "### Developer",
    "- Use case: Confirm expected behavior and readiness before coding.",
    "- Recommended usage:",
    "  - Review tests linked to your assigned item to clarify implementation intent.",
    "  - Update linked items after scope changes with orchestrator agreement.",
    "- Key commands:",
    "```bash",
    "codefleet acceptance-test list",
    "codefleet acceptance-test update --id AT-001 --item I-002",
    "```",
    "",
    "### Gatekeeper",
    "- Use case: Record verification outcomes and maintain evidence.",
    "- Recommended usage:",
    "  - Record pass/fail results with concise summaries and artifact paths.",
    "  - Keep logs and artifacts linked for traceability and audits.",
    "- Key commands:",
    "```bash",
    "codefleet acceptance-test result add --id AT-001 --status passed --summary \"...\" --artifact path/to/report",
    "```",
  ].join("\n");
}
