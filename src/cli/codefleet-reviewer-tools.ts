#!/usr/bin/env node
import { createReviewerToolsCommand } from "./commands/role-tools.js";

export function createReviewerToolsCli() {
  return createReviewerToolsCommand({
    commandName: "codefleet-reviewer-tools",
    executableName: "codefleet-reviewer-tools",
  }).version("0.1.0");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createReviewerToolsCli().parseAsync(process.argv);
}
