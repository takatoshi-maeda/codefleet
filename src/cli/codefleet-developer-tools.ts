#!/usr/bin/env node
import { createDeveloperToolsCommand } from "./commands/role-tools.js";

export function createDeveloperToolsCli() {
  return createDeveloperToolsCommand({
    commandName: "codefleet-developer-tools",
    executableName: "codefleet-developer-tools",
  }).version("0.1.0");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createDeveloperToolsCli().parseAsync(process.argv);
}
