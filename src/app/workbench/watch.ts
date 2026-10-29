/** Transport revisions are distinct from mutable display activity IDs. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Patch = { path: (string | number)[]; value?: Json; remove?: true };
export function diff(before: Json, after: Json, path: Patch["path"] = []): Patch[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after) &&
    !(Array.isArray(before) && Array.isArray(after) && after.length < before.length)
  ) {
    const a = before as Record<string, Json>,
      b = after as Record<string, Json>;
    const patches: Patch[] = [];
    for (const key of Object.keys(a))
      if (!(key in b)) patches.push({ path: [...path, key], remove: true });
    for (const key of Object.keys(b)) {
      const next = [...path, Array.isArray(after) ? Number(key) : key];
      patches.push(...(key in a ? diff(a[key]!, b[key]!, next) : [{ path: next, value: b[key]! }]));
    }
    return patches;
  }
  return [{ path, value: after }];
}
export function applyPatches(state: Json, patches: Patch[]): Json {
  let result = structuredClone(state);
  for (const patch of patches) {
    if (!patch.path.length) {
      result = patch.value!;
      continue;
    }
    let parent = result as Record<string | number, Json>;
    for (const key of patch.path.slice(0, -1)) parent = parent[key] as typeof parent;
    const key = patch.path.at(-1)!;
    if (patch.remove) delete parent[key];
    else parent[key] = patch.value!;
  }
  return result;
}
export class WatchJournal {
  private seq = 0;
  private state: Json | undefined;
  private frames: { id: string; event: string; data: string }[] = [];
  private readonly epoch: string;
  constructor(epoch: string) {
    this.epoch = epoch;
  }
  read(state: Json, cursor?: string) {
    if (this.state === undefined) {
      this.state = state;
      this.seq++;
    } else {
      const patches = diff(this.state, state);
      if (patches.length) {
        const base = `${this.epoch}:${this.seq}`;
        this.seq++;
        this.frames.push({
          id: `${this.epoch}:${this.seq}`,
          event: "delta",
          data: JSON.stringify({ base, patches }),
        });
        this.state = state;
        while (
          this.frames.length > 32 ||
          this.frames.reduce((n, f) => n + f.data.length, 0) > 1024 * 1024
        )
          this.frames.shift();
      }
    }
    const id = `${this.epoch}:${this.seq}`;
    if (cursor === id) return [];
    const first = this.frames.findIndex((frame) => JSON.parse(frame.data).base === cursor);
    if (cursor && first >= 0) return this.frames.slice(first);
    return [{ id, event: "snapshot", data: JSON.stringify(this.state) }];
  }
}
