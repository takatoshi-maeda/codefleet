#!/usr/bin/env node
import { createBacklogCommand } from "./commands/backlog.js";

export function createBacklogCli() {
  return createBacklogCommand({
    commandName: "codefleet-backlog",
    executableName: "codefleet-backlog",
  }).version("0.1.0");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createBacklogCli().parseAsync(process.argv);
}
