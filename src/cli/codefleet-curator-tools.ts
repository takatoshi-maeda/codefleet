#!/usr/bin/env node
import { createCuratorToolsCommand } from "./commands/role-tools.js";

export function createCuratorToolsCli() {
  return createCuratorToolsCommand({
    commandName: "codefleet-curator-tools",
    executableName: "codefleet-curator-tools",
  }).version("0.1.0");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createCuratorToolsCli().parseAsync(process.argv);
}
