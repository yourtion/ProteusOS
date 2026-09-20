import { describe, expect, it } from "vitest";
import {
  GraphError,
  normalizeDag,
  parseGraph,
  topoOrder,
  validateDag,
  type NormalizedDag,
} from "../../src/runtime/graph.ts";

function dag(nodes: object[]): NormalizedDag {
  return normalizeDag(parseGraph(JSON.stringify({ schemaVersion: 2, kind: "dag-v1", nodes })));
}

const VALID = dag([
  {
    id: "route",
    type: "decision",
    provider: "decision-rule",
    problem: "choice",
    options: ["local-process"],
    context: { nodeType: "execute" },
  },
  { id: "stats", type: "execute", executorFrom: "route", dependsOn: ["route"] },
  {
    id: "check",
    type: "verify",
    verifier: "stats-acceptance",
    inputFrom: "stats",
    dependsOn: ["stats"],
  },
]);

describe("graph：解析与归一化", () => {
  it("pipeline-v1 归一化为单节点 DAG", () => {
    const normalized = normalizeDag(
      parseGraph(
        JSON.stringify({
          schemaVersion: 1,
          kind: "pipeline-v1",
          nodes: [{ id: "stats", type: "execute", executor: "local-process" }],
        }),
      ),
    );
    expect(normalized.source).toBe("pipeline-v1");
    expect(normalized.nodes).toHaveLength(1);
    expect(normalized.nodes[0]).toMatchObject({
      id: "stats",
      type: "execute",
      executor: "local-process",
    });
  });

  it("非法内容抛 GraphError(schema)", () => {
    expect(() => parseGraph("not json")).toThrowError(GraphError);
    expect(() => parseGraph(JSON.stringify({ kind: "dag-v1" }))).toThrowError(GraphError);
  });
});

describe("graph：DAG 校验", () => {
  it("合法三节点图通过", () => {
    expect(() => validateDag(VALID)).not.toThrow();
    expect(topoOrder(VALID)).toEqual(["route", "stats", "check"]);
  });

  it("节点 ID 重复拒绝", () => {
    expect(() =>
      validateDag(
        dag([
          { id: "a", type: "execute", executor: "x", dependsOn: [] },
          { id: "a", type: "execute", executor: "x", dependsOn: [] },
        ]),
      ),
    ).toThrowError(/重复/);
  });

  it("依赖不存在拒绝", () => {
    expect(() =>
      validateDag(dag([{ id: "a", type: "execute", executor: "x", dependsOn: ["ghost"] }])),
    ).toThrowError(/ghost/);
  });

  it("环拒绝", () => {
    expect(() =>
      validateDag(
        dag([
          {
            id: "route",
            type: "decision",
            provider: "p",
            problem: "choice",
            options: ["x"],
            context: {},
            dependsOn: ["stats"],
          },
          { id: "stats", type: "execute", executorFrom: "route", dependsOn: ["route"] },
        ]),
      ),
    ).toThrowError(GraphError);
  });

  it("executor 与 executorFrom 必须二选一", () => {
    expect(() =>
      parseGraph(
        JSON.stringify({
          schemaVersion: 2,
          kind: "dag-v1",
          nodes: [{ id: "a", type: "execute", executor: "x", executorFrom: "r", dependsOn: [] }],
        }),
      ),
    ).toThrowError(GraphError);
  });

  it("executorFrom 必须指向 decision 且在依赖内", () => {
    expect(() =>
      validateDag(dag([{ id: "a", type: "execute", executorFrom: "not-decision", dependsOn: [] }])),
    ).toThrowError(/executorFrom/);

    const missingDep = dag([
      {
        id: "route",
        type: "decision",
        provider: "p",
        problem: "choice",
        options: ["x"],
        context: {},
      },
      { id: "stats", type: "execute", executorFrom: "route", dependsOn: [] },
    ]);
    expect(() => validateDag(missingDep)).toThrowError(/dependsOn/);
  });

  it("inputFrom 必须指向 execute 节点", () => {
    expect(() =>
      validateDag(
        dag([
          { id: "e", type: "execute", executor: "x", dependsOn: [] },
          { id: "v", type: "verify", verifier: "stats-acceptance", inputFrom: "v", dependsOn: [] },
        ]),
      ),
    ).toThrowError(/inputFrom/);
  });

  it("缺少 execute 节点拒绝", () => {
    expect(() =>
      validateDag(dag([{ id: "v", type: "verify", verifier: "x", inputFrom: "v", dependsOn: [] }])),
    ).toThrowError(/execute/);
  });

  it("拓扑排序确定（同层按 ID）", () => {
    const g = dag([
      { id: "b", type: "execute", executor: "x", dependsOn: [] },
      { id: "a", type: "execute", executor: "x", dependsOn: [] },
      { id: "z", type: "verify", verifier: "v", inputFrom: "a", dependsOn: ["a", "b"] },
    ]);
    expect(topoOrder(g)).toEqual(["a", "b", "z"]);
  });
});
