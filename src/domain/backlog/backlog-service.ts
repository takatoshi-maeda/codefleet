import { promises as fs } from "node:fs";
import path from "node:path";
import { JsonRepository } from "../../infra/fs/json-repository.js";
import { BuildfleetError } from "../../shared/errors.js";
import type { AcceptanceTestingSpec } from "../acceptance-testing-spec-model.js";
import type {
  BacklogEpic,
  BacklogEpicStatus,
  BacklogItem,
  BacklogItems,
  BacklogItemStatus,
  VisibilityRule,
} from "../backlog-items-model.js";
import type { Roles } from "../roles-model.js";
import { SCHEMA_PATHS } from "../schema-paths.js";
import { ensureAcceptanceTestIdsExist } from "../relations/acceptance-test-relations.js";
import { ensureStableBacklogSnapshot } from "./stable-snapshot-guard.js";
import { ensureValidEpicStatusTransition, ensureValidItemStatusTransition } from "./status-transition.js";

const DEFAULT_BACKLOG_DIR = ".buildfleet/data/backlog";
const DEFAULT_ACCEPTANCE_SPEC_PATH = ".buildfleet/data/acceptance-testing/spec.json";
const DEFAULT_ROLES_PATH = ".buildfleet/roles.json";

type AgentRole = "Orchestrator" | "Developer" | "Gatekeeper";

interface ListInput {
  status?: BacklogEpicStatus | BacklogItemStatus;
  includeHidden?: boolean;
  actorId?: string;
}

interface AddEpicInput {
  title: string;
  status?: BacklogEpicStatus;
  visibility?: VisibilityRule;
  acceptanceTestIds: string[];
  actorId?: string;
}

interface UpdateEpicInput {
  id: string;
  title?: string;
  status?: BacklogEpicStatus;
  visibility?: VisibilityRule;
  acceptanceTestIds?: string[];
  reopen?: boolean;
  actorId?: string;
}

interface AddItemInput {
  epicId: string;
  title: string;
  status?: BacklogItemStatus;
  acceptanceTestIds: string[];
  actorId?: string;
}

interface UpdateItemInput {
  id: string;
  title?: string;
  status?: BacklogItemStatus;
  acceptanceTestIds?: string[];
  reopen?: boolean;
  actorId?: string;
}

export class BacklogService {
  private readonly backlogDir: string;
  private readonly itemsRepository: JsonRepository<BacklogItems>;
  private readonly acceptanceSpecRepository: JsonRepository<AcceptanceTestingSpec>;
  private readonly rolesRepository: JsonRepository<Roles>;

  constructor(
    backlogDir: string = DEFAULT_BACKLOG_DIR,
    acceptanceSpecPath: string = DEFAULT_ACCEPTANCE_SPEC_PATH,
    rolesPath: string = DEFAULT_ROLES_PATH,
  ) {
    this.backlogDir = backlogDir;
    this.itemsRepository = new JsonRepository<BacklogItems>(
      path.join(backlogDir, "items.json"),
      SCHEMA_PATHS.backlogItems,
    );
    this.acceptanceSpecRepository = new JsonRepository<AcceptanceTestingSpec>(
      acceptanceSpecPath,
      SCHEMA_PATHS.acceptanceTestingSpec,
    );
    this.rolesRepository = new JsonRepository<Roles>(rolesPath, SCHEMA_PATHS.roles);
  }

  async list(input: ListInput = {}): Promise<BacklogItems> {
    if (input.status === "wait-implementation") {
      // wait-implementation is consumed as a "safe to start" queue.
      // Guarding with change-log mtime prevents developers from reading a half-written
      // snapshot where items.json moved forward but audit log has not caught up yet.
      await ensureStableBacklogSnapshot(this.backlogDir);
    }

    const role = await this.resolveRole(input.actorId);
    if (input.includeHidden && role !== "Orchestrator") {
      throw new BuildfleetError("ERR_VALIDATION", "--include-hidden is allowed for Orchestrator role only");
    }

    const items = await this.getOrInitializeItems();
    const epicsById = new Map(items.epics.map((epic) => [epic.id, epic]));
    const visibleEpicIds = new Set(
      items.epics.filter((epic) => input.includeHidden || isVisible(epic, epicsById)).map((epic) => epic.id),
    );

    const epics = items.epics.filter(
      (epic) => visibleEpicIds.has(epic.id) && (!input.status || epic.status === input.status),
    );
    const backlogItems = items.items.filter(
      (item) => visibleEpicIds.has(item.epicId) && (!input.status || item.status === input.status),
    );

    return { ...items, epics, items: backlogItems };
  }

