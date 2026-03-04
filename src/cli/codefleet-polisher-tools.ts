#!/usr/bin/env node
import { createPolisherToolsCommand } from "./commands/role-tools.js";

export function createPolisherToolsCli() {
  return createPolisherToolsCommand({
    commandName: "codefleet-polisher-tools",
    executableName: "codefleet-polisher-tools",
  }).version("0.1.0");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createPolisherToolsCli().parseAsync(process.argv);
}
