export type BacklogEpicStatus =
  | "todo"
  | "in-progress"
  | "in-review"
  | "changes-requested"
  | "done"
  | "failed";
export type BacklogItemStatus = "todo" | "wait-implementation" | "in-progress" | "done" | "blocked";
export interface StatusChangeHistoryEntry<TStatus extends string> {
  from: TStatus;
  to: TStatus;
  changedAt: string;
}

export type BacklogEpicStatusChangeHistory = StatusChangeHistoryEntry<BacklogEpicStatus>[];
export type BacklogItemStatusChangeHistory = StatusChangeHistoryEntry<BacklogItemStatus>[];
export type BacklogQuestionStatus = "open" | "answered";
export type BacklogWorkKind = "product" | "technical";

export type VisibilityType = "always-visible" | "blocked-until-epic-complete";

export interface BacklogNote {
  id: string;
  content: string;
  createdAt: string;
  createdBy?: string;
}

export interface VisibilityRule {
  type: VisibilityType;
  dependsOnEpicIds: string[];
}

export interface BacklogEpic {
  id: string;
  title: string;
  kind?: BacklogWorkKind;
  notes?: BacklogNote[];
  status: BacklogEpicStatus;
  statusChangeHistory: BacklogEpicStatusChangeHistory;
  visibility: VisibilityRule;
  acceptanceTestIds: string[];
  updatedAt: string;
}

export interface BacklogItem {
  id: string;
  epicId: string;
  title: string;
  kind?: BacklogWorkKind;
  notes?: BacklogNote[];
  status: BacklogItemStatus;
  statusChangeHistory: BacklogItemStatusChangeHistory;
  acceptanceTestIds: string[];
  updatedAt: string;
}

export interface BacklogQuestion {
  id: string;
  title: string;
  details?: string;
  status: BacklogQuestionStatus;
  answer?: string;
  updatedAt: string;
}

export interface BacklogItems {
  version: number;
  updatedAt: string;
  epics: BacklogEpic[];
  items: BacklogItem[];
  questions?: BacklogQuestion[];
}
