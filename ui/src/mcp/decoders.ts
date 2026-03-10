import type {
  CodefleetActivityListResult,
  CodefleetBacklogNotification,
  CodefleetActivityNotification,
  CodefleetEpic,
  CodefleetEpicGetResult,
  CodefleetEpicListResult,
  CodefleetItem,
  CodefleetItemGetResult,
  CodefleetItemListResult,
  CodefleetLogsNotification,
  CodefleetLogsTailResult,
  CodefleetFleetAgent,
  CodefleetFleetRole,
  CodefleetNote,
  CodefleetStatusChangeHistoryEntry,
  CodefleetWatchNotification,
  CodefleetWatchResult,
} from './types';

function decodeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function decodeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function decodeStatusChangeHistory(value: unknown): CodefleetStatusChangeHistoryEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const from = decodeString(record.from);
      const to = decodeString(record.to);
      const changedAt = decodeString(record.changedAt);
      if (!from && !to && !changedAt) return null;
      return { from, to, changedAt } as CodefleetStatusChangeHistoryEntry;
    })
    .filter((entry): entry is CodefleetStatusChangeHistoryEntry => entry !== null);

  return entries.length > 0 ? entries : undefined;
}

function decodeNotes(value: unknown): CodefleetNote[] {
  if (!Array.isArray(value)) return [];

  const notes: CodefleetNote[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.trim().length === 0) continue;
      notes.push({ content: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const content = decodeString(record.content);
    if (!content) continue;
    notes.push({
      id: decodeString(record.id),
      content,
      createdAt: decodeString(record.createdAt),
      createdBy: decodeString(record.createdBy),
    });
  }

  return notes;
}

function decodeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function decodeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function decodeBacklogTargetType(value: unknown): 'epic' | 'item' | 'question' | undefined {
  return value === 'epic' || value === 'item' || value === 'question' ? value : undefined;
}

function decodeWatchTarget(value: unknown): 'backlog' | 'activity' | 'logs' | undefined {
  return value === 'backlog' || value === 'activity' || value === 'logs' ? value : undefined;
}

function decodeWatchResultEntry(raw: unknown): { eventCount?: number; reason?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  return {
    eventCount: decodeNumber(record.eventCount),
    reason: decodeString(record.reason),
  };
}

function decodeRoleAgent(raw: unknown): CodefleetFleetAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const agentId = decodeString(record.agentId);
  const status = decodeString(record.status);
  const busy = decodeBoolean(record.busy);
  if (!agentId || !status || busy === undefined) return null;
  return {
    agentId,
    status,
    busy,
    currentTask: decodeString(record.currentTask),
  };
}

function decodeRoleSummary(raw: unknown): CodefleetFleetRole | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const role = decodeString(record.role);
  if (!role) return null;

  const agentsRaw = Array.isArray(record.agents) ? record.agents : [];
  const agents = agentsRaw
    .map(decodeRoleAgent)
    .filter((agent): agent is CodefleetFleetAgent => agent !== null);

  return {
    role,
    totalAgents: decodeNumber(record.totalAgents) ?? 0,
    runningAgents: decodeNumber(record.runningAgents) ?? 0,
    busyAgents: decodeNumber(record.busyAgents) ?? 0,
    idleAgents: decodeNumber(record.idleAgents) ?? 0,
    failedAgents: decodeNumber(record.failedAgents) ?? 0,
    inflightTasks: decodeNumber(record.inflightTasks) ?? 0,
    inflightTurns: decodeNumber(record.inflightTurns) ?? 0,
    agents,
  };
}

function decodeEpic(raw: unknown): CodefleetEpic | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = decodeString(record.id);
  const title = decodeString(record.title);
  if (!id || !title) return null;

  const visibilityRaw =
    record.visibility && typeof record.visibility === 'object'
      ? (record.visibility as Record<string, unknown>)
      : null;
  const visibilityStateRaw =
    record.visibilityState && typeof record.visibilityState === 'object'
      ? (record.visibilityState as Record<string, unknown>)
      : null;

  return {
    id,
    title,
    kind: decodeString(record.kind),
    developmentScopes: decodeStringArray(record.developmentScopes),
    notes: decodeNotes(record.notes),
    status: decodeString(record.status),
    updatedAt: decodeString(record.updatedAt),
    statusChangeHistory: decodeStatusChangeHistory(record.statusChangeHistory),
    visibilityState: visibilityStateRaw
      ? {
          isVisible: decodeBoolean(visibilityStateRaw.isVisible),
        }
      : undefined,
    visibility: visibilityRaw
      ? {
          type: decodeString(visibilityRaw.type),
          dependsOnEpicIds: decodeStringArray(visibilityRaw.dependsOnEpicIds),
        }
      : undefined,
    acceptanceTestIds: decodeStringArray(record.acceptanceTestIds),
  };
}

