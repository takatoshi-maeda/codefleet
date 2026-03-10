import { Command } from "commander";
import type {
  BacklogEpicDevelopmentScope,
  BacklogEpicStatus,
  BacklogItemStatus,
  BacklogQuestionStatus,
  BacklogWorkKind,
  VisibilityType,
} from "../../domain/backlog-items-model.js";
import { BacklogService } from "../../domain/backlog/backlog-service.js";
import { CodefleetError } from "../../shared/errors.js";

interface BacklogCommandOptions {
  commandName?: string;
  executableName?: string;
}

export function createBacklogCommand(options: BacklogCommandOptions = {}): Command {
  const service = new BacklogService();
  const commandName = options.commandName ?? "backlog";
  const executableName = options.executableName ?? `codefleet ${commandName}`;

  const cmd = new Command(commandName);
  cmd.description("Manage backlog epics and items.");
  cmd.option("--help-for-agent", "Show role-specific guidance for backlog command usage by agents");
  cmd.action((options: { helpForAgent?: boolean }) => {
    if (!options.helpForAgent) {
      return;
    }
    console.log(buildBacklogAgentUsageHelp(executableName));
  });

  cmd
    .command("list")
    .description("List epics and items")
    .option("--status <status>", "Filter by status")
    .option("--kind <kind>", "Filter by kind (product|technical)")
    .option("--visible-only", "Show only currently visible epics/items")
    .option("--include-hidden", "Deprecated: hidden items are included by default")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const listed = await service.list({
        status: options.status as BacklogEpicStatus | BacklogItemStatus | undefined,
        kind: options.kind as BacklogWorkKind | undefined,
        includeHidden: !Boolean(options.visibleOnly),
        actorId: options.actorId,
      });
      console.log(JSON.stringify(listed, null, 2));
    });

  cmd
    .command("update-status-all-todo")
    .description("Set all epic/item statuses to todo")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const updated = await service.updateStatusAllTodo(options.actorId as string | undefined);
      console.log(JSON.stringify(updated, null, 2));
    });

  const epic = cmd.command("epic").description("Manage backlog epics");
  epic
    .command("add")
    .requiredOption("--title <title>", "Epic title")
    .option("--kind <kind>", "Epic kind (product|technical)", "product")
    .option("--development-scope <scope>", "Epic development scope (frontend|backend|other)", collectRepeatable, [])
    .option("--note <note>", "Epic note", collectRepeatable, [])
    .option("--status <status>", "Epic status", "todo")
    .option("--visibility-type <type>", "always-visible or blocked-until-epic-complete", "always-visible")
    .option("--depends-on <epicId>", "Epic dependency id", collectRepeatable, [])
    .option("--acceptance-test <testId>", "Acceptance test id", collectRepeatable, [])
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const epicResult = await service.addEpic({
        title: options.title,
        kind: options.kind as BacklogWorkKind,
        developmentScopes: options.developmentScope as BacklogEpicDevelopmentScope[],
        notes: options.note,
        status: options.status as BacklogEpicStatus,
        visibility: {
          type: options.visibilityType as VisibilityType,
          dependsOnEpicIds: options.dependsOn,
        },
        acceptanceTestIds: options.acceptanceTest,
        actorId: options.actorId,
      });
      console.log(JSON.stringify(epicResult, null, 2));
    });

  epic
    .command("list")
    .description("List epics")
    .option("--status <status>", "Filter by status")
    .option("--kind <kind>", "Filter by kind (product|technical)")
    .option("--visible-only", "Show only currently visible epics")
    .option("--include-hidden", "Deprecated: hidden epics are included by default")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const listed = await service.list({
        status: options.status as BacklogEpicStatus | undefined,
        kind: options.kind as BacklogWorkKind | undefined,
        includeHidden: !Boolean(options.visibleOnly),
        actorId: options.actorId,
      });
      console.log(JSON.stringify(listed.epics, null, 2));
    });

  epic
    .command("ready")
    .description("List startable epics (todo, changes-requested, failed) filtered by visibility dependencies")
    .action(async () => {
      const listed = await service.listReadyEpics();
      console.log(JSON.stringify(listed, null, 2));
    });

  epic
    .command("read")
    .description("Read epic by id")
    .requiredOption("--id <id>", "Epic id")
    .action(async (options) => {
      const listed = await service.list({ includeHidden: true });
      const found = listed.epics.find((epic) => epic.id === options.id);
      if (!found) {
        throw new CodefleetError("ERR_NOT_FOUND", `epic not found: ${options.id}`);
      }
      console.log(JSON.stringify(found, null, 2));
    });

  epic
    .command("update")
    .requiredOption("--id <id>", "Epic id")
    .option("--title <title>", "Epic title")
    .option("--kind <kind>", "Epic kind (product|technical)")
    .option("--development-scope <scope>", "Epic development scope ids (replace: frontend|backend|other)", collectRepeatable)
    .option("--add-note <note>", "Append epic note", collectRepeatable, [])
    .option("--remove-note <note>", "Remove epic note by exact match", collectRepeatable, [])
    .option("--status <status>", "Epic status")
    .option("--reopen", "Allow done -> in-progress")
    .option("--force", "Bypass epic status transition guard")
    .option("--visibility-type <type>", "always-visible or blocked-until-epic-complete")
    .option("--depends-on <epicId>", "Epic dependency ids (replace)", collectRepeatable)
    .option("--acceptance-test <testId>", "Acceptance test ids (replace)", collectRepeatable)
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const visibility =
        options.visibilityType || options.dependsOn
          ? {
              type: (options.visibilityType ?? "always-visible") as VisibilityType,
              dependsOnEpicIds: options.dependsOn ?? [],
            }
          : undefined;
      const updated = await service.updateEpic({
        id: options.id,
        title: options.title,
        kind: options.kind as BacklogWorkKind | undefined,
        developmentScopes: options.developmentScope as BacklogEpicDevelopmentScope[] | undefined,
        addNotes: options.addNote,
        removeNotes: options.removeNote,
        status: options.status as BacklogEpicStatus | undefined,
        reopen: Boolean(options.reopen),
        force: Boolean(options.force),
        visibility,
        acceptanceTestIds: options.acceptanceTest,
        actorId: options.actorId,
      });
      console.log(JSON.stringify(updated, null, 2));
    });

  epic
    .command("delete")
    .requiredOption("--id <id>", "Epic id")
    .option("--force", "Force delete with linked items")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      await service.deleteEpic(options.id, Boolean(options.force), options.actorId);
      console.log(`deleted epic: ${options.id}`);
    });

  const item = cmd.command("item").description("Manage backlog items");
  item
    .command("add")
    .requiredOption("--epic <epicId>", "Epic id")
    .requiredOption("--title <title>", "Item title")
    .option("--kind <kind>", "Item kind (product|technical)", "product")
    .option("--note <note>", "Item note", collectRepeatable, [])
    .option("--status <status>", "Item status", "todo")
    .option("--acceptance-test <testId>", "Acceptance test id", collectRepeatable, [])
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const added = await service.addItem({
        epicId: options.epic,
        title: options.title,
        kind: options.kind as BacklogWorkKind,
        notes: options.note,
        status: options.status as BacklogItemStatus,
        acceptanceTestIds: options.acceptanceTest,
        actorId: options.actorId,
      });
      console.log(JSON.stringify(added, null, 2));
    });

  item
    .command("list")
    .description("List backlog items")
    .option("--epic-id <epicId>", "Filter by epic id")
    .option("--status <status>", "Filter by status")
    .option("--kind <kind>", "Filter by kind (product|technical)")
    .option("--visible-only", "Show only items linked to currently visible epics")
    .option("--include-hidden", "Deprecated: hidden items are included by default")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const listed = await service.list({
        epicId: options.epicId as string | undefined,
        status: options.status as BacklogItemStatus | undefined,
        kind: options.kind as BacklogWorkKind | undefined,
        includeHidden: !Boolean(options.visibleOnly),
        actorId: options.actorId,
      });
      console.log(JSON.stringify(listed.items, null, 2));
    });

  item
    .command("read")
    .description("Read item by id")
    .requiredOption("--id <id>", "Item id")
    .action(async (options) => {
      const listed = await service.list({ includeHidden: true });
      const found = listed.items.find((item) => item.id === options.id);
      if (!found) {
        throw new CodefleetError("ERR_NOT_FOUND", `item not found: ${options.id}`);
      }
      console.log(JSON.stringify(found, null, 2));
    });

  item
    .command("update")
    .requiredOption("--id <id>", "Item id")
    .option("--title <title>", "Item title")
    .option("--kind <kind>", "Item kind (product|technical)")
    .option("--add-note <note>", "Append item note", collectRepeatable, [])
    .option("--remove-note <note>", "Remove item note by exact match", collectRepeatable, [])
    .option("--status <status>", "Item status")
    .option("--reopen", "Allow done -> in-progress")
    .option("--acceptance-test <testId>", "Acceptance test ids (replace)", collectRepeatable)
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const updated = await service.updateItem({
        id: options.id,
        title: options.title,
        kind: options.kind as BacklogWorkKind | undefined,
        addNotes: options.addNote,
        removeNotes: options.removeNote,
        status: options.status as BacklogItemStatus | undefined,
        reopen: Boolean(options.reopen),
        acceptanceTestIds: options.acceptanceTest,
        actorId: options.actorId,
      });
      console.log(JSON.stringify(updated, null, 2));
    });

  item
    .command("delete")
    .requiredOption("--id <id>", "Item id")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      await service.deleteItem(options.id, options.actorId);
      console.log(`deleted item: ${options.id}`);
    });

  const question = cmd.command("question").description("Manage backlog questions");
  question
    .command("add")
    .requiredOption("--title <title>", "Question title")
    .option("--details <details>", "Question details")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const added = await service.addQuestion({
        title: options.title,
        details: options.details,
        actorId: options.actorId,
      });
      console.log(JSON.stringify(added, null, 2));
    });

  question
    .command("list")
    .description("List backlog questions")
    .option("--status <status>", "Filter by status")
    .action(async (options) => {
      const listed = await service.listQuestions();
      const filtered =
        options.status === undefined
          ? listed
          : listed.filter((entry) => entry.status === (options.status as BacklogQuestionStatus));
      console.log(JSON.stringify(filtered, null, 2));
    });

  question
    .command("update")
    .requiredOption("--id <id>", "Question id")
    .option("--title <title>", "Question title")
    .option("--details <details>", "Question details")
    .option("--status <status>", "Question status")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const updated = await service.updateQuestion({
        id: options.id,
        title: options.title,
        details: options.details,
        status: options.status as BacklogQuestionStatus | undefined,
        actorId: options.actorId,
      });
      console.log(JSON.stringify(updated, null, 2));
    });

  question
    .command("answer")
    .requiredOption("--id <id>", "Question id")
    .requiredOption("--answer <answer>", "Question answer")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const updated = await service.answerQuestion({
        id: options.id,
        answer: options.answer,
        actorId: options.actorId,
      });
      console.log(JSON.stringify(updated, null, 2));
    });

  question
    .command("delete")
    .requiredOption("--id <id>", "Question id")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      await service.deleteQuestion(options.id, options.actorId);
      console.log(`deleted question: ${options.id}`);
    });

  return cmd;
}

function collectRepeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function buildBacklogAgentUsageHelp(executableName: string): string {
  // Keep this output stable and markdown-oriented so agents can consume it as structured CLI guidance.
  return [
    "# backlog --help-for-agent",
    "",
    "## Role-specific use cases and recommended usage",
    "",
    "### Orchestrator",
    "- Use case: Break down implementation work and maintain execution order across epics and items.",
    "- Recommended usage:",
    "  - Create epics first, then add items linked to the right epic.",
    "  - Use visibility/dependency settings to prevent agents from starting blocked work.",
    "  - Register open questions as soon as planning uncertainty is detected, then answer/close them explicitly.",
    "- Key commands:",
    "```bash",
    `${executableName} epic add --title \"...\" --kind product --development-scope frontend --visibility-type always-visible`,
    `${executableName} epic add --title \"...\" --kind technical --development-scope backend --visibility-type always-visible`,
    `${executableName} item add --epic E-001 --title \"...\"`,
    `${executableName} question add --title \"...\" --details \"...\"`,
    `${executableName} question answer --id Q-001 --answer \"...\"`,
    `${executableName} epic ready`,
    `${executableName} list`,
    "```",
    "",
    "### Developer",
    "- Use case: Understand assigned scope and keep implementation progress synchronized.",
    "- Recommended usage:",
    "  - Inspect epic/item status before starting implementation.",
    "  - Update item status and notes to leave a clear handoff trail.",
    "  - Review and answer implementation questions when decisions become clear during coding.",
    "- Key commands:",
    "```bash",
    `${executableName} item list --status in-progress`,
    `${executableName} item update --id I-001 --kind technical --status done --add-note \"...\"`,
    `${executableName} question list --status open`,
    `${executableName} question answer --id Q-001 --answer \"...\"`,
    "```",
    "",
    "### Polisher",
    "- Use case: Refine UI-layer quality after implementation while preserving requirement intent.",
    "- Recommended usage:",
    "  - Confirm which Epic/Items include UI changes before polishing.",
    "  - Keep changes minimal and remove unnecessary explanatory text.",
    "  - Leave clear notes when UI polish choices depend on requirement interpretation.",
    "- Key commands:",
    "```bash",
    `${executableName} epic read --id E-001`,
    `${executableName} item list --epic-id E-001`,
    `${executableName} item update --id I-001 --add-note \"UI polish rationale: ...\"`,
    "```",
    "",
    "### Gatekeeper",
    "- Use case: Validate completion gates and keep backlog state aligned with verification outcomes.",
    "- Recommended usage:",
    "  - Reopen items when acceptance verification fails.",
    "  - Confirm linked epics/items are consistent with test and review outcomes.",
    "  - Raise unresolved quality questions and verify they are answered before closure.",
    "- Key commands:",
    "```bash",
    `${executableName} item update --id I-001 --status in-progress --reopen`,
    `${executableName} epic list --status done`,
    `${executableName} question add --title \"...\" --details \"...\"`,
    `${executableName} question list --status open`,
    "```",
    "",
    "### Reviewer",
    "- Use case: Decide whether implementation can be accepted or must return to Developer for fixes.",
    "- Recommended usage:",
    "  - Verify Epic/Item behavior and user-facing quality before acceptance.",
    "  - Mark Epic as done only when review passes.",
    "  - When issues are found, return Epic to in-progress and re-trigger implementation for the same Epic.",
    "- Key commands:",
    "```bash",
    `${executableName} epic read --id E-001`,
    `${executableName} item list --epic-id E-001`,
    `${executableName} epic update --id E-001 --status done`,
    `${executableName} epic update --id E-001 --status changes-requested`,
    "codefleet trigger backlog.epic.ready --epic-id E-001",
    "```",
  ].join("\n");
}
