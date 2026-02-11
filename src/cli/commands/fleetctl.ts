import { Command } from "commander";
import type { AgentRole } from "../../domain/roles-model.js";
import { FleetService } from "../../domain/agents/fleet-service.js";

export function createFleetctlCommand(): Command {
  const service = new FleetService();

  const cmd = new Command("fleetctl");
  cmd.description("Control codefleet agent processes.");

  cmd
    .command("status")
    .description("Show agent runtime status")
    .option("--role <role>", "Filter by role")
    .action(async (options) => {
      const status = await service.status(options.role as AgentRole | undefined);
      console.log(JSON.stringify(status, null, 2));
    });

  cmd
    .command("up")
    .description("Start agents")
    .option("-d, --detached", "Run in background")
    .option("--role <role>", "Start only agents with the role")
    .action(async (options) => {
      const status = await service.up({ role: options.role as AgentRole | undefined, detached: Boolean(options.detached) });
      console.log(JSON.stringify(status, null, 2));
    });

  cmd
    .command("down")
    .description("Stop agents")
    .option("--all", "Stop all agents")
    .option("--role <role>", "Stop agents with the role")
    .action(async (options) => {
      validateTargetSelection(Boolean(options.all), options.role as AgentRole | undefined, "down");
      const status = await service.down({ all: Boolean(options.all), role: options.role as AgentRole | undefined });
      console.log(JSON.stringify(status, null, 2));
    });

  cmd
    .command("restart")
    .description("Restart agents")
    .option("--all", "Restart all agents")
    .option("--role <role>", "Restart agents with the role")
    .option("-d, --detached", "Run in background")
    .action(async (options) => {
      validateTargetSelection(Boolean(options.all), options.role as AgentRole | undefined, "restart");
      const status = await service.restart({
        all: Boolean(options.all),
        role: options.role as AgentRole | undefined,
        detached: Boolean(options.detached),
      });
      console.log(JSON.stringify(status, null, 2));
    });

  cmd
    .command("logs")
    .description("Show aggregated logs")
    .option("--all", "Show logs for all agents")
    .option("--role <role>", "Show logs for the role")
    .option("--tail <count>", "Number of lines per agent", "200")
    .action(async (options) => {
      validateTargetSelection(Boolean(options.all), options.role as AgentRole | undefined, "logs");
      const logs = await service.logs({
        all: Boolean(options.all),
        role: options.role as AgentRole | undefined,
        tail: Number(options.tail),
      });
      console.log(logs);
    });

  return cmd;
}

function validateTargetSelection(all: boolean, role: AgentRole | undefined, commandName: string): void {
  if (all && role) {
    throw new Error(`${commandName}: --all and --role cannot be used together`);
  }

  if (!all && !role) {
    throw new Error(`${commandName}: either --all or --role is required`);
  }
}
