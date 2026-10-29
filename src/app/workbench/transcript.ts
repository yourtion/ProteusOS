import type { Activity } from "./contracts.ts";
/** Public display projection, not an immutable audit log or provider request history. */
export type TranscriptNode =
  | { id: string; kind: "message" | "plan"; text: string; at: number }
  | { id: string; kind: "tool"; activities: Activity[]; at: number };
export function projectTranscript(activities: Activity[]): TranscriptNode[] {
  const nodes: TranscriptNode[] = [];
  const calls = new Map<string, Extract<TranscriptNode, { kind: "tool" }>>();
  for (const activity of activities) {
    if (activity.kind === "tool") {
      const id = activity.data?.toolCallId ?? `activity-${activity.id}`;
      const existing = calls.get(id);
      if (existing) existing.activities.push(activity);
      else {
        const node = {
          id: `tool-${id}`,
          kind: "tool" as const,
          activities: [activity],
          at: activity.at,
        };
        calls.set(id, node);
        nodes.push(node);
      }
    } else if (activity.kind === "message" || activity.kind === "plan") {
      const last = nodes.at(-1);
      if (activity.kind === "message" && last?.kind === "message") last.text += activity.text;
      else
        nodes.push({
          id: `activity-${activity.id}`,
          kind: activity.kind,
          text: activity.text,
          at: activity.at,
        });
    }
  }
  return nodes;
}
