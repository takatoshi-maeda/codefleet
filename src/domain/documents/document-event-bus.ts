import type { DocumentActor } from "./document-service.js";

export type DocumentWatchEvent =
  | {
      type: "document.changed";
      payload: {
        path: string;
        version: string;
        updatedAt: string;
        updatedBy: DocumentActor | null;
        change: { kind: "created" | "updated" };
      };
    }
  | {
      type: "document.deleted";
      payload: {
        path: string;
        updatedAt: string;
        change: { kind: "deleted" };
      };
    };

type Listener = (event: DocumentWatchEvent) => void;

export class DocumentEventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: DocumentWatchEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
