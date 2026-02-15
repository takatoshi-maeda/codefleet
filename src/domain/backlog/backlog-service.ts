import { promises as fs } from "node:fs";
import path from "node:path";
import { JsonRepository } from "../../infra/fs/json-repository.js";
import { CodefleetError } from "../../shared/errors.js";
import type { AcceptanceTestingSpec } from "../acceptance-testing-spec-model.js";
import type {
  BacklogEpic,
  BacklogEpicStatus,
  BacklogItem,
  BacklogItems,
  BacklogItemStatus,
  BacklogQuestion,
  BacklogQuestionStatus,
  BacklogWorkKind,
  VisibilityRule,
} from "../backlog-items-model.js";
import type { Roles } from "../roles-model.js";
import { SCHEMA_PATHS } from "../schema-paths.js";
import { ensureAcceptanceTestIdsExist } from "../relations/acceptance-test-relations.js";
import { ensureStableBacklogSnapshot } from "./stable-snapshot-guard.js";
import { ensureValidEpicStatusTransition, ensureValidItemStatusTransition } from "./status-transition.js";

const DEFAULT_BACKLOG_DIR = ".codefleet/data/backlog";
const DEFAULT_ACCEPTANCE_SPEC_PATH = ".codefleet/data/acceptance-testing/spec.json";
const DEFAULT_ROLES_PATH = ".codefleet/roles.json";
const CHANGE_LOG_JSONL_PATH = "change-logs.jsonl";
const READY_EPIC_STATUSES: BacklogEpicStatus[] = ["todo", "changes-requested", "failed"];

type AgentRole = "Orchestrator" | "Developer" | "Gatekeeper" | "Reviewer";
type JsonLogValue = string | number | boolean | null | JsonLogValue[] | { [key: string]: JsonLogValue };

interface ListInput {
  status?: BacklogEpicStatus | BacklogItemStatus;
  kind?: BacklogWorkKind;
  epicId?: string;
  includeHidden?: boolean;
  actorId?: string;
}

interface AddEpicInput {
  title: string;
  kind?: BacklogWorkKind;
  notes?: string[];
  status?: BacklogEpicStatus;
  visibility?: VisibilityRule;
  acceptanceTestIds: string[];
  actorId?: string;
}

interface UpdateEpicInput {
  id: string;
  title?: string;
  kind?: BacklogWorkKind;
  addNotes?: string[];
  removeNotes?: string[];
  status?: BacklogEpicStatus;
  visibility?: VisibilityRule;
  acceptanceTestIds?: string[];
  reopen?: boolean;
  force?: boolean;
  actorId?: string;
}

interface AddItemInput {
  epicId: string;
  title: string;
  kind?: BacklogWorkKind;
  notes?: string[];
  status?: BacklogItemStatus;
  acceptanceTestIds: string[];
  actorId?: string;
}

interface UpdateItemInput {
  id: string;
  title?: string;
  kind?: BacklogWorkKind;
  addNotes?: string[];
  removeNotes?: string[];
  status?: BacklogItemStatus;
  acceptanceTestIds?: string[];
  reopen?: boolean;
  actorId?: string;
}

interface AddQuestionInput {
  title: string;
  details?: string;
  actorId?: string;
}

interface UpdateQuestionInput {
  id: string;
  title?: string;
  details?: string;
  status?: BacklogQuestionStatus;
  actorId?: string;
}

interface AnswerQuestionInput {
  id: string;
  answer: string;
  actorId?: string;
}

interface ReadByIdInput {
  id: string;
}

interface UpdateStatusAllTodoResult {
  updatedEpicIds: string[];
  updatedItemIds: string[];
}

interface ResetInProgressToTodoResult {
  updatedEpicIds: string[];
  updatedItemIds: string[];
}

type NormalizedBacklogItems = Omit<BacklogItems, "questions"> & { questions: BacklogQuestion[] };

export class BacklogService {
  private readonly backlogDir: string;
  private readonly requirementsPath: string;
  private readonly itemsRepository: JsonRepository<BacklogItems>;
  private readonly acceptanceSpecRepository: JsonRepository<AcceptanceTestingSpec>;
  private readonly rolesRepository: JsonRepository<Roles>;

