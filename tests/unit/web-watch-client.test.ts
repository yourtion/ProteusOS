import { afterEach, expect, it, vi } from "vitest";
import { watchWorkbench, type WatchEvent, type WatchSource } from "../../web/src/watch-client.ts";
import { WatchJournal, type Json } from "../../src/app/workbench/watch.ts";
class Source implements WatchSource {
  listeners = new Map<string, (event: WatchEvent) => void>();
  close = vi.fn();
  listen(type: string, listener: (event: WatchEvent) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, data: unknown = {}, id = "") {
    this.listeners.get(type)?.({
      data: typeof data === "string" ? data : JSON.stringify(data),
      id,
    });
  }
}
function setup(runId = "run") {
  vi.useFakeTimers();
  const sources: Source[] = [];
  const snapshots = vi.fn();
  const status = vi.fn();
  const open = vi.fn(() => {
    const source = new Source();
    sources.push(source);
    return source;
  });
  const close = watchWorkbench(runId, { onSnapshot: snapshots, onStatus: status }, open);
  return { sources, snapshots, status, open, close };
}
afterEach(() => vi.useRealTimers());
it("reconstructs journal snapshots and replayed deltas without duplicate updates", () => {
  const f = setup();
  const journal = new WatchJournal("epoch");
  const state: Json = { runs: [{ id: "run" }], detail: { id: "run", text: "a" } };
  const first = journal.read(state)[0]!;
  f.sources[0]!.emit(first.event, first.data, first.id);
  f.sources[0]!.emit("error");
  expect(f.status).toHaveBeenLastCalledWith("reconnecting");
  const next: Json = { ...state, detail: { id: "run", text: "abc" } };
  const delta = journal.read(next, first.id)[0]!;
  f.sources[0]!.emit(delta.event, delta.data, delta.id);
  f.sources[0]!.emit(delta.event, delta.data, delta.id);
  expect(f.snapshots).toHaveBeenCalledTimes(2);
  expect(f.snapshots).toHaveBeenLastCalledWith(next);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.status).toHaveBeenLastCalledWith("connected");
  f.close();
});
it("reopens without a cursor on a gap and ignores queued messages from the old stream", () => {
  const f = setup("run/1");
  f.sources[0]!.emit("snapshot", { runs: [], detail: { id: "run/1" } }, "epoch:1");
  f.sources[0]!.emit("delta", { base: "epoch:9", patches: [] }, "epoch:10");
  expect(f.sources[0]!.close).toHaveBeenCalledTimes(1);
  f.sources[0]!.emit("snapshot", { runs: [{ stale: true }], detail: null }, "epoch:10");
  expect(f.snapshots).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(500);
  expect(f.open).toHaveBeenLastCalledWith("/api/watch?runId=run%2F1");
  f.sources[1]!.emit("snapshot", { runs: [], detail: { id: "run/1", text: "latest" } }, "fresh:1");
  expect(f.snapshots).toHaveBeenLastCalledWith({
    runs: [],
    detail: { id: "run/1", text: "latest" },
  });
  f.close();
});
it("rejects malformed frames and wrong-task projections with bounded backoff", () => {
  const f = setup();
  f.sources[0]!.emit("snapshot", "invalid json", "epoch:1");
  vi.advanceTimersByTime(500);
  f.sources[1]!.emit("snapshot", { runs: [], detail: { id: "other-run" } }, "epoch:2");
  vi.advanceTimersByTime(999);
  expect(f.open).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1);
  f.sources[2]!.emit("delta", { base: "epoch:2", patches: [] }, "epoch:3");
  expect(f.snapshots).not.toHaveBeenCalled();
  f.close();
  vi.runAllTimers();
  expect(f.open).toHaveBeenCalledTimes(3);
});
it("stops updates and reconnect timers when switching away from a task", () => {
  const f = setup();
  f.sources[0]!.emit("snapshot", { runs: "bad", detail: null }, "epoch:1");
  f.close();
  f.sources[0]!.emit("snapshot", { runs: [], detail: { id: "run" } }, "epoch:2");
  f.sources[0]!.emit("open");
  vi.runAllTimers();
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.snapshots).not.toHaveBeenCalled();
});
it("waits for a valid snapshot before reporting the initial connection as synchronized", () => {
  const f = setup("");
  f.sources[0]!.emit("open");
  expect(f.status).toHaveBeenLastCalledWith("connecting");
  f.sources[0]!.emit("snapshot", { runs: [], detail: null }, "epoch:1");
  expect(f.status).toHaveBeenLastCalledWith("connected");
  f.close();
});
