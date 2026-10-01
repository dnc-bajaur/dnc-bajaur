/**
 * The harness surface injected into the test browser.
 *
 * Declared once, here, because two suites drive the same bundled harness and TypeScript
 * will not accept the same global being declared twice.
 */

interface DncOutbox {
  enqueue(draft: unknown): Promise<{ eventId: string; clientSeq: number }>;
  sync(): Promise<{ offline: boolean; pushed: number; pulled: number }>;
  pendingCount(): Promise<number>;
}

interface DncStore {
  put(entry: unknown): Promise<void>;
  all(): Promise<{ event: { eventId: string; payload: unknown }; state: string }[]>;
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
  close(): void;
}

declare const DNC: {
  openStore(name: string): Promise<DncStore>;
  makeEvent(type: string, payload: unknown, clientSeq: number): { eventId: string };
  draft(type: string, payload?: unknown, incidentId?: string): unknown;
  makeOutbox(store: DncStore, opts: { offline: boolean }): DncOutbox;
  makeRealOutbox(store: DncStore, baseUrl: string): DncOutbox;
  reportDraft(incidentId: string, note: string, severity: string): unknown;
};
