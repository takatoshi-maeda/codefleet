import { Command } from "commander";
import type { BacklogEpicStatus, BacklogItemStatus, VisibilityType } from "../../domain/backlog-items-model.js";
import { BacklogService } from "../../domain/backlog/backlog-service.js";

export function createBacklogCommand(): Command {
  const service = new BacklogService();

  const cmd = new Command("backlog");
  cmd.description("Manage backlog epics and items.");

  cmd
    .command("list")
    .description("List epics and items")
    .option("--status <status>", "Filter by status")
    .option("--include-hidden", "Include hidden epics/items (PM only)")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const listed = await service.list({
        status: options.status as BacklogEpicStatus | BacklogItemStatus | undefined,
        includeHidden: Boolean(options.includeHidden),
        actorId: options.actorId,
      });
      console.log(JSON.stringify(listed, null, 2));
    });

  const epic = cmd.command("epic").description("Manage backlog epics");
  epic
    .command("add")
    .requiredOption("--title <title>", "Epic title")
    .option("--status <status>", "Epic status", "todo")
    .option("--visibility-type <type>", "always-visible or blocked-until-epic-complete", "always-visible")
    .option("--depends-on <epicId>", "Epic dependency id", collectRepeatable, [])
    .option("--acceptance-test <testId>", "Acceptance test id", collectRepeatable, [])
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const epicResult = await service.addEpic({
        title: options.title,
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
    .option("--include-hidden", "Include hidden epics (PM only)")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const listed = await service.list({
        status: options.status as BacklogEpicStatus | undefined,
        includeHidden: Boolean(options.includeHidden),
        actorId: options.actorId,
      });
      console.log(JSON.stringify(listed.epics, null, 2));
    });

  epic
    .command("update")
    .requiredOption("--id <id>", "Epic id")
    .option("--title <title>", "Epic title")
    .option("--status <status>", "Epic status")
    .option("--reopen", "Allow done -> in-progress")
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
        status: options.status as BacklogEpicStatus | undefined,
        reopen: Boolean(options.reopen),
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
    .option("--status <status>", "Item status", "todo")
    .option("--acceptance-test <testId>", "Acceptance test id", collectRepeatable, [])
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const added = await service.addItem({
        epicId: options.epic,
        title: options.title,
        status: options.status as BacklogItemStatus,
        acceptanceTestIds: options.acceptanceTest,
        actorId: options.actorId,
      });
      console.log(JSON.stringify(added, null, 2));
    });

  item
    .command("list")
    .description("List backlog items")
    .option("--status <status>", "Filter by status")
    .option("--include-hidden", "Include hidden items (PM only)")
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const listed = await service.list({
        status: options.status as BacklogItemStatus | undefined,
        includeHidden: Boolean(options.includeHidden),
        actorId: options.actorId,
      });
      console.log(JSON.stringify(listed.items, null, 2));
    });

  item
    .command("update")
    .requiredOption("--id <id>", "Item id")
    .option("--title <title>", "Item title")
    .option("--status <status>", "Item status")
    .option("--reopen", "Allow done -> in-progress")
    .option("--acceptance-test <testId>", "Acceptance test ids (replace)", collectRepeatable)
    .option("--actor-id <actorId>", "Current actor id")
    .action(async (options) => {
      const updated = await service.updateItem({
        id: options.id,
        title: options.title,
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

  return cmd;
}

function collectRepeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