  async addEpic(input: AddEpicInput): Promise<BacklogEpic> {
    const items = await this.getOrInitializeItems();
    const spec = await this.getAcceptanceSpecForValidation(input.acceptanceTestIds);
    ensureAcceptanceTestIdsExist(unique(input.acceptanceTestIds), spec);

    const now = new Date().toISOString();
    const epic: BacklogEpic = {
      id: nextEpicId(items.epics),
      title: input.title,
      status: input.status ?? "todo",
      visibility: input.visibility ?? defaultVisibility(),
      acceptanceTestIds: unique(input.acceptanceTestIds),
      updatedAt: now,
    };

    items.epics.push(epic);
    items.updatedAt = now;

    await this.persistWithChangeLog(items, await this.resolveRole(input.actorId), [`- epic added: ${epic.id}`]);
    return epic;
  }

  async updateEpic(input: UpdateEpicInput): Promise<BacklogEpic> {
    const items = await this.getOrInitializeItems();
    const epic = items.epics.find((value) => value.id === input.id);
    if (!epic) {
      throw new BuildfleetError("ERR_NOT_FOUND", `epic not found: ${input.id}`);
    }

    if (input.acceptanceTestIds) {
      const spec = await this.getAcceptanceSpecForValidation(input.acceptanceTestIds);
      ensureAcceptanceTestIdsExist(unique(input.acceptanceTestIds), spec);
      epic.acceptanceTestIds = unique(input.acceptanceTestIds);
    }

    if (input.status) {
      ensureValidEpicStatusTransition(epic.status, input.status, input.reopen ?? false);
      epic.status = input.status;
    }

    if (input.title !== undefined) {
      epic.title = input.title;
    }

    if (input.visibility) {
      epic.visibility = input.visibility;
    }

    const now = new Date().toISOString();
    epic.updatedAt = now;
    items.updatedAt = now;

    await this.persistWithChangeLog(items, await this.resolveRole(input.actorId), [`- epic updated: ${epic.id}`]);
    return epic;
  }

  async deleteEpic(id: string, force = false, actorId?: string): Promise<void> {
    const items = await this.getOrInitializeItems();
    const index = items.epics.findIndex((epic) => epic.id === id);
    if (index === -1) {
      throw new BuildfleetError("ERR_NOT_FOUND", `epic not found: ${id}`);
    }

    const linkedItems = items.items.filter((item) => item.epicId === id);
    if (!force && linkedItems.length > 0) {
      throw new BuildfleetError("ERR_CONFLICT", `epic has linked items: ${id}`);
    }

    items.epics.splice(index, 1);
    if (force) {
      items.items = items.items.filter((item) => item.epicId !== id);
    }
    items.updatedAt = new Date().toISOString();

    await this.persistWithChangeLog(items, await this.resolveRole(actorId), [`- epic deleted: ${id}`]);
  }

  async addItem(input: AddItemInput): Promise<BacklogItem> {
    const items = await this.getOrInitializeItems();
    const epic = items.epics.find((value) => value.id === input.epicId);
    if (!epic) {
      throw new BuildfleetError("ERR_NOT_FOUND", `epic not found: ${input.epicId}`);
    }

    const spec = await this.getAcceptanceSpecForValidation(input.acceptanceTestIds);
    ensureAcceptanceTestIdsExist(unique(input.acceptanceTestIds), spec);

    const now = new Date().toISOString();
    const item: BacklogItem = {
      id: nextItemId(items.items),
      epicId: input.epicId,
      title: input.title,
      status: input.status ?? "todo",
      acceptanceTestIds: unique(input.acceptanceTestIds),
      updatedAt: now,
    };

    items.items.push(item);
    items.updatedAt = now;

    await this.persistWithChangeLog(items, await this.resolveRole(input.actorId), [`- item added: ${item.id}`]);
    return item;
  }

  async updateItem(input: UpdateItemInput): Promise<BacklogItem> {
    const items = await this.getOrInitializeItems();
    const item = items.items.find((value) => value.id === input.id);
    if (!item) {
      throw new BuildfleetError("ERR_NOT_FOUND", `item not found: ${input.id}`);
    }

    if (input.acceptanceTestIds) {
      const spec = await this.getAcceptanceSpecForValidation(input.acceptanceTestIds);
      ensureAcceptanceTestIdsExist(unique(input.acceptanceTestIds), spec);
      item.acceptanceTestIds = unique(input.acceptanceTestIds);
    }

    if (input.status) {
      ensureValidItemStatusTransition(item.status, input.status, input.reopen ?? false);
      item.status = input.status;
    }

    if (input.title !== undefined) {
      item.title = input.title;
    }

    const now = new Date().toISOString();
    item.updatedAt = now;
    items.updatedAt = now;

    await this.persistWithChangeLog(items, await this.resolveRole(input.actorId), [`- item updated: ${item.id}`]);
    return item;
  }

  async deleteItem(id: string, actorId?: string): Promise<void> {
    const items = await this.getOrInitializeItems();
    const index = items.items.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new BuildfleetError("ERR_NOT_FOUND", `item not found: ${id}`);
    }

