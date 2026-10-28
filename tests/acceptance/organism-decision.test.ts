import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openInstance } from "../../src/app/instance.ts";
import { MIGRATIONS } from "../../src/storage/migrations.ts";
import { SqliteDb } from "../../src/storage/sqlite.ts";
import { Storage } from "../../src/storage/store.ts";
import { BlobStore, digestOf } from "../../src/storage/blobs.ts";
import { Kernel } from "../../src/kernel/index.ts";
import { canonicalJson, installSeed, SEED_ARTIFACTS } from "../../src/app/seed.ts";
import { runExperiment } from "../../src/app/experiment/runner.ts";
import { generateReport, ReportError } from "../../src/app/experiment/reporter.ts";
import { CAPABILITY_MODULE } from "../fixtures/decision/harness.ts";
import { REPO_ROOT, tempInstanceRoot } from "../helpers.ts";

/**
 * 本体决策实验验收（ADR 0007 §6/§8/§9）：
 * - Oracle 正反预检（D02 装配证明：正确→succeeded，错误→failed）
 * - E3 全数量 fake 演练：40 case × R/L × 3 = 240 trials + 报告格式（不宣称收益）
 * - D11 数据/manifest 漂移与 blob 缺失 → 复算失败
 * - D14 固定 trial 表错误/重复/缺失 → 分母正确、不静默跳过
 * - D15 旧实例迁移（v4→v5）与旧 decision.recorded 恢复
 */

const dataset = mkdtempSync(join(tmpdir(), "proteus-decision-data-"));
const PLUMBING = join(dataset, "plumbing");
const DEV = join(dataset, "dev");
cpSync(join(REPO_ROOT, "tests/fixtures/decision/plumbing"), PLUMBING, { recursive: true });
cpSync(join(REPO_ROOT, "tests/fixtures/decision/dev"), DEV, { recursive: true });

const home = tempInstanceRoot();
const out = mkdtempSync(join(tmpdir(), "proteus-exp-out-"));

afterAll(() => {
  rmSync(dataset, { recursive: true, force: true });
  // 临时实例与输出目录由系统清理
});

describe("organism-decision-v1：实验闭环（fake，不宣称收益）", () => {
  it(
    "Oracle 正反预检 + 全数量 fake 演练 + 只读报告（engineering=passed，realModel=not_run）",
    { timeout: 300_000 },
    async () => {
      const result = await runExperiment({
        home,
        datasetDir: PLUMBING,
        outDir: out,
        llm: "fake",
        arms: ["R", "L"],
        repeats: 3,
        experimentId: "exp-acceptance-plumbing",
        seed: 20260921,
        organismCallLimit: 1000,
        experimentCallLimit: 300,
        wallClockLimitMs: 10 * 60 * 1000,
        capabilityModulePath: CAPABILITY_MODULE,
        withOracle: true,
      });
      // 40 case × 2 arm × 3 repeat = 240；oracle 另跑 32×2=64 个预检 Run
      expect(result.status).toBe("complete");
      expect(result.oraclePassed).toBe(true);
      expect(result.trials).toBe(240);

      // 交付物：runner 产出 manifest/trials；reporter 只读复算产出 report.json/md
      for (const file of ["manifest.json", "trials.jsonl"]) {
        expect(existsSync(join(out, file)), file).toBe(true);
      }
      const inst2 = openInstance(home);
      let reportOutcome: ReturnType<typeof generateReport>;
      try {
        reportOutcome = generateReport({
          dir: out,
          storage: inst2.storage,
          blobs: inst2.blobs,
          datasetDir: PLUMBING,
        });
      } finally {
        inst2.close();
      }
      for (const file of ["report.json", "report.md"]) {
        expect(existsSync(join(out, file)), file).toBe(true);
      }
      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(manifest.datasetPurpose).toBe("plumbing-test");
      expect(manifest.llmConfig).toMatchObject({ llmImpl: "fake" });
      expect(manifest.bindingDiff).toMatchObject({
        ruleSnapshot: { provider: "decision-rule" },
        llmSnapshot: { provider: "decision-llm" },
      });
      // 活动快照未被实验修改（purpose=evaluation 不触碰 activeGenome）
      const inst = openInstance(home);
      try {
        const organism = inst.kernel.getOrganism("organism-default")!;
        expect(organism.activeGenomeId).toBeTruthy();
        const trials = readFileSync(join(out, "trials.jsonl"), "utf8").trim().split("\n");
        for (const line of trials.slice(0, 5)) {
          const row = JSON.parse(line) as { snapshotId?: string };
          expect(row.snapshotId).toBeUndefined(); // trial 行不携带；快照差异见 manifest
        }
      } finally {
        inst.close();
      }

      // 报告：工程结论可以给，收益不宣称（realModel=not_run → benefit 非 demonstrated）
      expect(reportOutcome.engineering).toBe("passed");
      expect(reportOutcome.realModel).toBe("not_run");
      expect(reportOutcome.benefit).not.toBe("demonstrated_on_fixture");
      const reportJson = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as {
        metrics: { denominators: { rows: number; executable: number; abstain: number } };
      };
      expect(reportJson.metrics.denominators).toMatchObject({
        rows: 240,
        executable: 32,
        abstain: 8,
      });
    },
  );
});

