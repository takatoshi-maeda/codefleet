import { BuildfleetError } from "../../shared/errors.js";
import type { BacklogEpicStatus, BacklogItemStatus } from "../backlog-items-model.js";

const EPIC_TRANSITIONS: Record<BacklogEpicStatus, BacklogEpicStatus[]> = {
  todo: ["in-progress", "blocked"],
  "in-progress": ["done", "blocked"],
  done: [],
  blocked: ["todo", "in-progress"],
};

const ITEM_TRANSITIONS: Record<BacklogItemStatus, BacklogItemStatus[]> = {
  todo: ["wait-implementation", "blocked"],
  "wait-implementation": ["in-progress", "blocked"],
  "in-progress": ["done", "blocked"],
  done: [],
  blocked: ["todo", "wait-implementation", "in-progress"],
};

export function ensureValidEpicStatusTransition(
  from: BacklogEpicStatus,
  to: BacklogEpicStatus,
  reopen = false,
): void {
  if (from === to) {
    return;
  }
  if (from === "done" && to === "in-progress" && reopen) {
    return;
  }
  if (!EPIC_TRANSITIONS[from].includes(to)) {
    throw new BuildfleetError("ERR_VALIDATION", `invalid epic status transition: ${from} -> ${to}`);
  }
}

export function ensureValidItemStatusTransition(
  from: BacklogItemStatus,
  to: BacklogItemStatus,
  reopen = false,
): void {
  if (from === to) {
    return;
  }
  if (from === "done" && to === "in-progress" && reopen) {
    return;
  }
  if (!ITEM_TRANSITIONS[from].includes(to)) {
    throw new BuildfleetError("ERR_VALIDATION", `invalid item status transition: ${from} -> ${to}`);
  }
}
