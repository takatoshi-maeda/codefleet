import { Command } from "commander";
import {
  createCodefleetCommandDispatcher,
  EventRouter,
  type RouteResult,
  type SystemEvent,
} from "../../events/router.js";

interface TriggerCommandOptions {
  router?: Pick<EventRouter, "route">;
}

export function createTriggerCommand(options: TriggerCommandOptions = {}): Command {
  const router = options.router ?? new EventRouter(createCodefleetCommandDispatcher());

  const cmd = new Command("trigger");
  cmd.description("Trigger a system event manually");
  cmd.configureHelp({
    // Commander appends `[options]` for any command with options. For event-style
    // subcommands this is noisy, so keep only command name and explicit args.
    subcommandTerm: (subcommand: Command) => `${subcommand.name()}${formatRegisteredArgs(subcommand)}`,
  });

  cmd
    .command("docs.update")
    .description("SystemEvent.type=docs.update")
    .summary("--paths <path> (repeatable/comma-separated)")
    .requiredOption("--paths <path>", "Updated document path (repeatable/comma-separated)", collectPaths, [])
    .action(async (options: { paths: string[] }) => {
      const paths = options.paths.filter((value) => value.length > 0);
      if (paths.length === 0) {
        throw new Error("docs.update: --paths must include at least one path");
      }
      await executeRoute(router, { type: "docs.update", paths });
    });

  return cmd;
}

async function executeRoute(router: Pick<EventRouter, "route">, event: SystemEvent): Promise<void> {
  const result = await router.route(event);
  printRouteResult(event, result);
}

function printRouteResult(event: SystemEvent, result: RouteResult): void {
  console.log(
    JSON.stringify(
      {
        event,
        deduped: result.deduped,
        executions: result.executions,
      },
      null,
      2,
    ),
  );
}

function collectPaths(value: string, previous: string[] = []): string[] {
  const nextValues = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...previous, ...nextValues];
}

function formatRegisteredArgs(command: Command): string {
  if (command.registeredArguments.length === 0) {
    return "";
  }

  const args = command.registeredArguments.map((arg) => {
    const base = arg.variadic ? `${arg.name()}...` : arg.name();
    return arg.required ? `<${base}>` : `[${base}]`;
  });
  return ` ${args.join(" ")}`;
}