describe("D11：数据漂移与证据缺失 → 复算失败并指出漂移", () => {
  const report = () => {
    const inst = openInstance(home);
    try {
      return generateReport({
        dir: out,
        storage: inst.storage,
        blobs: inst.blobs,
        datasetDir: PLUMBING,
      });
    } finally {
      inst.close();
    }
  };

  it("manifest 被修改 → digest_drift 拒绝复算", () => {
    const manifestPath = join(out, "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(original) as { seed: number };
    manifest.seed = 999999; // 冻结后改门槛/种子
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    try {
      expect(() => report()).toThrow(ReportError);
      try {
        report();
      } catch (err) {
        expect(err instanceof ReportError && err.code).toBe("digest_drift");
      }
    } finally {
      writeFileSync(manifestPath, original, "utf8");
    }
  });

  it("输入包内容被修改 → 漂移显式列出，不以候选自报结论通过", () => {
    const target = join(DEV, "bundles", "b01", "file-a.md");
    const original = readFileSync(target, "utf8");
    writeFileSync(target, `${original}被篡改的内容\n`);
    try {
      expect(
        readFileSync(join(REPO_ROOT, "tests/fixtures/decision/dev/bundles/b01/file-a.md"), "utf8"),
      ).toBe(original);
      const outcome = report();
      expect(outcome.engineering).toBe("failed");
      expect(outcome.problems.some((p) => p.includes("摘要漂移"))).toBe(true);
    } finally {
      writeFileSync(target, original, "utf8");
      // 恢复后复算应回到通过（漂移可修复，但已列入记录）
      expect(report().engineering).toBe("passed");
    }
  });
});

describe("D14：固定 trial 表含错误、重复行、缺失行 → 分母正确", () => {
  const brokenOut = mkdtempSync(join(tmpdir(), "proteus-exp-broken-"));

  function prepareBrokenTrials(): void {
    cpSync(join(out, "manifest.json"), join(brokenOut, "manifest.json"));
    const lines = readFileSync(join(out, "trials.jsonl"), "utf8").trim().split("\n");
    // 删除末两行（缺失）+ 追加首行副本（重复）+ 追加损坏行
    const trimmed = lines.slice(0, -2);
    writeFileSync(
      join(brokenOut, "trials.jsonl"),
      [...trimmed, lines[0]!, "{corrupted"].join("\n") + "\n",
      "utf8",
    );
  }

  it("重复/缺失/损坏行都显式列出，engineering=failed，benefit 不为 demonstrated", () => {
    prepareBrokenTrials();
    const inst = openInstance(home);
    try {
      const outcome = generateReport({
        dir: brokenOut,
        storage: inst.storage,
        blobs: inst.blobs,
        datasetDir: PLUMBING,
      });
      expect(outcome.engineering).toBe("failed");
      expect(outcome.problems.some((p) => p.includes("重复 trial key"))).toBe(true);
      expect(outcome.problems.some((p) => p.includes("缺失 trial"))).toBe(true);
      expect(outcome.problems.some((p) => p.includes("损坏行"))).toBe(true);
      expect(outcome.benefit).not.toBe("demonstrated_on_fixture");
    } finally {
      inst.close();
    }
  });
});

describe("D15：旧实例迁移与历史 decision.recorded 恢复", () => {
  it("v4 实例迁移 v5：deadline 回填；旧 decision.recorded 作为已记录选择恢复（不重决策）", async () => {
    const root = tempInstanceRoot();
    // 只应用 v1–v4（旧 schema），装 seed 并写入旧式 run + decision.recorded
    const db = new SqliteDb(join(root, "metadata.sqlite"));
    db.migrate(MIGRATIONS.slice(0, 4));
    const blobs = new BlobStore(join(root, "blobs"), join(root, "tmp"));
    const storage = new Storage(db);
    const clock = { now: () => Date.now() };
    const kernel = new Kernel(storage, clock, {
      next: () => `legacy-${Math.random().toString(36).slice(2)}`,
    });
    // 手工写入 v4 seed：当前 installSeed/Storage 会查询和写 scope 列，旧 schema 不含该字段。
    kernel.createPrincipal("principal-local", "user");
    kernel.createLineage("lineage-seed", "principal-local", "organism:organism-default");
    kernel.createOrganism("organism-default", "principal-local", "organism:organism-default");
    const bindings: Record<string, string> = {};
    for (const artifactDef of SEED_ARTIFACTS) {
      storage.insertArtifact({
        id: artifactDef.id,
        kind: artifactDef.kind,
        lineageId: "lineage-seed",
        ownerId: "principal-local",
        createdAt: clock.now(),
      });
      const { digest, ref } = blobs.write(canonicalJson(artifactDef.content));
      const versionId = `legacy-seed-${artifactDef.id}`;
      db.run(
        `INSERT INTO artifact_versions (id, artifact_id, lineage_id, schema_version, content_digest, content_ref, parents, dependencies, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        versionId,
        artifactDef.id,
        "lineage-seed",
        1,
        digest,
        ref,
        JSON.stringify([]),
        JSON.stringify([]),
        "principal-local",
        clock.now(),
      );
      bindings[artifactDef.kind] = versionId;
    }
    // 按旧算法固定历史摘要，迁移不能用当前算法重写历史身份。
    const legacyDigest = digestOf(
      [...SEED_ARTIFACTS]
        .sort((a, b) => a.kind.localeCompare(b.kind))
        .map((def) => `${def.kind}\n${digestOf(canonicalJson(def.content))}`)
        .join("\n---\n"),
    );
    const seedSnapshot = {
      id: "legacy-seed-snapshot",
      digest: legacyDigest,
      bindings,
      createdBy: "principal-local",
      createdAt: clock.now(),
    };
    storage.insertSnapshot(seedSnapshot);
    expect(storage.setActiveGenome("organism-default", seedSnapshot.id, 0).ok).toBe(true);
    // 直接插入 v4 旧 schema 行：当前 Storage.insertTask 会写入 v5 family_id，
    // 不能用于构造尚未迁移的数据库。
    db.run(
      `INSERT INTO tasks (id, revision, requested_by, goal, inputs, budget, acceptance, requires, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "task-legacy",
      1,
      "principal-local",
      "对 fixtures/stats/input-a 下的文本文件生成统计摘要",
      JSON.stringify([join(REPO_ROOT, "tests/fixtures/stats/input-a")]),
      JSON.stringify({ maxAttempts: 3, maxWallClockSeconds: 60 }),
      JSON.stringify({
        outputSchema: join(REPO_ROOT, "tests/fixtures/stats/schemas/stats-summary.schema.json"),
        verifier: "stats-acceptance",
      }),
      JSON.stringify([]),
      clock.now(),
    );
    const createdAt = clock.now();
    db.run(
      `INSERT INTO runs (id, task_id, task_revision, organism_id, purpose, snapshot_id, graph_digest, state, supersedes_run_id, budget, failure_reason, created_at, updated_at)
       VALUES ('run-legacy', 'task-legacy', 1, 'organism-default', 'normal', ?, 'legacy', 'running', NULL, ?, NULL, ?, ?)`,
      seedSnapshot.id,
      JSON.stringify({ maxAttempts: 3, maxWallClockSeconds: 60 }),
      createdAt,
      createdAt,
    );
    storage.appendEvent({
      streamId: "run-run-legacy",
      type: "decision.recorded",
      payload: {
        nodeId: "route",
        value: "local-process",
        provider: "decision-rule",
        policyVersion: "legacy-version",
        problem: "choice",
      },
      correlationId: "run-legacy",
      runId: "run-legacy",
      organismId: "organism-default",
      occurredAt: createdAt,
    });
    storage.appendEvent({
      streamId: "run-run-legacy",
      type: "node.completed",
      payload: { nodeId: "route", type: "decision", state: "succeeded", reason: null },
      correlationId: "run-legacy",
      runId: "run-legacy",
      organismId: "organism-default",
      occurredAt: createdAt,
    });
    db.close();

    // 重开实例：v5 迁移 + deadline 回填 + 旧事件恢复执行
    const inst = openInstance(root);
    try {
      const reinstalled = installSeed({
        kernel: inst.kernel,
        storage: inst.storage,
        blobs: inst.blobs,
        clock,
      });
      expect(reinstalled).toMatchObject({
        snapshotId: seedSnapshot.id,
        snapshotDigest: legacyDigest,
        installed: false,
        revision: 1,
      });
      const run = inst.storage.getRun("run-legacy")!;
      expect(run.deadlineAt).toBe(createdAt + 60_000); // 截止点由持久化预算回填
      expect(run.experimentId).toBeNull();
      const summary = await inst.runtime.executeRun("run-legacy");
      expect(summary.state).toBe("succeeded");
      expect(summary.decisions[0]).toMatchObject({ nodeId: "route", value: "local-process" });
      // 旧记录没有决策调用账本行：恢复不新增（不存在的输入/用量证据标 unavailable，不补写）
      expect(inst.storage.listDecisionCalls("run-legacy")).toHaveLength(0);
    } finally {
      inst.close();
    }
  });
});