function decodeItem(raw: unknown): CodefleetItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = decodeString(record.id);
  const epicId = decodeString(record.epicId);
  const title = decodeString(record.title);
  if (!id || !epicId || !title) return null;

  return {
    id,
    epicId,
    title,
    kind: decodeString(record.kind),
    notes: decodeNotes(record.notes),
    status: decodeString(record.status),
    updatedAt: decodeString(record.updatedAt),
    statusChangeHistory: decodeStatusChangeHistory(record.statusChangeHistory),
    acceptanceTestIds: decodeStringArray(record.acceptanceTestIds),
  };
}

export function decodeCodefleetEpicList(raw: unknown): CodefleetEpicListResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const epicsRaw = Array.isArray(record.epics) ? record.epics : [];
  const epics = epicsRaw.map(decodeEpic).filter((epic): epic is CodefleetEpic => epic !== null);

  return {
    epics,
    count: typeof record.count === 'number' && Number.isFinite(record.count) ? record.count : undefined,
    updatedAt: decodeString(record.updatedAt),
  };
}

export function decodeCodefleetEpicGet(raw: unknown): CodefleetEpicGetResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { epic: decodeEpic(record.epic) };
}

export function decodeCodefleetItemList(raw: unknown): CodefleetItemListResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const itemsRaw = Array.isArray(record.items) ? record.items : [];
  const items = itemsRaw.map(decodeItem).filter((item): item is CodefleetItem => item !== null);

  return {
    items,
    count: typeof record.count === 'number' && Number.isFinite(record.count) ? record.count : undefined,
    updatedAt: decodeString(record.updatedAt),
  };
}

export function decodeCodefleetItemGet(raw: unknown): CodefleetItemGetResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { item: decodeItem(record.item) };
}

export function decodeCodefleetActivityList(raw: unknown): CodefleetActivityListResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rolesRaw = Array.isArray(record.roles) ? record.roles : [];
  const roles = rolesRaw
    .map(decodeRoleSummary)
    .filter((role): role is CodefleetFleetRole => role !== null);
  return {
    updatedAt: decodeString(record.updatedAt),
    roles,
  };
}

export function decodeCodefleetLogsTail(raw: unknown): CodefleetLogsTailResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const agentsRaw = Array.isArray(record.agents) ? record.agents : [];
  const agents: CodefleetLogsTailResult['agents'] = [];
  for (const agentRaw of agentsRaw) {
    if (!agentRaw || typeof agentRaw !== 'object') continue;
    const agentRecord = agentRaw as Record<string, unknown>;
    const agentId = decodeString(agentRecord.agentId);
    if (!agentId) continue;
    agents.push({
      agentId,
      role: decodeString(agentRecord.role),
      lines: decodeStringArray(agentRecord.lines),
      lineCount: decodeNumber(agentRecord.lineCount),
      truncated: decodeBoolean(agentRecord.truncated),
    });
  }
  return {
    role: decodeString(record.role) ?? null,
    agents,
  };
}

