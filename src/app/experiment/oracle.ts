import type { DecisionProvider, DecisionRequest, DecisionResult } from "../../decision/index.ts";

/**
 * Oracle 预检 Provider（实验规范 §6 步骤 4）：由 runner 在每次提交前
 * 注入强制选择（gold 或错误项），验证执行/裁判装配——正确选择必须验收
 * 通过、错误选择必须被同一固定裁判拒绝。只在实验入口显式装配，
 * 不在生产接口新增绕过选择校验的通道（Runtime 仍独立校验选项成员关系）。
 */
export class OracleDecisionProvider implements DecisionProvider {
  readonly name = "decision-oracle";
  private nextChoice: string = "";
  /** 断言 runner 忘记注入就立即失败，绝不出声地选择 */
  private armed = false;

  arm(choice: string): void {
    this.nextChoice = choice;
    this.armed = true;
  }

  disarm(): void {
    this.armed = false;
  }

  capabilities(): { problems: Array<"choice" | "gate" | "rank"> } {
    return { problems: ["choice"] };
  }

  decide(request: DecisionRequest): Promise<DecisionResult> {
    if (!this.armed) {
      return Promise.reject(new Error("oracle provider 未装配选择（runner 必须先 arm）"));
    }
    const choice = this.nextChoice;
    this.armed = false;
    if (!request.options.includes(choice)) {
      return Promise.reject(
        new Error(`oracle 注入的选择 ${choice} 不在候选 [${request.options.join(", ")}] 内`),
      );
    }
    return Promise.resolve({
      kind: "value",
      value: choice,
      provenance: { provider: this.name, policyVersion: request.policy.versionId },
      raw: JSON.stringify({ kind: "value", value: choice, forcedBy: "oracle-precheck" }),
    });
  }

  callProvenance() {
    return {
      adapter: "decision-oracle@test",
      serviceId: null,
      requestedModel: null,
      sampling: null,
      promptDigest: null,
      reproducibility: "pinned" as const,
    };
  }
}
