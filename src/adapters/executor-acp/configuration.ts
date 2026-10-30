import type { SessionConfigOption } from "@agentclientprotocol/sdk";
/** 使用 agent 声明的选项应用模型/强度；不把用户选择静默丢弃。 */
export async function applySessionConfiguration(
  initial: SessionConfigOption[] | null | undefined,
  selection: { model?: string; reasoningEffort?: string },
  set: (id: string, value: string) => Promise<SessionConfigOption[]>,
): Promise<void> {
  let options = initial ?? [];
  for (const [category, value, aliases] of [
    ["model", selection.model, ["model", "model_id"]],
    [
      "thought_level",
      selection.reasoningEffort,
      ["reasoning_effort", "effort", "thinking_level", "thought_level"],
    ],
  ] as const) {
    if (!value) continue;
    const option = options.find(
      (o) => o.category === category || aliases.some((id) => id === o.id),
    );
    if (!option || option.type !== "select")
      throw new Error(
        `ACP 执行器未声明可选配置：${category}；请使用执行器默认值或补充 agent 配置支持`,
      );
    const values = option.options.flatMap((item) => ("options" in item ? item.options : [item]));
    if (!values.some((item) => item.value === value))
      throw new Error(`ACP 不支持所选配置：${category}=${value}`);
    options = await set(option.id, value);
    const applied = options.find((o) => o.id === option.id);
    if (!applied || applied.type !== "select" || applied.currentValue !== value)
      throw new Error(`ACP 未确认配置生效：${category}`);
  }
}
