#!/usr/bin/env node
import { Command } from "commander";
import { createAcceptanceTestCommand } from "./commands/acceptance-test.js";
import { createBacklogCommand } from "./commands/backlog.js";
import { createFleetctlCommand } from "./commands/fleetctl.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("buildfleet")
    .description("CLI for multi-agent workflow orchestration")
    .version("0.1.0");

  program.addCommand(createAcceptanceTestCommand());
  program.addCommand(createBacklogCommand());
  program.addCommand(createFleetctlCommand());

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createCli().parseAsync(process.argv);
}
