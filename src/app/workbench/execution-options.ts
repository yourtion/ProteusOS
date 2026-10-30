/** 可公开给浏览器的执行器选择；不携带凭据或进程配置。 */
export interface ExecutionChoices {
  models?: string[];
  reasoningEfforts?: string[];
}
export interface ExecutorChoice extends ExecutionChoices {
  name: string;
  installed: boolean;
}
export interface ExecutorSettings {
  defaultExecutor: string;
  executors: ExecutorChoice[];
}
export function availableExecutor(settings: ExecutorSettings, selected = ""): string {
  const available = settings.executors.filter((e) => e.installed);
  return (
    available.find((e) => e.name === selected)?.name ??
    available.find((e) => e.name === settings.defaultExecutor)?.name ??
    available[0]?.name ??
    ""
  );
}
export function executionChoices(value: unknown): ExecutionChoices {
  if (value === undefined) return {};
  if (!value || typeof value !== "object") throw new Error("非法模型选项配置");
  const record = value as Record<string, unknown>;
  const result: ExecutionChoices = {};
  for (const key of ["models", "reasoningEfforts"] as const) {
    const list = record[key];
    if (list !== undefined) {
      if (
        !Array.isArray(list) ||
        list.length > 1000 ||
        list.some((v) => typeof v !== "string" || !v.trim() || v.length > 256) ||
        new Set(list).size !== list.length
      )
        throw new Error("非法模型选项配置");
      result[key] = [...list];
    }
  }
  return result;
}
