import type { Activity } from "../../src/app/workbench/contracts.ts";

export interface ToolView {
  id: string;
  title: string;
  data: NonNullable<Activity["data"]>;
  start: number;
  end: number;
}
/** First-observed order, latest defined fields, and sticky truncation evidence. */
export function collectTools(activities: Activity[]): ToolView[] {
  const calls = new Map<string, ToolView>();
  for (const event of activities) {
    if (event.kind !== "tool") continue;
    const id = event.data?.toolCallId ?? `activity-${event.id}`;
    const previous = calls.get(id);
    const patch = Object.fromEntries(
      Object.entries(event.data ?? {}).filter(([, value]) => value !== undefined),
    );
    calls.set(id, {
      id,
      title: event.text || previous?.title || "工具调用",
      data: {
        ...previous?.data,
        ...patch,
        truncated: !!(previous?.data.truncated || event.data?.truncated),
      },
      start: previous?.start ?? event.at,
      end: event.at,
    });
  }
  return [...calls.values()];
}
export const toolStatus: Record<string, string> = {
  pending: "等待",
  in_progress: "执行中",
  completed: "完成",
  failed: "失败",
  cancelled: "已停止",
};
export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000
    ? `${Math.round(ms)}ms`
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
