#!/usr/bin/env node
import { createGatekeeperToolsCommand } from "./commands/role-tools.js";

export function createGatekeeperToolsCli() {
  return createGatekeeperToolsCommand({
    commandName: "codefleet-gatekeeper-tools",
    executableName: "codefleet-gatekeeper-tools",
  }).version("0.1.0");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createGatekeeperToolsCli().parseAsync(process.argv);
}
