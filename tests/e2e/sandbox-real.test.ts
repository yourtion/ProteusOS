import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureCapabilityGenome } from "../../src/evolution/assets.ts";
import { MicrosandboxBackend } from "../../src/runtime/sandbox.ts";
import { openInstance } from "../../src/app/instance.ts";
import { installSeed } from "../../src/app/seed.ts";
import { tempInstanceRoot, upgradeJudgeToActive } from "../helpers.ts";

/**
 * 真实 microsandbox 沙箱 E2E（M3 切片①）：默认跳过。
 * 运行：PROTEUS_SANDBOX=microsandbox（需本机 msb 已安装且虚拟化可用；
 * 首次拉取 node:24-alpine 需网络/代理）。CI 仅 macos lane 设置该变量。
 * 验证：能力代码在 --no-net 的 microVM 内执行、产物经挂载回宿主、
 * 评估链路（evaluateCandidate 的 capability Run）全程真隔离。
 */

const MODE = process.env.PROTEUS_SANDBOX ?? "";

const M2 = fileURLToPath(new URL("../fixtures/m2", import.meta.url));

describe("真实 microsandbox 沙箱（PROTEUS_SANDBOX 显式启用）", () => {
  const inst = openInstance(tempInstanceRoot(), {
    capabilitySandbox: MODE === "microsandbox" ? new MicrosandboxBackend() : undefined,
  });
  afterAll(() => inst.close());

  it.runIf(MODE === "microsandbox")(
    "能力在禁网 microVM 内执行并回收产物；网络访问被拒",
    async () => {
      installSeed({
        kernel: inst.kernel,
        storage: inst.storage,
        blobs: inst.blobs,
        clock: { now: Date.now },
      });
      upgradeJudgeToActive(inst);
      const genome = ensureCapabilityGenome(
        { kernel: inst.kernel, storage: inst.storage, blobs: inst.blobs, clock: { now: Date.now } },
        {
          baseSnapshotId: inst.kernel.getOrganism("organism-default")!.activeGenomeId!,
          capabilities: [
            {
              name: "changed-file-summary",
              module: {
                kind: "capability-module-v1",
                name: "changed-file-summary",
                entry: "index.mjs",
                files: [
                  {
                    path: "index.mjs",
                    content: readFileSync(
                      join(M2, "capability", "changed-file-summary.mjs"),
                      "utf8",
                    ),
                  },
                ],
              },
            },
          ],
          createdBy: "principal-local",
        },
      );

      const summary = await inst.runtime.submitTask(
        {
          requestedBy: "principal-local",
          goal: "对变更清单生成可验证的文件分类摘要（真实沙箱）",
          inputs: [join(M2, "inputs", "changed-files.json")],
          budget: { maxAttempts: 3, maxWallClockSeconds: 180 },
          requires: ["changed-file-summary"],
          acceptance: {
            outputSchema: join(M2, "schemas", "changed-file-summary.schema.json"),
            verifier: "stats-acceptance",
          },
        },
        { purpose: "evaluation", snapshotId: genome.snapshot.id },
      );

      expect(summary.state).toBe("succeeded");
      expect(summary.checks.every((c) => c.passed)).toBe(true);

      // 直接验证禁网合同：沙箱内 fetch 必须失败
      const backend = new MicrosandboxBackend();
      const workspace = join(inst.root, "workspaces", "sandbox-probe");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(workspace, { recursive: true });
      const netProbe = backend.run({
        command: [
          "node",
          "-e",
          "fetch('https://example.com').then(() => process.exit(0), () => process.exit(3))",
        ],
        hostWorkspace: workspace,
        profile: { network: "none", memoryMb: 256, cpus: 1, timeoutMs: 60_000 },
      });
      expect(netProbe.exitCode).not.toBe(0); // 非 0 = 网络请求被沙箱拒绝（退出码取决于 node 错误路径）
      expect(netProbe.stderr).not.toContain("hello");
    },
    300_000,
  );

  it("占位：未启用时本文件保持绿", () => {
    expect(MODE === "" || MODE === "microsandbox").toBe(true);
  });
});
