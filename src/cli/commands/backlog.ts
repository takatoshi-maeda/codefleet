import { Command } from "commander";

export function createBacklogCommand(): Command {
  const cmd = new Command("backlog");
  cmd.description("Manage backlog epics and items.");

  cmd
    .command("list")
    .description("List backlog items")
    .action(() => {
      // Phase 1 skeleton only
    });

  return cmd;
}
