export type Tone = "neutral" | "success" | "warning" | "danger" | "info";
const states: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "排队中", tone: "neutral" },
  queued: { label: "排队中", tone: "neutral" },
  running: { label: "执行中", tone: "info" },
  waiting: { label: "等待处理", tone: "warning" },
  succeeded: { label: "执行完成", tone: "success" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "执行失败", tone: "danger" },
  cancelled: { label: "已停止", tone: "neutral" },
  eligible: { label: "可采用", tone: "success" },
  rejected: { label: "未通过", tone: "danger" },
};
export function statusMeta(state: string) {
  return states[state] ?? { label: state || "未知", tone: "neutral" as const };
}
