import { z } from "zod";

/**
 * M0 切片① 的执行图：pipeline-v1，恰好一个 execute 节点。
 * DAG 泛化、decision/verify 节点类型在切片② 扩展（docs/runtime.md §2）。
 */
export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("execute"),
  executor: z.string().min(1),
});

export const PipelineGraphSchema = z.object({
  schemaVersion: z.number().int().min(1),
  kind: z.literal("pipeline-v1"),
  nodes: z.array(GraphNodeSchema).length(1),
});

export type PipelineGraph = z.infer<typeof PipelineGraphSchema>;

export function parseGraph(content: string): PipelineGraph {
  return PipelineGraphSchema.parse(JSON.parse(content));
}
