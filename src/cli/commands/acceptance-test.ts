import { Command } from "commander";

export function createAcceptanceTestCommand(): Command {
  const cmd = new Command("acceptance-test");
  cmd.description("Manage acceptance test specifications and results.");

  cmd
    .command("list")
    .description("List acceptance tests")
    .action(() => {
      // Phase 1 skeleton only
    });

  return cmd;
}