  constructor(
    backlogDir: string = DEFAULT_BACKLOG_DIR,
    acceptanceSpecPath: string = DEFAULT_ACCEPTANCE_SPEC_PATH,
    rolesPath: string = DEFAULT_ROLES_PATH,
  ) {
    this.backlogDir = backlogDir;
    this.requirementsPath = path.join(backlogDir, "requirements.txt");
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

  async readRequirements(): Promise<string> {
    try {
      return await fs.readFile(this.requirementsPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  async writeRequirements(text: string): Promise<string> {
    await fs.mkdir(this.backlogDir, { recursive: true });
    await fs.writeFile(this.requirementsPath, text, "utf8");
    return text;
  }

  async list(input: ListInput = {}): Promise<BacklogItems> {
    if (input.status === "wait-implementation") {
      // wait-implementation is consumed as a "safe to start" queue.
      // Guarding with change-log mtime prevents developers from reading a half-written
      // snapshot where items.json moved forward but audit log has not caught up yet.
      await ensureStableBacklogSnapshot(this.backlogDir);
    }

    if (input.includeHidden && input.actorId) {
      const role = await this.resolveRole(input.actorId);
      if (role !== "Orchestrator") {
        throw new CodefleetError("ERR_VALIDATION", "--include-hidden is allowed for Orchestrator role only");
      }
    }

    const items = await this.getOrInitializeItems();
    const epicsById = new Map(items.epics.map((epic) => [epic.id, epic]));
    const visibleEpicIds = new Set(
      items.epics.filter((epic) => input.includeHidden || isVisible(epic, epicsById)).map((epic) => epic.id),
    );

    const epics = items.epics.filter(
      (epic) =>
        visibleEpicIds.has(epic.id) &&
        (!input.status || epic.status === input.status) &&
        (!input.kind || epic.kind === input.kind),
    );
    const backlogItems = items.items.filter(
      (item) =>
        visibleEpicIds.has(item.epicId) &&
        (!input.epicId || item.epicId === input.epicId) &&
        (!input.status || item.status === input.status) &&
        (!input.kind || item.kind === input.kind),
    );

    return { ...items, epics, items: backlogItems, questions: [...items.questions] };
  }

  async listReadyEpics(status?: BacklogEpicStatus): Promise<BacklogEpic[]> {
    const items = await this.getOrInitializeItems();
    const epicsById = new Map(items.epics.map((epic) => [epic.id, epic]));
    const targetStatuses = status ? [status] : READY_EPIC_STATUSES;
    return items.epics.filter((epic) => isVisible(epic, epicsById) && targetStatuses.includes(epic.status));
  }

  async readEpic(input: ReadByIdInput): Promise<BacklogEpic> {
    const items = await this.getOrInitializeItems();
    const epic = items.epics.find((value) => value.id === input.id);
    if (!epic) {
      throw new CodefleetError("ERR_NOT_FOUND", `epic not found: ${input.id}`);
    }
    return { ...epic };
  }

  async claimReadyEpicForImplementation(actorId?: string): Promise<BacklogEpic | null> {
    const items = await this.getOrInitializeItems();
    const epicsById = new Map(items.epics.map((epic) => [epic.id, epic]));

    // Implementation must remain serialized around the review gate: do not pick
    // a new ready epic while any epic is actively implemented or under review.
    const hasActiveOrReviewingEpic = items.epics.some(
      (epic) => epic.status === "in-progress" || epic.status === "in-review",
    );
    if (hasActiveOrReviewingEpic) {
      return null;
    }

    const candidate = items.epics.find((epic) => READY_EPIC_STATUSES.includes(epic.status) && isVisible(epic, epicsById));
    if (!candidate) {
      return null;
    }

    // Claim converts the selected epic from a "ready queue candidate" into active work.
    // This prevents repeated backlog.epic.ready dispatches from selecting the same epic again.
    ensureValidEpicStatusTransition(candidate.status, "in-progress");
    const now = new Date().toISOString();
    candidate.status = "in-progress";
    candidate.updatedAt = now;
    items.updatedAt = now;

    await this.persistWithChangeLog(
      items,
      "epic.claim-ready-for-implementation",
      { actorId },
      `epic claimed for implementation: ${candidate.id}`,
    );
    return candidate;
  }

  async updateStatusAllTodo(actorId?: string): Promise<UpdateStatusAllTodoResult> {
    const items = await this.getOrInitializeItems();
    const updatedEpicIds = items.epics.filter((epic) => epic.status !== "todo").map((epic) => epic.id);
    const updatedItemIds = items.items.filter((item) => item.status !== "todo").map((item) => item.id);

    if (updatedEpicIds.length === 0 && updatedItemIds.length === 0) {
      return { updatedEpicIds, updatedItemIds };
    }

    const now = new Date().toISOString();
    const updatedEpicIdSet = new Set(updatedEpicIds);
    const updatedItemIdSet = new Set(updatedItemIds);
    // This administrative reset intentionally bypasses normal transition guards so operators can
    // rebuild execution queues from a clean "todo" state in one atomic update.
    for (const epic of items.epics) {
      if (!updatedEpicIdSet.has(epic.id)) {
        continue;
      }
      epic.status = "todo";
      epic.updatedAt = now;
    }
    for (const item of items.items) {
      if (!updatedItemIdSet.has(item.id)) {
        continue;
      }
      item.status = "todo";
      item.updatedAt = now;
    }
    items.updatedAt = now;

    const epicSummary = updatedEpicIds.length > 0 ? ` (${updatedEpicIds.join(", ")})` : "";
    const itemSummary = updatedItemIds.length > 0 ? ` (${updatedItemIds.join(", ")})` : "";
    await this.persistWithChangeLog(
      items,
      "backlog.update-status-all-todo",
      { actorId },
      `epic/item statuses reset to todo; epics updated: ${updatedEpicIds.length}${epicSummary}; items updated: ${updatedItemIds.length}${itemSummary}`,
    );
    return { updatedEpicIds, updatedItemIds };
  }

  async resetInProgressToTodo(actorId?: string): Promise<ResetInProgressToTodoResult> {
    const items = await this.getOrInitializeItems();
    const updatedEpicIds = items.epics.filter((epic) => epic.status === "in-progress").map((epic) => epic.id);
    const updatedItemIds = items.items.filter((item) => item.status === "in-progress").map((item) => item.id);

    if (updatedEpicIds.length === 0 && updatedItemIds.length === 0) {
      return { updatedEpicIds, updatedItemIds };
    }

    const now = new Date().toISOString();
    const updatedEpicIdSet = new Set(updatedEpicIds);
    const updatedItemIdSet = new Set(updatedItemIds);
    // Fleet startup reset is an operational safeguard. It intentionally bypasses
    // regular transition rules and only rewinds currently-running work to todo.
    for (const epic of items.epics) {
      if (!updatedEpicIdSet.has(epic.id)) {
        continue;
      }
      epic.status = "todo";
      epic.updatedAt = now;
    }
    for (const item of items.items) {
      if (!updatedItemIdSet.has(item.id)) {
        continue;
      }
      item.status = "todo";
      item.updatedAt = now;
    }
    items.updatedAt = now;

    const epicSummary = updatedEpicIds.length > 0 ? ` (${updatedEpicIds.join(", ")})` : "";
    const itemSummary = updatedItemIds.length > 0 ? ` (${updatedItemIds.join(", ")})` : "";
    await this.persistWithChangeLog(
      items,
      "backlog.reset-in-progress-to-todo",
      { actorId },
      `in-progress epic/item statuses reset to todo; epics updated: ${updatedEpicIds.length}${epicSummary}; items updated: ${updatedItemIds.length}${itemSummary}`,
    );
    return { updatedEpicIds, updatedItemIds };
  }

  async addEpic(input: AddEpicInput): Promise<BacklogEpic> {
    const items = await this.getOrInitializeItems();
    const spec = await this.getAcceptanceSpecForValidation(input.acceptanceTestIds);
    ensureAcceptanceTestIdsExist(unique(input.acceptanceTestIds), spec);

    const now = new Date().toISOString();
    const epic: BacklogEpic = {
      id: nextEpicId(items.epics),
      title: input.title,
      kind: input.kind ?? "product",
      notes: unique(input.notes ?? []),
      status: input.status ?? "todo",
      visibility: input.visibility ?? defaultVisibility(),
      acceptanceTestIds: unique(input.acceptanceTestIds),
      updatedAt: now,
    };

    items.epics.push(epic);
    items.updatedAt = now;

    await this.persistWithChangeLog(items, "epic.add", input, `epic added: ${epic.id}`);
    return epic;
  }

  async updateEpic(input: UpdateEpicInput): Promise<BacklogEpic> {
    const items = await this.getOrInitializeItems();
    const epic = items.epics.find((value) => value.id === input.id);
    if (!epic) {
      throw new CodefleetError("ERR_NOT_FOUND", `epic not found: ${input.id}`);
    }

    if (input.acceptanceTestIds) {
      const spec = await this.getAcceptanceSpecForValidation(input.acceptanceTestIds);
      ensureAcceptanceTestIdsExist(unique(input.acceptanceTestIds), spec);
      epic.acceptanceTestIds = unique(input.acceptanceTestIds);
    }

    if (input.status) {
      if (!input.force) {
        ensureValidEpicStatusTransition(epic.status, input.status, input.reopen ?? false);
      }
      epic.status = input.status;
    }

    if (input.title !== undefined) {
      epic.title = input.title;
    }
    if (input.kind !== undefined) {
      epic.kind = input.kind;
    }

    if (input.addNotes || input.removeNotes) {
      const removeSet = new Set(input.removeNotes ?? []);
      epic.notes = unique([...(epic.notes ?? []), ...(input.addNotes ?? [])].filter((note) => !removeSet.has(note)));
    }

    if (input.visibility) {
      epic.visibility = input.visibility;
    }

    const now = new Date().toISOString();
    epic.updatedAt = now;
    items.updatedAt = now;

    await this.persistWithChangeLog(items, "epic.update", input, `epic updated: ${epic.id}`);
    return epic;
  }

  async deleteEpic(id: string, force = false, actorId?: string): Promise<void> {
    const items = await this.getOrInitializeItems();
    const index = items.epics.findIndex((epic) => epic.id === id);
    if (index === -1) {
      throw new CodefleetError("ERR_NOT_FOUND", `epic not found: ${id}`);
    }

    const linkedItems = items.items.filter((item) => item.epicId === id);
    if (!force && linkedItems.length > 0) {
      throw new CodefleetError("ERR_CONFLICT", `epic has linked items: ${id}`);
    }

    items.epics.splice(index, 1);
    if (force) {
      items.items = items.items.filter((item) => item.epicId !== id);
    }
    items.updatedAt = new Date().toISOString();

    await this.persistWithChangeLog(items, "epic.delete", { id, force, actorId }, `epic deleted: ${id}`);
  }

  async addItem(input: AddItemInput): Promise<BacklogItem> {
    const items = await this.getOrInitializeItems();
    const epic = items.epics.find((value) => value.id === input.epicId);
    if (!epic) {
      throw new CodefleetError("ERR_NOT_FOUND", `epic not found: ${input.epicId}`);
    }

    const spec = await this.getAcceptanceSpecForValidation(input.acceptanceTestIds);
    ensureAcceptanceTestIdsExist(unique(input.acceptanceTestIds), spec);

    const now = new Date().toISOString();
    const item: BacklogItem = {
      id: nextItemId(items.items),
      epicId: input.epicId,
      title: input.title,
      kind: input.kind ?? "product",
      notes: unique(input.notes ?? []),
      status: input.status ?? "todo",
      acceptanceTestIds: unique(input.acceptanceTestIds),
      updatedAt: now,
    };

    items.items.push(item);
    items.updatedAt = now;

    await this.persistWithChangeLog(items, "item.add", input, `item added: ${item.id}`);
    return item;
  }

  async updateItem(input: UpdateItemInput): Promise<BacklogItem> {
    const items = await this.getOrInitializeItems();
    const item = items.items.find((value) => value.id === input.id);
    if (!item) {
      throw new CodefleetError("ERR_NOT_FOUND", `item not found: ${input.id}`);
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
    if (input.kind !== undefined) {
      item.kind = input.kind;
    }

    if (input.addNotes || input.removeNotes) {
      const removeSet = new Set(input.removeNotes ?? []);
      item.notes = unique([...(item.notes ?? []), ...(input.addNotes ?? [])].filter((note) => !removeSet.has(note)));
    }

    const now = new Date().toISOString();
    item.updatedAt = now;
    items.updatedAt = now;

    await this.persistWithChangeLog(items, "item.update", input, `item updated: ${item.id}`);
    return item;
  }

  async deleteItem(id: string, actorId?: string): Promise<void> {
    const items = await this.getOrInitializeItems();
    const index = items.items.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new CodefleetError("ERR_NOT_FOUND", `item not found: ${id}`);
    }

    items.items.splice(index, 1);
    items.updatedAt = new Date().toISOString();

    await this.persistWithChangeLog(items, "item.delete", { id, actorId }, `item deleted: ${id}`);
  }

  async readItem(input: ReadByIdInput): Promise<BacklogItem> {
    const items = await this.getOrInitializeItems();
    const item = items.items.find((value) => value.id === input.id);
    if (!item) {
      throw new CodefleetError("ERR_NOT_FOUND", `item not found: ${input.id}`);
    }
    return { ...item };
  }

  async listQuestions(): Promise<BacklogQuestion[]> {
    const items = await this.getOrInitializeItems();
    return [...items.questions];
  }

  async addQuestion(input: AddQuestionInput): Promise<BacklogQuestion> {
    const items = await this.getOrInitializeItems();
    const now = new Date().toISOString();
    const question: BacklogQuestion = {
      id: nextQuestionId(items.questions),
      title: input.title,
      details: input.details,
      status: "open",
      updatedAt: now,
    };
    items.questions.push(question);
    items.updatedAt = now;
    await this.persistWithChangeLog(items, "question.add", input, `question added: ${question.id}`);
    return question;
  }

  async updateQuestion(input: UpdateQuestionInput): Promise<BacklogQuestion> {
    const items = await this.getOrInitializeItems();
    const question = items.questions.find((value) => value.id === input.id);
    if (!question) {
      throw new CodefleetError("ERR_NOT_FOUND", `question not found: ${input.id}`);
    }

    if (input.title !== undefined) {
      question.title = input.title;
    }
    if (input.details !== undefined) {
      question.details = input.details;
    }
    if (input.status !== undefined) {
      question.status = input.status;
      if (input.status === "open") {
        question.answer = undefined;
      }
    }

    const now = new Date().toISOString();
    question.updatedAt = now;
    items.updatedAt = now;
    await this.persistWithChangeLog(items, "question.update", input, `question updated: ${question.id}`);
    return question;
  }

  async answerQuestion(input: AnswerQuestionInput): Promise<BacklogQuestion> {
    const items = await this.getOrInitializeItems();
    const question = items.questions.find((value) => value.id === input.id);
    if (!question) {
      throw new CodefleetError("ERR_NOT_FOUND", `question not found: ${input.id}`);
    }

    question.status = "answered";
    question.answer = input.answer;
    const now = new Date().toISOString();
    question.updatedAt = now;
    items.updatedAt = now;
    await this.persistWithChangeLog(items, "question.answer", input, `question answered: ${question.id}`);
    return question;
  }

  async deleteQuestion(id: string, actorId?: string): Promise<void> {
    const items = await this.getOrInitializeItems();
    const index = items.questions.findIndex((question) => question.id === id);
    if (index === -1) {
      throw new CodefleetError("ERR_NOT_FOUND", `question not found: ${id}`);
    }

    items.questions.splice(index, 1);
    items.updatedAt = new Date().toISOString();
    await this.persistWithChangeLog(items, "question.delete", { id, actorId }, `question deleted: ${id}`);
  }

  private async getOrInitializeItems(): Promise<NormalizedBacklogItems> {
    try {
      const persisted = await this.itemsRepository.get();
      return normalizeBacklogItems(persisted);
    } catch (error) {
      if (error instanceof CodefleetError && error.code === "ERR_NOT_FOUND") {
        const now = new Date().toISOString();
        const initial: NormalizedBacklogItems = { version: 1, updatedAt: now, epics: [], items: [], questions: [] };
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
      if (error instanceof CodefleetError && error.code === "ERR_NOT_FOUND") {
        throw new CodefleetError("ERR_VALIDATION", "acceptance test spec not found");
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
      if (error instanceof CodefleetError && error.code === "ERR_NOT_FOUND") {
        return "Developer";
      }
      throw error;
    }
  }

  private async persistWithChangeLog(
    items: BacklogItems,
    operation: string,
    parameters: object,
    fallbackReason: string,
  ): Promise<void> {
    // Keep persistence order explicit: items.json first, then change-log append.
    // If the process crashes between these writes, snapshot guard detects the gap and
    // blocks wait-implementation reads until a complete change-log is present.
    await this.itemsRepository.save(items);
    await this.writeChangeLog(operation, parameters, fallbackReason, items.version);
  }

  private async writeChangeLog(
    operation: string,
    parameters: object,
    fallbackReason: string,
    itemsVersion: number,
  ): Promise<void> {
    await fs.mkdir(this.backlogDir, { recursive: true });
    const changeLogPath = path.join(this.backlogDir, CHANGE_LOG_JSONL_PATH);

    const now = new Date();
    const createdAt = now.toISOString();
    const changeId = await this.nextChangeLogId(now, changeLogPath);
    const entry = {
      id: changeId,
      type: "backlog-update" as const,
      operation,
      parameters: sanitizeForJsonLog(parameters),
      createdAt,
      itemsJsonVersion: itemsVersion,
      reason: this.buildChangeReason(operation, parameters, fallbackReason),
    };

    await fs.appendFile(changeLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private async nextChangeLogId(now: Date, changeLogPath: string): Promise<string> {
    const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(
      now.getUTCDate(),
    ).padStart(2, "0")}`;
    const prefix = `CHG-${stamp}-`;

    let raw = "";
    try {
      raw = await fs.readFile(changeLogPath, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    // IDs are monotonic per UTC day. We compute the current max from existing JSONL
    // so append-only history remains queryable in strict write order.
    const maxSequence = raw.split("\n").reduce((max, line) => {
      if (line.trim().length === 0) {
        return max;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Keep writes resilient if historical rows were hand-edited or partially broken.
        return max;
      }
      if (!parsed || typeof parsed !== "object") {
        return max;
      }
      const name = (parsed as { id?: unknown }).id;
      if (typeof name !== "string") {
        return max;
      }
      if (!name.startsWith(prefix)) {
        return max;
      }
      const sequence = Number(name.slice(prefix.length));
      return Number.isNaN(sequence) ? max : Math.max(max, sequence);
    }, 0);

    return `${prefix}${String(maxSequence + 1).padStart(3, "0")}`;
  }

  private buildChangeReason(operation: string, parameters: object, fallbackReason: string): string {
    const source = this.resolveChangeTriggerSource(parameters);
    const reasonFromParameters = (parameters as { reason?: unknown }).reason;
    if (typeof reasonFromParameters === "string" && reasonFromParameters.trim().length > 0) {
      return `${reasonFromParameters.trim()} (trigger: ${source})`;
    }
    // Keep reason non-empty and always include trigger source so audit readers can
    // distinguish explicit operator intent from automated/system-originated updates.
    return `${fallbackReason} (trigger: ${source}, operation: ${operation})`;
  }

  private resolveChangeTriggerSource(parameters: object): string {
    const actorId = (parameters as { actorId?: unknown }).actorId;
    if (typeof actorId === "string" && actorId.trim().length > 0) {
      return `actor:${actorId.trim()}`;
    }
    return "system";
  }
}

function sanitizeForJsonLog(value: unknown): JsonLogValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForJsonLog(entry));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeForJsonLog(entry)]);
    return Object.fromEntries(entries);
  }
  return String(value);
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

function nextQuestionId(questions: BacklogQuestion[]): string {
  const maxSequence = questions.reduce((max, question) => {
    const matched = /^Q-(\d+)$/.exec(question.id);
    if (!matched) {
      return max;
    }
    return Math.max(max, Number(matched[1]));
  }, 0);

  return `Q-${String(maxSequence + 1).padStart(3, "0")}`;
}

function normalizeBacklogItems(items: BacklogItems): NormalizedBacklogItems {
  return {
    ...items,
    epics: items.epics.map((epic) => ({ ...epic, kind: epic.kind ?? "product" })),
    items: items.items.map((item) => ({ ...item, kind: item.kind ?? "product" })),
    questions: items.questions ? [...items.questions] : [],
  };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
