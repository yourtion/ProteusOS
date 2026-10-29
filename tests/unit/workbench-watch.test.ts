import { expect, it } from "vitest";
import { applyPatches, diff, WatchJournal, type Json } from "../../src/app/workbench/watch.ts";
it("patches merged message blocks, appends events and replaces shortened arrays", () => {
  const before: Json = {
    runs: [{ id: "r", state: "running" }],
    detail: { activity: [{ id: 1, text: "hello" }], old: true },
  };
  const after: Json = {
    runs: [{ id: "r", state: "succeeded" }],
    detail: {
      activity: [
        { id: 1, text: "hello world" },
        { id: 2, text: "done" },
      ],
    },
  };
  expect(applyPatches(before, diff(before, after))).toEqual(after);
  expect(applyPatches(after, diff(after, before))).toEqual(before);
  expect(before).toHaveProperty("detail.old", true);
});
it("replays ordered deltas after disconnect and resets expired or foreign cursors", () => {
  const journal = new WatchJournal("epoch");
  const initial = journal.read({ count: 0 })[0]!;
  const first = journal.read({ count: 1 }, initial.id)[0]!;
  const second = journal.read({ count: 2 }, first.id)[0]!;
  expect(journal.read({ count: 2 }, initial.id)).toEqual([first, second]);
  expect(journal.read({ count: 2 }, second.id)).toEqual([]);
  expect(journal.read({ count: 2 }, "other:3")[0]?.event).toBe("snapshot");
  for (let count = 3; count < 40; count++) journal.read({ count });
  expect(journal.read({ count: 39 }, initial.id)[0]?.event).toBe("snapshot");
});
it("reconstructs the latest state without duplicating coalesced activities", () => {
  const journal = new WatchJournal("run");
  let state: Json = { activity: [{ id: 1, text: "a" }] };
  let cursor = journal.read(state)[0]!.id;
  for (const text of ["ab", "abc", "abcd"]) {
    const expected: Json = { activity: [{ id: 1, text }] };
    for (const frame of journal.read(expected, cursor)) {
      const { patches, base } = JSON.parse(frame.data);
      expect(base).toBe(cursor);
      state = applyPatches(state, patches);
      cursor = frame.id;
    }
    expect(state).toEqual(expected);
  }
});
