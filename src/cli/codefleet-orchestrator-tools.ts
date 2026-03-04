#!/usr/bin/env node
import { createOrchestratorToolsCommand } from "./commands/role-tools.js";

export function createOrchestratorToolsCli() {
  return createOrchestratorToolsCommand({
    commandName: "codefleet-orchestrator-tools",
    executableName: "codefleet-orchestrator-tools",
  }).version("0.1.0");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createOrchestratorToolsCli().parseAsync(process.argv);
}
