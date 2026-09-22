import { z } from "zod";

/**
 * 执行图（docs/runtime.md §2）：提交前可验证的有限 DAG。
 * dag-v1 支持 decision / execute / verify 三类节点；
 * pipeline-v1（切片① 的单节点图）继续可解析并归一化为单节点 DAG。
 */

export const DecisionNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("decision"),
  provider: z.string().min(1),
  problem: z.literal("choice"),
  options: z.array(z.string().min(1)).min(1),
  context: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string().min(1)).default([]),
  /** 声明消费 decision-view-v1（实验图）：快照须含 decision-view 槽位，缺失拒绝准入 */
  view: z.literal("decision-view-v1").optional(),
});

export const ExecuteNodeSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("execute"),
    /** 直接声明执行器，或 executorFrom 引用一个 decision 节点的结果 */
    executor: z.string().min(1).optional(),
    executorFrom: z.string().min(1).optional(),
    dependsOn: z.array(z.string().min(1)),
  })
  .refine((v) => Boolean(v.executor) !== Boolean(v.executorFrom), {
    message: "executor 与 executorFrom 必须二选一",
  });

export const VerifyNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("verify"),
  /** 必须与快照 acceptance-evaluator 槽位绑定的 artifact 一致 */
  verifier: z.string().min(1),
  inputFrom: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
});

const DagNodeSchema = z.discriminatedUnion("type", [
  DecisionNodeSchema,
  ExecuteNodeSchema,
  VerifyNodeSchema,
]);

export const DagGraphSchema = z.object({
  schemaVersion: z.number().int().min(1),
  kind: z.literal("dag-v1"),
  nodes: z.array(DagNodeSchema).min(1),
});

export const PipelineNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("execute"),
  executor: z.string().min(1),
});

export const PipelineGraphSchema = z.object({
  schemaVersion: z.number().int().min(1),
  kind: z.literal("pipeline-v1"),
  nodes: z.array(PipelineNodeSchema).length(1),
});

export type DagGraph = z.infer<typeof DagGraphSchema>;
export type PipelineGraph = z.infer<typeof PipelineGraphSchema>;
export type AnyGraph = DagGraph | PipelineGraph;

export type NodeType = "decision" | "execute" | "verify";

export interface NormalizedNode {
  id: string;
  type: NodeType;
  dependsOn: string[];
  /** decision */
  provider?: string;
  problem?: "choice";
  options?: string[];
  context?: Record<string, unknown>;
  /** decision：消费 decision-view-v1（实验图）；旧图无此字段走静态上下文 */
  view?: "decision-view-v1";
  /** execute */
  executor?: string;
  executorFrom?: string;
  /** verify */
  verifier?: string;
  inputFrom?: string;
}

export interface NormalizedDag {
  source: "pipeline-v1" | "dag-v1";
  nodes: NormalizedNode[];
}

export class GraphError extends Error {
  readonly code:
    | "schema"
    | "duplicate_node_id"
    | "unknown_dependency"
    | "cycle_detected"
    | "invalid_reference"
    | "no_execute_node";

  constructor(code: GraphError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function parseGraph(content: string): AnyGraph {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err) {
    throw new GraphError("schema", `图内容不是合法 JSON：${String(err)}`);
  }
  const parsed = z.union([DagGraphSchema, PipelineGraphSchema]).safeParse(json);
  if (!parsed.success) {
    throw new GraphError("schema", `图内容不符合 dag-v1 / pipeline-v1：${parsed.error.message}`);
  }
  return parsed.data;
}

/** pipeline-v1 归一化为无依赖单 execute 节点的 DAG */
export function normalizeDag(graph: AnyGraph): NormalizedDag {
  if (graph.kind === "pipeline-v1") {
    const node = graph.nodes[0]!;
    return {
      source: "pipeline-v1",
      nodes: [{ id: node.id, type: "execute", dependsOn: [], executor: node.executor }],
    };
  }
  return {
    source: "dag-v1",
    nodes: graph.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn] })),
  };
}

/**
 * 提交前可验证的 DAG 不变量：节点 ID 唯一、依赖存在、无环、
 * executorFrom 指向 decision 且在依赖内、inputFrom 指向 execute 且在依赖内、
 * 至少一个 execute 节点。
 */
export function validateDag(dag: NormalizedDag): void {
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  if (byId.size !== dag.nodes.length) {
    throw new GraphError("duplicate_node_id", "节点 ID 重复");
  }
  if (!dag.nodes.some((n) => n.type === "execute")) {
    throw new GraphError("no_execute_node", "图缺少 execute 节点");
  }
  for (const node of dag.nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) {
        throw new GraphError("unknown_dependency", `节点 ${node.id} 依赖不存在的 ${dep}`);
      }
    }
  }
  for (const node of dag.nodes) {
    if (node.type === "execute" && node.executorFrom) {
      const target = byId.get(node.executorFrom);
      if (!target || target.type !== "decision") {
        throw new GraphError(
          "invalid_reference",
          `executorFrom ${node.executorFrom} 不是 decision 节点`,
        );
      }
      if (!node.dependsOn.includes(node.executorFrom)) {
        throw new GraphError(
          "invalid_reference",
          `executorFrom ${node.executorFrom} 必须同时在 dependsOn 中`,
        );
      }
    }
    if (node.type === "verify") {
      const target = byId.get(node.inputFrom!);
      if (!target || target.type !== "execute") {
        throw new GraphError("invalid_reference", `inputFrom ${node.inputFrom} 不是 execute 节点`);
      }
      if (!node.dependsOn.includes(node.inputFrom!)) {
        throw new GraphError(
          "invalid_reference",
          `inputFrom ${node.inputFrom} 必须同时在 dependsOn 中`,
        );
      }
    }
  }
  topoOrder(dag);
}

/** Kahn 拓扑排序；有环抛 GraphError，同层按节点 ID 排序保证确定性 */
export function topoOrder(dag: NormalizedDag): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of dag.nodes) {
    indegree.set(node.id, node.dependsOn.length);
    for (const dep of node.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
    }
  }
  const ready = dag.nodes
    .map((n) => n.id)
    .filter((id) => indegree.get(id) === 0)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of (dependents.get(id) ?? []).sort()) {
      const left = indegree.get(next)! - 1;
      indegree.set(next, left);
      if (left === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  if (order.length !== dag.nodes.length) {
    throw new GraphError("cycle_detected", "图存在环");
  }
  return order;
}
