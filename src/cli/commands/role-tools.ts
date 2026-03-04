import { promises as fs } from "node:fs";
import { Command } from "commander";
import type {
  AcceptanceTestCase,
  AcceptanceTestCaseStatus,
  AcceptanceTestExecutionStatus,
} from "../../domain/acceptance-testing-spec-model.js";
import { AcceptanceTestService } from "../../domain/acceptance/acceptance-test-service.js";
import { BacklogService } from "../../domain/backlog/backlog-service.js";
import type {
  BacklogEpic,
  BacklogEpicStatus,
  BacklogItem,
  BacklogItemStatus,
  BacklogQuestion,
  BacklogQuestionStatus,
  BacklogWorkKind,
  VisibilityType,
} from "../../domain/backlog-items-model.js";

interface RoleToolsCommandOptions {
  commandName?: string;
  executableName?: string;
}

interface GlobalCliOptions {
  dryRun?: boolean;
  actorId?: string;
  verbose?: boolean;
}

interface ResolvedGlobalOptions {
  dryRun: boolean;
  actorId?: string;
  verbose: boolean;
}

export function createOrchestratorToolsCommand(options: RoleToolsCommandOptions = {}): Command {
  const service = new BacklogService();
  const commandName = options.commandName ?? "orchestrator-tools";
  const executableName = options.executableName ?? `codefleet-${commandName}`;

  const cmd = new Command(commandName);
  cmd.description("Role-specific CLI for orchestrator planning and backlog synchronization.");
  addGlobalOptions(cmd);
  cmd.addHelpText("after", `\n${buildOrchestratorManual(executableName)}\n`);

  const currentContext = cmd.command("current-context").description("Read current planning context");
  currentContext
    .command("view")
    .description("Show requirements, epics, items, and open questions")
    .action(async function handleCurrentContextView(this: Command) {
      const global = resolveGlobalOptions(this);
      const [requirements, listed, questions] = await Promise.all([
        service.readRequirements(),
        service.list({ actorId: global.actorId }),
        service.listQuestions(),
      ]);
      const openQuestions = questions.filter((question) => question.status === "open");
      console.log(renderOrchestratorContextMarkdown(requirements, listed.epics, listed.items, openQuestions, global));
    });

  const requirements = cmd.command("requirements").description("Manage requirements document");
  requirements
    .command("update")
    .description("Update requirements from text or file")
    .option("--file <path>", "Read requirements text from file")
    .option("--text <text>", "Inline requirements text")
    .action(async function handleRequirementsUpdate(this: Command, options: { file?: string; text?: string }) {
      const global = resolveGlobalOptions(this);
      const hasFile = typeof options.file === "string";
      const hasText = typeof options.text === "string";
      if ((hasFile && hasText) || (!hasFile && !hasText)) {
        throw new Error("requirements update requires exactly one input: --file <path> or --text <text>");
      }

      const nextText = hasFile ? await fs.readFile(options.file as string, "utf8") : (options.text as string);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Requirements Update (dry-run)",
            summary: [`Would update requirements (${nextText.length} chars).`],
            result: {
              source: hasFile ? `file:${options.file}` : "inline-text",
              preview: nextText.slice(0, 200),
            },
            verbose: global.verbose,
          }),
        );
        return;
      }

      const updated = await service.writeRequirements(nextText);
      console.log(
        renderMutationMarkdown({
          title: "Requirements Updated",
          summary: [`Updated requirements (${updated.length} chars).`],
          result: {
            source: hasFile ? `file:${options.file}` : "inline-text",
          },
          verbose: global.verbose,
        }),
      );
    });

  const epic = cmd.command("epic").description("Manage epics");
  epic
    .command("upsert")
    .description("Create or update an epic")
    .option("--id <id>", "Epic id (update mode)")
    .requiredOption("--title <title>", "Epic title")
    .option("--kind <kind>", "Epic kind (product|technical)")
    .option("--status <status>", "Epic status")
    .option("--visibility-type <type>", "always-visible or blocked-until-epic-complete")
    .option("--depends-on <epicId>", "Epic dependency id", collectRepeatable, [])
    .option("--acceptance-test <testId>", "Linked acceptance test id", collectRepeatable, [])
    .action(async function handleEpicUpsert(
      this: Command,
      options: {
        id?: string;
        title: string;
        kind?: BacklogWorkKind;
        status?: BacklogEpicStatus;
        visibilityType?: VisibilityType;
        dependsOn: string[];
        acceptanceTest: string[];
      },
    ) {
      const global = resolveGlobalOptions(this);
      const visibility =
        options.visibilityType || options.dependsOn.length > 0
          ? {
              type: (options.visibilityType ?? "always-visible") as VisibilityType,
              dependsOnEpicIds: options.dependsOn,
            }
          : undefined;

      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: `Epic ${options.id ? "Update" : "Create"} (dry-run)`,
            summary: [
              options.id ? `Would update epic ${options.id}.` : "Would create a new epic.",
              `title: ${options.title}`,
            ],
            result: {
              id: options.id,
              title: options.title,
              kind: options.kind,
              status: options.status,
              visibility,
              acceptanceTestIds: options.acceptanceTest,
            },
            verbose: global.verbose,
          }),
        );
        return;
      }

      const updated = options.id
        ? await service.updateEpic({
            id: options.id,
            title: options.title,
            kind: options.kind,
            status: options.status,
            visibility,
            acceptanceTestIds: options.acceptanceTest.length > 0 ? options.acceptanceTest : undefined,
            actorId: global.actorId,
          })
        : await service.addEpic({
            title: options.title,
            kind: options.kind,
            status: options.status,
            visibility,
            acceptanceTestIds: options.acceptanceTest,
            actorId: global.actorId,
          });

      console.log(
        renderMutationMarkdown({
          title: `Epic ${options.id ? "Updated" : "Created"}`,
          summary: [`${updated.id}: ${updated.title}`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  const item = cmd.command("item").description("Manage backlog items");
  item
    .command("upsert")
    .description("Create or update an item")
    .option("--id <id>", "Item id (update mode)")
    .option("--epic <epicId>", "Epic id")
    .requiredOption("--title <title>", "Item title")
    .option("--kind <kind>", "Item kind (product|technical)")
    .option("--status <status>", "Item status")
    .option("--acceptance-test <testId>", "Linked acceptance test id", collectRepeatable, [])
    .action(async function handleItemUpsert(
      this: Command,
      options: {
        id?: string;
        epic?: string;
        title: string;
        kind?: BacklogWorkKind;
        status?: BacklogItemStatus;
        acceptanceTest: string[];
      },
    ) {
      const global = resolveGlobalOptions(this);
      if (!options.id && !options.epic) {
        throw new Error("item upsert in create mode requires --epic <E-xxx>");
      }

      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: `Item ${options.id ? "Update" : "Create"} (dry-run)`,
            summary: [
              options.id ? `Would update item ${options.id}.` : `Would create an item under epic ${options.epic}.`,
              `title: ${options.title}`,
            ],
            result: {
              id: options.id,
              epicId: options.epic,
              title: options.title,
              kind: options.kind,
              status: options.status,
              acceptanceTestIds: options.acceptanceTest,
            },
            verbose: global.verbose,
          }),
        );
        return;
      }

      const updated = options.id
        ? await service.updateItem({
            id: options.id,
            title: options.title,
            kind: options.kind,
            status: options.status,
            acceptanceTestIds: options.acceptanceTest.length > 0 ? options.acceptanceTest : undefined,
            actorId: global.actorId,
          })
        : await service.addItem({
            epicId: options.epic as string,
            title: options.title,
            kind: options.kind,
            status: options.status,
            acceptanceTestIds: options.acceptanceTest,
            actorId: global.actorId,
          });

      console.log(
        renderMutationMarkdown({
          title: `Item ${options.id ? "Updated" : "Created"}`,
          summary: [`${updated.id}: ${updated.title}`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  const question = cmd.command("question").description("Manage planning questions");
  question
    .command("add")
    .description("Add an open question")
    .requiredOption("--title <title>", "Question title")
    .option("--details <details>", "Question details")
    .action(async function handleQuestionAdd(this: Command, options: { title: string; details?: string }) {
      const global = resolveGlobalOptions(this);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Question Add (dry-run)",
            summary: [`Would add open question: ${options.title}`],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }

      const added = await service.addQuestion({
        title: options.title,
        details: options.details,
        actorId: global.actorId,
      });
      console.log(
        renderMutationMarkdown({
          title: "Question Added",
          summary: [`${added.id}: ${added.title}`],
          result: added,
          verbose: global.verbose,
        }),
      );
    });

  return cmd;
}

export function createDeveloperToolsCommand(options: RoleToolsCommandOptions = {}): Command {
  const service = new BacklogService();
  const commandName = options.commandName ?? "developer-tools";
  const executableName = options.executableName ?? `codefleet-${commandName}`;

  const cmd = new Command(commandName);
  cmd.description("Role-specific CLI for developer execution tracking.");
  addGlobalOptions(cmd);
  cmd.addHelpText("after", `\n${buildDeveloperManual(executableName)}\n`);

  const currentContext = cmd.command("current-context").description("Read implementation context");
  currentContext
    .command("view")
    .requiredOption("--epic <id>", "Epic id")
    .action(async function handleCurrentContextView(this: Command, options: { epic: string }) {
      const global = resolveGlobalOptions(this);
      const [requirements, epic, listed] = await Promise.all([
        service.readRequirements(),
        service.readEpic({ id: options.epic }),
        service.list({ epicId: options.epic, actorId: global.actorId }),
      ]);
      console.log(renderDeveloperContextMarkdown(requirements, epic, listed.items, global));
    });

  const item = cmd.command("item").description("Manage implementation items");
  item
    .command("start")
    .requiredOption("--id <id>", "Item id")
    .option("--note <text>", "Start note")
    .action(async function handleItemStart(this: Command, options: { id: string; note?: string }) {
      const global = resolveGlobalOptions(this);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Item Start (dry-run)",
            summary: [`Would set ${options.id} to in-progress.`],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }
      const updated = await service.updateItem({
        id: options.id,
        status: "in-progress",
        addNotes: options.note ? [options.note] : undefined,
        actorId: global.actorId,
      });
      console.log(
        renderMutationMarkdown({
          title: "Item Started",
          summary: [`${updated.id} is now ${updated.status}.`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  item
    .command("note")
    .requiredOption("--id <id>", "Item id")
    .requiredOption("--note <text>", "Note text")
    .action(async function handleItemNote(this: Command, options: { id: string; note: string }) {
      const global = resolveGlobalOptions(this);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Item Note (dry-run)",
            summary: [`Would append a note to ${options.id}.`],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }
      const updated = await service.updateItem({ id: options.id, addNotes: [options.note], actorId: global.actorId });
      console.log(
        renderMutationMarkdown({
          title: "Item Note Added",
          summary: [`Added note to ${updated.id}.`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  item
    .command("done")
    .requiredOption("--id <id>", "Item id")
    .option("--note <text>", "Completion note")
    .action(async function handleItemDone(this: Command, options: { id: string; note?: string }) {
      const global = resolveGlobalOptions(this);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Item Done (dry-run)",
            summary: [`Would set ${options.id} to done.`],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }
      const updated = await service.updateItem({
        id: options.id,
        status: "done",
        addNotes: options.note ? [options.note] : undefined,
        actorId: global.actorId,
      });
      console.log(
        renderMutationMarkdown({
          title: "Item Completed",
          summary: [`${updated.id} is now ${updated.status}.`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  const question = cmd.command("question").description("Manage implementation questions");
  question
    .command("inbox")
    .option("--status <status>", "Question status filter", "open")
    .action(async function handleQuestionInbox(this: Command, options: { status: BacklogQuestionStatus }) {
      const global = resolveGlobalOptions(this);
      const questions = await service.listQuestions();
      const filtered = questions.filter((entry) => entry.status === options.status);
      console.log(renderQuestionsMarkdown(filtered, `Question Inbox (${options.status})`, global));
    });

  question
    .command("answer")
    .requiredOption("--id <id>", "Question id")
    .requiredOption("--answer <text>", "Answer text")
    .action(async function handleQuestionAnswer(this: Command, options: { id: string; answer: string }) {
      const global = resolveGlobalOptions(this);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Question Answer (dry-run)",
            summary: [`Would answer ${options.id}.`],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }
      const updated = await service.answerQuestion({ id: options.id, answer: options.answer, actorId: global.actorId });
      console.log(
        renderMutationMarkdown({
          title: "Question Answered",
          summary: [`${updated.id} marked as answered.`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  return cmd;
}

export function createGatekeeperToolsCommand(options: RoleToolsCommandOptions = {}): Command {
  const backlogService = new BacklogService();
  const acceptanceService = new AcceptanceTestService();
  const commandName = options.commandName ?? "gatekeeper-tools";
  const executableName = options.executableName ?? `codefleet-${commandName}`;

  const cmd = new Command(commandName);
  cmd.description("Role-specific CLI for acceptance planning and result recording.");
  addGlobalOptions(cmd);
  cmd.addHelpText("after", `\n${buildGatekeeperManual(executableName)}\n`);

  const testCase = cmd.command("test-case").description("Manage acceptance test cases");
  testCase
    .command("view")
    .option("--epic <id>", "Filter by epic id")
    .option("--item <id>", "Filter by item id")
    .action(async function handleTestCaseView(this: Command, options: { epic?: string; item?: string }) {
      const global = resolveGlobalOptions(this);
      const tests = await acceptanceService.list();
      const filtered = tests.filter(
        (test) => (!options.epic || test.epicIds.includes(options.epic)) && (!options.item || test.itemIds.includes(options.item)),
      );
      console.log(renderAcceptanceTestsMarkdown(filtered, "Acceptance Test Cases", global));
    });

  testCase
    .command("upsert")
    .requiredOption("--title <text>", "Test title")
    .option("--id <id>", "Acceptance test id (update mode)")
    .option("--status <status>", "draft or ready")
    .option("--epic <id>", "Epic id", collectRepeatable, [])
    .option("--item <id>", "Item id", collectRepeatable, [])
    .option("--note <note>", "Single note to append")
    .action(async function handleTestCaseUpsert(
      this: Command,
      options: {
        title: string;
        id?: string;
        status?: AcceptanceTestCaseStatus;
        epic: string[];
        item: string[];
        note?: string;
      },
    ) {
      const global = resolveGlobalOptions(this);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: `Test Case ${options.id ? "Update" : "Create"} (dry-run)`,
            summary: [options.id ? `Would update ${options.id}.` : "Would create a new acceptance test."],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }

      const updated = options.id
        ? await acceptanceService.update({
            id: options.id,
            title: options.title,
            status: options.status,
            addNotes: options.note ? [options.note] : undefined,
            epicIds: options.epic.length > 0 ? options.epic : undefined,
            itemIds: options.item.length > 0 ? options.item : undefined,
          })
        : await acceptanceService.add({
            title: options.title,
            status: options.status,
            notes: options.note ? [options.note] : [],
            epicIds: options.epic,
            itemIds: options.item,
          });

      if (!options.id && options.epic.length > 0) {
        await attachAcceptanceTestToBacklog(backlogService, updated.id, options.epic, options.item, global, global.dryRun);
      }

      console.log(
        renderMutationMarkdown({
          title: `Test Case ${options.id ? "Updated" : "Created"}`,
          summary: [`${updated.id}: ${updated.title}`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  const result = cmd.command("result").description("Manage acceptance execution results");
  result
    .command("save")
    .requiredOption("--id <id>", "Acceptance test id")
    .requiredOption("--status <status>", "passed or failed")
    .requiredOption("--summary <text>", "Summary")
    .requiredOption("--last-execution-note <text>", "Execution note stored in spec cache")
    .option("--artifact <path>", "Artifact path", collectRepeatable, [])
    .option("--log <line>", "Log line", collectRepeatable, [])
    .option("--duration-ms <ms>", "Duration in milliseconds")
    .action(async function handleResultSave(
      this: Command,
      options: {
        id: string;
        status: AcceptanceTestExecutionStatus;
        summary: string;
        lastExecutionNote: string;
        artifact: string[];
        log: string[];
        durationMs?: string;
      },
    ) {
      const global = resolveGlobalOptions(this);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Result Save (dry-run)",
            summary: [`Would save execution result for ${options.id}.`],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }

      const saved = await acceptanceService.addResult({
        testId: options.id,
        status: options.status,
        summary: options.summary,
        lastExecutionNote: options.lastExecutionNote,
        executor: global.actorId ?? "gatekeeper",
        durationMs: options.durationMs ? Number(options.durationMs) : undefined,
        artifacts: options.artifact,
        logs: options.log,
      });

      console.log(
        renderMutationMarkdown({
          title: "Result Saved",
          summary: [`Saved ${saved.resultId} for ${saved.testId}.`],
          result: saved,
          verbose: global.verbose,
        }),
      );
    });

  return cmd;
}

export function createPolisherToolsCommand(options: RoleToolsCommandOptions = {}): Command {
  const service = new BacklogService();
  const commandName = options.commandName ?? "polisher-tools";
  const executableName = options.executableName ?? `codefleet-${commandName}`;

  const cmd = new Command(commandName);
  cmd.description("Role-specific CLI for UI polishing context and notes.");
  addGlobalOptions(cmd);
  cmd.addHelpText("after", `\n${buildPolisherManual(executableName)}\n`);

  const currentContext = cmd.command("current-context").description("Read polishing context");
  currentContext
    .command("view")
    .requiredOption("--epic <id>", "Epic id")
    .action(async function handleCurrentContextView(this: Command, options: { epic: string }) {
      const global = resolveGlobalOptions(this);
      const [requirements, epic, listed] = await Promise.all([
        service.readRequirements(),
        service.readEpic({ id: options.epic }),
        service.list({ epicId: options.epic, actorId: global.actorId }),
      ]);
      console.log(renderDeveloperContextMarkdown(requirements, epic, listed.items, global));
    });

  const item = cmd.command("item").description("Manage polishing notes");
  item
    .command("add-note")
    .requiredOption("--id <id>", "Item id")
    .requiredOption("--note <text>", "Polishing rationale")
    .action(async function handleAddNote(this: Command, options: { id: string; note: string }) {
      const global = resolveGlobalOptions(this);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Item Add Note (dry-run)",
            summary: [`Would append a polishing note to ${options.id}.`],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }

      const updated = await service.updateItem({
        id: options.id,
        addNotes: [options.note],
        actorId: global.actorId,
      });

      console.log(
        renderMutationMarkdown({
          title: "Item Note Added",
          summary: [`Added polishing note to ${updated.id}.`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  return cmd;
}

export function createReviewerToolsCommand(options: RoleToolsCommandOptions = {}): Command {
  const service = new BacklogService();
  const commandName = options.commandName ?? "reviewer-tools";
  const executableName = options.executableName ?? `codefleet-${commandName}`;

  const cmd = new Command(commandName);
  cmd.description("Role-specific CLI for review decisions.");
  addGlobalOptions(cmd);
  cmd.addHelpText("after", `\n${buildReviewerManual(executableName)}\n`);

  const currentContext = cmd.command("current-context").description("Read review context");
  currentContext
    .command("view")
    .requiredOption("--epic <id>", "Epic id")
    .action(async function handleCurrentContextView(this: Command, options: { epic: string }) {
      const global = resolveGlobalOptions(this);
      const [epic, listed] = await Promise.all([
        service.readEpic({ id: options.epic }),
        service.list({ epicId: options.epic, actorId: global.actorId }),
      ]);
      console.log(renderReviewerContextMarkdown(epic, listed.items, global));
    });

  const decision = cmd.command("decision").description("Record review decision");
  decision
    .command("pass")
    .requiredOption("--epic <id>", "Epic id")
    .option("--note <text>", "Optional decision note")
    .action(async function handlePass(this: Command, options: { epic: string; note?: string }) {
      const global = resolveGlobalOptions(this);
      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Decision Pass (dry-run)",
            summary: [`Would mark ${options.epic} as done.`],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }

      const updated = await service.updateEpic({
        id: options.epic,
        status: "done",
        addNotes: options.note ? [options.note] : undefined,
        actorId: global.actorId,
      });

      console.log(
        renderMutationMarkdown({
          title: "Decision Recorded: PASS",
          summary: [`${updated.id} is now ${updated.status}.`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  decision
    .command("changes-requested")
    .requiredOption("--epic <id>", "Epic id")
    .requiredOption("--rationale <text>", "Mandatory rationale including repro/expected/cause/fix")
    .action(async function handleChangesRequested(this: Command, options: { epic: string; rationale: string }) {
      const global = resolveGlobalOptions(this);
      validateChangesRequestedRationale(options.rationale);

      if (global.dryRun) {
        console.log(
          renderMutationMarkdown({
            title: "Decision Changes-Requested (dry-run)",
            summary: [`Would mark ${options.epic} as changes-requested.`],
            result: options,
            verbose: global.verbose,
          }),
        );
        return;
      }

      const updated = await service.updateEpic({
        id: options.epic,
        status: "changes-requested",
        addNotes: [options.rationale],
        actorId: global.actorId,
      });

      console.log(
        renderMutationMarkdown({
          title: "Decision Recorded: CHANGES_REQUESTED",
          summary: [`${updated.id} is now ${updated.status}.`],
          result: updated,
          verbose: global.verbose,
        }),
      );
    });

  return cmd;
}

function addGlobalOptions(cmd: Command): void {
  cmd.option("--dry-run", "Show what would happen without persisting changes");
  cmd.option("--actor-id <actorId>", "Current actor id for audit logs");
  cmd.option("--verbose", "Show verbose output");
}

function resolveGlobalOptions(command: Command): ResolvedGlobalOptions {
  const options = command.optsWithGlobals() as GlobalCliOptions;
  return {
    dryRun: Boolean(options.dryRun),
    actorId: options.actorId,
    verbose: Boolean(options.verbose),
  };
}

async function attachAcceptanceTestToBacklog(
  backlogService: BacklogService,
  testId: string,
  epicIds: string[],
  itemIds: string[],
  global: ResolvedGlobalOptions,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    return;
  }

  for (const epicId of epicIds) {
    const epic = await backlogService.readEpic({ id: epicId });
    const nextIds = unique([...(epic.acceptanceTestIds ?? []), testId]);
    await backlogService.updateEpic({
      id: epicId,
      acceptanceTestIds: nextIds,
      actorId: global.actorId,
    });
  }

  for (const itemId of itemIds) {
    const item = await backlogService.readItem({ id: itemId });
    const nextIds = unique([...(item.acceptanceTestIds ?? []), testId]);
    await backlogService.updateItem({
      id: itemId,
      acceptanceTestIds: nextIds,
      actorId: global.actorId,
    });
  }
}

function validateChangesRequestedRationale(rationale: string): void {
  const normalized = rationale.toLowerCase();
  const requiredPatterns: Array<{ label: string; checks: RegExp[] }> = [
    { label: "repro", checks: [/再現/u, /repro/u, /steps?/u] },
    { label: "expected", checks: [/期待値/u, /expected/u] },
    { label: "cause", checks: [/推定原因/u, /likely\s*cause/u, /cause/u] },
    { label: "fix", checks: [/修正指針/u, /fix/u, /mitigation/u] },
  ];

  const missing = requiredPatterns
    .filter((pattern) => !pattern.checks.some((check) => check.test(normalized)))
    .map((pattern) => pattern.label);

  if (missing.length > 0) {
    throw new Error(
      `--rationale must include these elements: repro, expected, cause, fix. missing: ${missing.join(", ")}`,
    );
  }
}

function renderOrchestratorContextMarkdown(
  requirements: string,
  epics: BacklogEpic[],
  items: BacklogItem[],
  questions: BacklogQuestion[],
  global: ResolvedGlobalOptions,
): string {
  const lines = [
    "# Current Context",
    "",
    "## Requirements",
    requirements.trim().length > 0 ? requirements : "(empty)",
    "",
    "## Epics",
    ...renderEpicList(epics),
    "",
    "## Items",
    ...renderItemList(items),
    "",
    "## Open Questions",
    ...renderQuestionList(questions),
  ];

  if (global.verbose) {
    lines.push("", "## Meta", "- actorId: " + (global.actorId ?? "(none)"));
  }

  return lines.join("\n");
}

function renderDeveloperContextMarkdown(
  requirements: string,
  epic: BacklogEpic,
  items: BacklogItem[],
  global: ResolvedGlobalOptions,
): string {
  const lines = [
    "# Current Context",
    "",
    "## Requirements",
    requirements.trim().length > 0 ? requirements : "(empty)",
    "",
    "## Epic",
    ...renderEpicList([epic]),
    "",
    "## Items",
    ...renderItemList(items),
  ];

  if (global.verbose) {
    lines.push("", "## Meta", "- actorId: " + (global.actorId ?? "(none)"));
  }

  return lines.join("\n");
}

function renderReviewerContextMarkdown(epic: BacklogEpic, items: BacklogItem[], global: ResolvedGlobalOptions): string {
  const lines = ["# Current Context", "", "## Epic", ...renderEpicList([epic]), "", "## Items", ...renderItemList(items)];

  if (global.verbose) {
    lines.push("", "## Meta", "- actorId: " + (global.actorId ?? "(none)"));
  }

  return lines.join("\n");
}

function renderQuestionsMarkdown(questions: BacklogQuestion[], title: string, global: ResolvedGlobalOptions): string {
  const lines = [`# ${title}`, "", ...renderQuestionList(questions)];
  if (global.verbose) {
    lines.push("", "## Count", `- ${questions.length}`);
  }
  return lines.join("\n");
}

function renderAcceptanceTestsMarkdown(
  tests: ReadonlyArray<AcceptanceTestCase>,
  title: string,
  global: ResolvedGlobalOptions,
): string {
  const lines = [`# ${title}`, ""];
  if (tests.length === 0) {
    lines.push("(none)");
  } else {
    for (const test of tests) {
      lines.push(`- ${test.id} | ${test.status} | ${test.lastExecutionStatus} | ${test.title}`);
    }
  }
  if (global.verbose) {
    lines.push("", "## Raw", renderJsonCodeBlock(tests));
  }
  return lines.join("\n");
}

function renderEpicList(epics: ReadonlyArray<BacklogEpic>): string[] {
  if (epics.length === 0) {
    return ["(none)"];
  }
  return epics.map((epic) => `- ${epic.id} | ${epic.status} | ${epic.title}`);
}

function renderItemList(items: ReadonlyArray<BacklogItem>): string[] {
  if (items.length === 0) {
    return ["(none)"];
  }
  return items.map((item) => `- ${item.id} (${item.epicId}) | ${item.status} | ${item.title}`);
}

function renderQuestionList(questions: ReadonlyArray<BacklogQuestion>): string[] {
  if (questions.length === 0) {
    return ["(none)"];
  }
  return questions.map((question) => `- ${question.id} | ${question.status} | ${question.title}`);
}

function renderMutationMarkdown(input: {
  title: string;
  summary: string[];
  result: unknown;
  verbose: boolean;
}): string {
  const lines = [`# ${input.title}`, "", ...input.summary.map((line) => `- ${line}`)];
  if (input.verbose) {
    lines.push("", "## Result", renderJsonCodeBlock(input.result));
  }
  return lines.join("\n");
}

function renderJsonCodeBlock(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function collectRepeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function buildOrchestratorManual(executableName: string): string {
  return [
    "# Orchestrator Tools Manual",
    "",
    "## Purpose",
    "- Maintain requirements, epics/items, and open questions as a single planning flow.",
    "",
    "## Subcommands",
    "- `current-context view`",
    "- `requirements update --file <path>|--text <text>`",
    "- `epic upsert ...`",
    "- `item upsert ...`",
    "- `question add ...`",
    "",
    "## Typical Examples",
    "```bash",
    `${executableName} current-context view`,
    `${executableName} requirements update --file docs/requirements.md`,
    `${executableName} epic upsert --title \"Checkout Revamp\" --kind product --status todo`,
    `${executableName} item upsert --epic E-012 --title \"Add E2E coverage\" --kind technical`,
    `${executableName} question add --title \"Clarify discount edge-case\" --details \"...\"`,
    "```",
  ].join("\n");
}

function buildDeveloperManual(executableName: string): string {
  return [
    "# Developer Tools Manual",
    "",
    "## Purpose",
    "- Shorten implementation routines: context read, status update, notes, and question handling.",
    "",
    "## Subcommands",
    "- `current-context view --epic <E-xxx>`",
    "- `item start --id <I-xxx> [--note <text>]`",
    "- `item note --id <I-xxx> --note <text>`",
    "- `item done --id <I-xxx> [--note <text>]`",
    "- `question inbox [--status open]`",
    "- `question answer --id <Q-xxx> --answer <text>`",
    "",
    "## Typical Examples",
    "```bash",
    `${executableName} current-context view --epic E-012`,
    `${executableName} item start --id I-104 --note \"Start Playwright-first flow\"`,
    `${executableName} item done --id I-104 --note \"All tests passed\"`,
    `${executableName} question inbox`,
    `${executableName} question answer --id Q-008 --answer \"Use server-side guard\"`,
    "```",
  ].join("\n");
}

function buildGatekeeperManual(executableName: string): string {
  return [
    "# Gatekeeper Tools Manual",
    "",
    "## Purpose",
    "- Manage acceptance test planning and persist execution evidence.",
    "",
    "## Subcommands",
    "- `test-case view [--epic <E-xxx>] [--item <I-xxx>]`",
    "- `test-case upsert ...`",
    "- `result save --id <AT-xxx> --status passed|failed --summary <text> --last-execution-note <text> ...`",
    "",
    "## Typical Examples",
    "```bash",
    `${executableName} test-case view --epic E-012`,
    `${executableName} test-case upsert --title \"Checkout works on mobile\" --status ready --epic E-012 --item I-104`,
    `${executableName} result save --id AT-033 --status passed --summary \"Desktop/mobile ok\" --last-execution-note \"2026-03-04 run\" --artifact tmp/logs/AT-033.png`,
    "```",
  ].join("\n");
}

function buildPolisherManual(executableName: string): string {
  return [
    "# Polisher Tools Manual",
    "",
    "## Purpose",
    "- Read polishing context and preserve rationale in backlog notes.",
    "",
    "## Subcommands",
    "- `current-context view --epic <E-xxx>`",
    "- `item add-note --id <I-xxx> --note <text>`",
    "",
    "## Typical Examples",
    "```bash",
    `${executableName} current-context view --epic E-012`,
    `${executableName} item add-note --id I-104 --note \"Simplified CTA hierarchy for readability\"`,
    "```",
  ].join("\n");
}

function buildReviewerManual(executableName: string): string {
  return [
    "# Reviewer Tools Manual",
    "",
    "## Purpose",
    "- Make PASS/CHANGES_REQUESTED decisions and sync epic status safely.",
    "",
    "## Subcommands",
    "- `current-context view --epic <E-xxx>`",
    "- `decision pass --epic <E-xxx> [--note <text>]`",
    "- `decision changes-requested --epic <E-xxx> --rationale <text>`",
    "",
    "## Typical Examples",
    "```bash",
    `${executableName} current-context view --epic E-012`,
    `${executableName} decision pass --epic E-012 --note \"All checks green\"`,
    `${executableName} decision changes-requested --epic E-012 --rationale \"Repro: ... Expected: ... Cause: ... Fix: ...\"`,
    "```",
  ].join("\n");
}
