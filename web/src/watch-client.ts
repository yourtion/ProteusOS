import { applyPatches, type Json, type Patch } from "../../src/app/workbench/watch.ts";
export type WatchStatus = "connecting" | "connected" | "reconnecting";
export type WatchEvent = { data: string; id: string };
export interface WatchSource {
  listen(
    type: "open" | "error" | "snapshot" | "delta",
    listener: (event: WatchEvent) => void,
  ): void;
  close(): void;
}
/** Owns stream state, resynchronization and lifecycle; views only receive complete projections. */
export function watchWorkbench<Run, Detail>(
  runId: string,
  callbacks: {
    onSnapshot: (snapshot: { runs: Run[]; detail: Detail | null }) => void;
    onStatus: (status: WatchStatus) => void;
  },
  openSource: (url: string) => WatchSource,
) {
  let closed = false;
  let source: WatchSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  function connect() {
    if (closed) return;
    callbacks.onStatus(failures ? "reconnecting" : "connecting");
    const current = openSource(`/api/watch${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
    source = current;
    let state: Json = null;
    let cursor = "";
    const active = () => !closed && source === current;
    function resync() {
      if (!active()) return;
      source = undefined;
      current.close();
      callbacks.onStatus("reconnecting");
      timer = setTimeout(connect, Math.min(500 * 2 ** Math.min(failures++, 6), 30000));
    }
    function publish(next: Json, id: string) {
      if (
        !id ||
        !next ||
        typeof next !== "object" ||
        Array.isArray(next) ||
        !Array.isArray(next.runs) ||
        !("detail" in next) ||
        (next.detail !== null &&
          (typeof next.detail !== "object" ||
            Array.isArray(next.detail) ||
            next.detail.id !== runId))
      ) {
        throw new Error("Invalid watch projection");
      }
      state = next;
      cursor = id;
      failures = 0;
      callbacks.onSnapshot(next as unknown as { runs: Run[]; detail: Detail | null });
      callbacks.onStatus("connected");
    }
    current.listen("snapshot", (event) => {
      if (!active()) return;
      try {
        publish(JSON.parse(event.data), event.id);
      } catch {
        resync();
      }
    });
    current.listen("delta", (event) => {
      if (!active() || (cursor && event.id === cursor)) return;
      try {
        const delta = JSON.parse(event.data) as { base: string; patches: Patch[] };
        if (!cursor || delta.base !== cursor || !Array.isArray(delta.patches)) return resync();
        publish(applyPatches(state, delta.patches), event.id);
      } catch {
        resync();
      }
    });
    // Native EventSource retains the cursor across ordinary network reconnects.
    current.listen("error", () => {
      if (active()) callbacks.onStatus("reconnecting");
    });
    current.listen("open", () => {
      if (active()) callbacks.onStatus(cursor ? "connected" : "connecting");
    });
  }
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
    source = undefined;
  };
}
