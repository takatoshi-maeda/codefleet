import { Command } from "commander";

export function createFleetctlCommand(): Command {
  const cmd = new Command("fleetctl");
  cmd.description("Control buildfleet agent processes.");

  cmd
    .command("status")
    .description("Show agent runtime status")
    .action(() => {
      // Phase 1 skeleton only
    });

  return cmd;
}