    items.items.splice(index, 1);
    items.updatedAt = new Date().toISOString();

    await this.persistWithChangeLog(items, await this.resolveRole(actorId), [`- item deleted: ${id}`]);
  }

  private async getOrInitializeItems(): Promise<BacklogItems> {
    try {
      return await this.itemsRepository.get();
    } catch (error) {
      if (error instanceof BuildfleetError && error.code === "ERR_NOT_FOUND") {
        const now = new Date().toISOString();
        const initial: BacklogItems = { version: 1, updatedAt: now, epics: [], items: [] };
        await this.itemsRepository.save(initial);
        return initial;
      }
      throw error;
    }
  }

  private async getAcceptanceSpecForValidation(acceptanceTestIds: string[]): Promise<AcceptanceTestingSpec> {
    if (acceptanceTestIds.length === 0) {
      return { version: 1, updatedAt: new Date().toISOString(), tests: [] };
    }
    try {
      return await this.acceptanceSpecRepository.get();
    } catch (error) {
      if (error instanceof BuildfleetError && error.code === "ERR_NOT_FOUND") {
        throw new BuildfleetError("ERR_VALIDATION", "acceptance test spec not found");
      }
      throw error;
    }
  }

  private async resolveRole(actorId?: string): Promise<AgentRole> {
    if (!actorId) {
      return "Developer";
    }

    try {
      const roles = await this.rolesRepository.get();
      return roles.agents.find((agent) => agent.id === actorId)?.role ?? "Developer";
    } catch (error) {
      if (error instanceof BuildfleetError && error.code === "ERR_NOT_FOUND") {
        return "Developer";
      }
      throw error;
    }
  }

  private async persistWithChangeLog(items: BacklogItems, actor: AgentRole, lines: string[]): Promise<void> {
    // Keep persistence order explicit: items.json first, then change-log.
    // If the process crashes between these writes, snapshot guard detects the gap and
    // blocks wait-implementation reads until a complete change-log is present.
    await this.itemsRepository.save(items);
    await this.writeChangeLog(actor, lines, items.version);
  }

  private async writeChangeLog(actor: AgentRole, lines: string[], itemsVersion: number): Promise<void> {
    const changeLogDir = path.join(this.backlogDir, "change-logs");
    await fs.mkdir(changeLogDir, { recursive: true });

    const now = new Date();
    const changeId = await this.nextChangeLogId(now, changeLogDir);
    const createdAt = now.toISOString();
    const content = `---\nid: ${changeId}\nactor: ${actor}\ntype: backlog-update\ncreatedAt: ${createdAt}\nitemsJsonVersion: ${itemsVersion}\n---\n\n${lines.join("\n")}\n`;

    await fs.writeFile(path.join(changeLogDir, `${changeId}.md`), content, "utf8");
  }

  private async nextChangeLogId(now: Date, changeLogDir: string): Promise<string> {
    const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(
      now.getUTCDate(),
    ).padStart(2, "0")}`;
    const prefix = `CHG-${stamp}-`;

    const files = await fs.readdir(changeLogDir).catch(() => []);
    const maxSequence = files.reduce((max, file) => {
      if (!file.endsWith(".md")) {
        return max;
      }
      const name = path.basename(file, ".md");
      if (!name.startsWith(prefix)) {
        return max;
      }
      const sequence = Number(name.slice(prefix.length));
      return Number.isNaN(sequence) ? max : Math.max(max, sequence);
    }, 0);

    return `${prefix}${String(maxSequence + 1).padStart(3, "0")}`;
  }
}

function defaultVisibility(): VisibilityRule {
  return {
    type: "always-visible",
    dependsOnEpicIds: [],
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function nextEpicId(epics: BacklogEpic[]): string {
  const maxSequence = epics.reduce((max, epic) => {
    const matched = /^E-(\d+)$/.exec(epic.id);
    if (!matched) {
      return max;
    }
    return Math.max(max, Number(matched[1]));
  }, 0);

  return `E-${String(maxSequence + 1).padStart(3, "0")}`;
}

function nextItemId(items: BacklogItem[]): string {
  const maxSequence = items.reduce((max, item) => {
    const matched = /^I-(\d+)$/.exec(item.id);
    if (!matched) {
      return max;
    }
    return Math.max(max, Number(matched[1]));
  }, 0);

  return `I-${String(maxSequence + 1).padStart(3, "0")}`;
}

function isVisible(epic: BacklogEpic, epicsById: Map<string, BacklogEpic>): boolean {
  // Visibility is intentionally derived from dependency completion only.
  // The caller may still include hidden epics explicitly, but default list output
  // must hide blocked planning branches until dependencies are fully done.
  if (epic.visibility.type !== "blocked-until-epic-complete") {
    return true;
  }
  return epic.visibility.dependsOnEpicIds.every((id) => epicsById.get(id)?.status === "done");
}
