export type CodefleetNote = {
  id?: string;
  content: string;
  createdAt?: string;
  createdBy?: string;
};

export type CodefleetStatusChangeHistoryEntry = {
  from?: string;
  to?: string;
  changedAt?: string;
};

export type CodefleetEpic = {
  id: string;
  title: string;
  kind?: string;
  developmentScopes?: string[];
  notes: CodefleetNote[];
  status?: string;
  updatedAt?: string;
  statusChangeHistory?: CodefleetStatusChangeHistoryEntry[];
  visibilityState?: {
    isVisible?: boolean;
  };
  visibility?: {
    type?: string;
    dependsOnEpicIds?: string[];
  };
  acceptanceTestIds?: string[];
};

export type CodefleetItem = {
  id: string;
  epicId: string;
  title: string;
  kind?: string;
  notes: CodefleetNote[];
  status?: string;
  updatedAt?: string;
  statusChangeHistory?: CodefleetStatusChangeHistoryEntry[];
  acceptanceTestIds?: string[];
};

export type CodefleetEpicListResult = {
  epics: CodefleetEpic[];
  count?: number;
  updatedAt?: string;
};

export type CodefleetEpicGetResult = {
  epic: CodefleetEpic | null;
};

export type CodefleetItemListResult = {
  items: CodefleetItem[];
  count?: number;
  updatedAt?: string;
};

export type CodefleetItemGetResult = {
  item: CodefleetItem | null;
};

export type CodefleetAgentRole =
  | 'Orchestrator'
  | 'Developer'
  | 'Polisher'
  | 'Gatekeeper'
  | 'Reviewer';

export type CodefleetFleetAgent = {
  agentId: string;
  status: string;
  busy: boolean;
  currentTask?: string;
};

export type CodefleetFleetRole = {
  role: string;
  totalAgents: number;
  runningAgents: number;
  busyAgents: number;
  idleAgents: number;
  failedAgents: number;
  inflightTasks: number;
  inflightTurns: number;
  agents: CodefleetFleetAgent[];
};

export type CodefleetActivityListResult = {
  updatedAt?: string;
  roles: CodefleetFleetRole[];
};

export type CodefleetActivitySnapshotEvent = {
  method: 'fleet.activity.snapshot';
  params: {
    updatedAt?: string;
    roles: CodefleetFleetRole[];
    notificationToken?: string;
  };
};

export type CodefleetActivityChangedEvent = {
  method: 'fleet.activity.changed';
  params: {
    updatedAt?: string;
    role?: string;
    agentId?: string;
    changeType?: 'task_started' | 'task_finished' | 'agent_status_changed';
    before?: CodefleetFleetAgent | null;
    after?: CodefleetFleetAgent;
    notificationToken?: string;
  };
};

export type CodefleetActivityHeartbeatEvent = {
  method: 'fleet.activity.heartbeat';
  params: {
    updatedAt?: string;
    notificationToken?: string;
  };
};

export type CodefleetActivityCompleteEvent = {
  method: 'fleet.activity.complete';
  params: {
    eventCount?: number;
    reason?: string;
    notificationToken?: string;
  };
};

export type CodefleetActivityNotification =
  | CodefleetActivitySnapshotEvent
  | CodefleetActivityChangedEvent
  | CodefleetActivityHeartbeatEvent
  | CodefleetActivityCompleteEvent;

export type CodefleetLogsAgent = {
  agentId: string;
  role?: string;
  lines: string[];
  lineCount?: number;
  truncated?: boolean;
};

export type CodefleetLogsTailResult = {
  role: string | null;
  agents: CodefleetLogsAgent[];
};

export type CodefleetLogsChunkEvent = {
  method: 'fleet.logs.chunk';
  params: {
    role?: string | null;
    agentId?: string;
    lines: string[];
    notificationToken?: string;
  };
};

export type CodefleetLogsCompleteEvent = {
  method: 'fleet.logs.complete';
  params: {
    role?: string | null;
    agentCount?: number;
    lineCount?: number;
    notificationToken?: string;
  };
};

export type CodefleetLogsNotification = CodefleetLogsChunkEvent | CodefleetLogsCompleteEvent;

export type CodefleetBacklogSnapshotEvent = {
  method: 'backlog.snapshot';
  params: {
    updatedAt?: string;
    version?: number;
    counts: {
      epics: number;
      items: number;
      questions: number;
    };
    notificationToken?: string;
  };
};

export type CodefleetBacklogChangedEvent = {
  method: 'backlog.changed';
  params: {
    updatedAt?: string;
    version?: number;
    changeId?: string;
    operation?: string;
    reason?: string;
    itemsJsonVersion?: number;
    targetType?: 'epic' | 'item' | 'question';
    targetId?: string;
    targets?: {
      type: 'epic' | 'item' | 'question';
      id: string;
    }[];
    notificationToken?: string;
  };
};

export type CodefleetBacklogHeartbeatEvent = {
  method: 'backlog.heartbeat';
  params: {
    updatedAt?: string;
    notificationToken?: string;
  };
};

export type CodefleetBacklogCompleteEvent = {
  method: 'backlog.complete';
  params: {
    eventCount?: number;
    reason?: string;
    notificationToken?: string;
  };
};

export type CodefleetBacklogNotification =
  | CodefleetBacklogSnapshotEvent
  | CodefleetBacklogChangedEvent
  | CodefleetBacklogHeartbeatEvent
  | CodefleetBacklogCompleteEvent;

export type CodefleetWatchErrorEvent = {
  method: 'fleet.watch.error';
  params: {
    target?: 'backlog' | 'activity' | 'logs' | string;
    message?: string;
    code?: string;
    notificationToken?: string;
  };
};

export type CodefleetWatchCompleteEvent = {
  method: 'fleet.watch.complete';
  params: {
    reason?: string;
    startedAt?: string;
    endedAt?: string;
    results?: {
      backlog?: { eventCount?: number; reason?: string };
      activity?: { eventCount?: number; reason?: string };
      logs?: { eventCount?: number; reason?: string };
    };
    notificationToken?: string;
  };
};

export type CodefleetWatchResult = {
  reason?: string;
  startedAt?: string;
  endedAt?: string;
  results?: {
    backlog?: { eventCount?: number; reason?: string };
    activity?: { eventCount?: number; reason?: string };
    logs?: { eventCount?: number; reason?: string };
  };
};

export type CodefleetWatchNotification =
  | CodefleetActivityNotification
  | CodefleetLogsNotification
  | CodefleetBacklogNotification
  | CodefleetWatchErrorEvent
  | CodefleetWatchCompleteEvent;
