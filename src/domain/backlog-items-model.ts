export type BacklogEpicStatus =
  | "todo"
  | "in-progress"
  | "in-review"
  | "changes-requested"
  | "done"
  | "failed";
export type BacklogItemStatus = "todo" | "wait-implementation" | "in-progress" | "done" | "blocked";
export type BacklogEpicStatusChangedAt = Partial<Record<BacklogEpicStatus, string>>;
export type BacklogItemStatusChangedAt = Partial<Record<BacklogItemStatus, string>>;
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
  statusChangedAt: BacklogEpicStatusChangedAt;
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
  statusChangedAt: BacklogItemStatusChangedAt;
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