export function decodeCodefleetActivityNotification(raw: unknown): CodefleetActivityNotification | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const method = decodeString(record.method);
  if (!method) return null;
  const params =
    record.params && typeof record.params === 'object'
      ? (record.params as Record<string, unknown>)
      : {};

  if (method === 'fleet.activity.snapshot') {
    const rolesRaw = Array.isArray(params.roles) ? params.roles : [];
    const roles = rolesRaw
      .map(decodeRoleSummary)
      .filter((role): role is CodefleetFleetRole => role !== null);
    return {
      method,
      params: {
        updatedAt: decodeString(params.updatedAt),
        roles,
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  if (method === 'fleet.activity.changed') {
    const beforeRaw = decodeRoleAgent(params.before);
    const afterRaw = decodeRoleAgent(params.after);
    return {
      method,
      params: {
        updatedAt: decodeString(params.updatedAt),
        role: decodeString(params.role),
        agentId: decodeString(params.agentId),
        changeType:
          params.changeType === 'task_started' ||
          params.changeType === 'task_finished' ||
          params.changeType === 'agent_status_changed'
            ? params.changeType
            : undefined,
        before: beforeRaw,
        after: afterRaw ?? undefined,
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  if (method === 'fleet.activity.heartbeat') {
    return {
      method,
      params: {
        updatedAt: decodeString(params.updatedAt),
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  if (method === 'fleet.activity.complete') {
    return {
      method,
      params: {
        eventCount: decodeNumber(params.eventCount),
        reason: decodeString(params.reason),
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  return null;
}

export function decodeCodefleetLogsNotification(raw: unknown): CodefleetLogsNotification | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const method = decodeString(record.method);
  if (!method) return null;
  const params =
    record.params && typeof record.params === 'object'
      ? (record.params as Record<string, unknown>)
      : {};

  if (method === 'fleet.logs.chunk') {
    return {
      method,
      params: {
        role: decodeString(params.role) ?? null,
        agentId: decodeString(params.agentId),
        lines: decodeStringArray(params.lines),
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  if (method === 'fleet.logs.complete') {
    return {
      method,
      params: {
        role: decodeString(params.role) ?? null,
        agentCount: decodeNumber(params.agentCount),
        lineCount: decodeNumber(params.lineCount),
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  return null;
}

export function decodeCodefleetBacklogNotification(raw: unknown): CodefleetBacklogNotification | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const method = decodeString(record.method);
  if (!method) return null;
  const params =
    record.params && typeof record.params === 'object'
      ? (record.params as Record<string, unknown>)
      : {};

  if (method === 'backlog.snapshot') {
    const countsRaw =
      params.counts && typeof params.counts === 'object'
        ? (params.counts as Record<string, unknown>)
        : {};
    return {
      method,
      params: {
        updatedAt: decodeString(params.updatedAt),
        version: decodeNumber(params.version),
        counts: {
          epics: decodeNumber(countsRaw.epics) ?? 0,
          items: decodeNumber(countsRaw.items) ?? 0,
          questions: decodeNumber(countsRaw.questions) ?? 0,
        },
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  if (method === 'backlog.changed') {
    const targetsRaw = Array.isArray(params.targets) ? params.targets : [];
    const targets = targetsRaw.flatMap((targetRaw) => {
      if (!targetRaw || typeof targetRaw !== 'object') return [];
      const targetRecord = targetRaw as Record<string, unknown>;
      const type = decodeBacklogTargetType(targetRecord.type);
      const id = decodeString(targetRecord.id);
      if (!type || !id) return [];
      return [{ type, id }];
    });
    return {
      method,
      params: {
        updatedAt: decodeString(params.updatedAt),
        version: decodeNumber(params.version),
        changeId: decodeString(params.changeId),
        operation: decodeString(params.operation),
        reason: decodeString(params.reason),
        itemsJsonVersion: decodeNumber(params.itemsJsonVersion),
        targetType: decodeBacklogTargetType(params.targetType),
        targetId: decodeString(params.targetId),
        targets: targets.length > 0 ? targets : undefined,
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  if (method === 'backlog.heartbeat') {
    return {
      method,
      params: {
        updatedAt: decodeString(params.updatedAt),
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  if (method === 'backlog.complete') {
    return {
      method,
      params: {
        eventCount: decodeNumber(params.eventCount),
        reason: decodeString(params.reason),
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  return null;
}

export function decodeCodefleetWatchResult(raw: unknown): CodefleetWatchResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const resultsRaw =
    record.results && typeof record.results === 'object'
      ? (record.results as Record<string, unknown>)
      : {};
  return {
    reason: decodeString(record.reason),
    startedAt: decodeString(record.startedAt),
    endedAt: decodeString(record.endedAt),
    results: {
      backlog: decodeWatchResultEntry(resultsRaw.backlog),
      activity: decodeWatchResultEntry(resultsRaw.activity),
      logs: decodeWatchResultEntry(resultsRaw.logs),
    },
  };
}

export function decodeCodefleetWatchNotification(raw: unknown): CodefleetWatchNotification | null {
  const activityEvent = decodeCodefleetActivityNotification(raw);
  if (activityEvent) return activityEvent;

  const logsEvent = decodeCodefleetLogsNotification(raw);
  if (logsEvent) return logsEvent;

  const backlogEvent = decodeCodefleetBacklogNotification(raw);
  if (backlogEvent) return backlogEvent;

  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const method = decodeString(record.method);
  if (!method) return null;
  const params =
    record.params && typeof record.params === 'object'
      ? (record.params as Record<string, unknown>)
      : {};

  if (method === 'fleet.watch.error') {
    return {
      method,
      params: {
        target: decodeWatchTarget(params.target) ?? decodeString(params.target),
        message: decodeString(params.message),
        code: decodeString(params.code),
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  if (method === 'fleet.watch.complete') {
    const resultsRaw =
      params.results && typeof params.results === 'object'
        ? (params.results as Record<string, unknown>)
        : {};
    return {
      method,
      params: {
        reason: decodeString(params.reason),
        startedAt: decodeString(params.startedAt),
        endedAt: decodeString(params.endedAt),
        results: {
          backlog: decodeWatchResultEntry(resultsRaw.backlog),
          activity: decodeWatchResultEntry(resultsRaw.activity),
          logs: decodeWatchResultEntry(resultsRaw.logs),
        },
        notificationToken: decodeString(params.notificationToken),
      },
    };
  }

  return null;
}
