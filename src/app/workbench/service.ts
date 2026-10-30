import { WorkbenchStorage, type WorkbenchRecords } from "./store.ts";
import {
  executorConfiguration,
  builtinExecutor,
  executableAvailable,
  executorFromAdapter,
  type ExecutorSetup,
} from "../executor-adapter.ts";
import type { ModelAdapter } from "../../model/index.ts";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildExecutors, openInstance, resolvePackageBin } from "../instance.ts";
import { installSeed, LINEAGE_ID, ORGANISM_ID, PRINCIPAL_ID } from "../seed.ts";
import { AcpExecutor } from "../../adapters/executor-acp/index.ts";
import type { AcpPermissionPolicy } from "../../adapters/executor-acp/index.ts";
import type { ExecutionRequest, ExecutorProvider } from "../../runtime/types.ts";
import { canonicalJson } from "../../storage/blobs.ts";
import {
  GovernanceInput,
  ProjectInput,
  SubmitInput,
  type ConversationRecord,
  type TurnRecord,
  type Activity,
  type Interaction,
  type Project,
  type Work,
} from "./contracts.ts";
import {
  capture,
  changeContent,
  applyChangeSet,
  restoreChangeSet,
  changes,
  hash,
  readOutput,
  readProject,
  repository,
  runCheck,
  safePath,
  writeFiles,
} from "../../workspace/index.ts";

export interface WorkbenchOptions {
  home: string;
  modelAdapter?: ModelAdapter;
  executorAdapter?: ExecutorSetup;
  executorFactory?: (name: string, permission: AcpPermissionPolicy) => ExecutorProvider;
}
export class Workbench {
  readonly instance: import("../instance.ts").AppInstance<WorkbenchStorage>;
  readonly home: string;
  private active = new Map<string, AbortController>();
  private replies = new Map<string, (choice: string | null) => void>();
  private draining = false;
  private closing = false;
  private governanceBusy = false;
  private lock: string;
  private options: WorkbenchOptions;
  constructor(options: WorkbenchOptions) {
    this.options = {
      ...options,
      executorAdapter: executorConfiguration(options.executorAdapter),
    };
    this.home = resolve(options.home);
    mkdirSync(this.home, { recursive: true });
    this.lock = join(this.home, ".workbench.lock");
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("该实例已有工作台进程");
      unlinkSync(this.lock);
    }
    const fd = openSync(this.lock, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    try {
      this.instance = openInstance(this.home, {
        workbenchOwner: true,
        storageFactory: (db) => new WorkbenchStorage(db),
        modelAdapter: options.modelAdapter,
        executors: new Map([
          ...buildExecutors(this.options.executorAdapter),
          [
            "web-coder",
            { name: "web-coder", recoveryPolicy: "manual", start: (req) => this.execute(req) },
          ],
        ]),
      });
      installSeed({ ...this.instance, clock: { now: Date.now } });
      this.migrateConversations();
      for (const interaction of this.interactions())
        if (interaction.state === "pending")
          this.put("interaction", interaction.id, { ...interaction, state: "expired" });
      for (const work of this.works()) {
        if (work.applyState === "applying") {
          work.applyState = "needs-recovery";
          this.put("work", work.id, work);
        }
      }
    } catch (error) {
      unlinkSync(this.lock);
      throw error;
    }
  }
  private migrateConversations() {
    // Legacy IDs are deterministic, so a restart can safely repeat this migration.
    const pending = this.works().reverse();
    this.instance.storage.tx(() => {
      const visit = (work: Work, seen = new Set<string>()) => {
        if (work.conversationId && work.turnId) return;
        if (seen.has(work.id)) throw new Error("会话历史存在循环");
        seen.add(work.id);
        const parent = work.parentId ? this.work(work.parentId) : undefined;
        if (parent) visit(parent, seen);
        work.conversationId = parent?.conversationId ?? `conversation-${work.id}`;
        work.turnId = `turn-${work.id}`;
        this.saveTurn(work, parent);
        this.instance.storage.workbenchPut("work", work.id, work);
      };
      for (const work of pending) visit(work);
    });
  }
  private saveTurn(work: Work, parent?: Work) {
    if (!this.instance.storage.workbenchGet("conversation", work.conversationId))
      this.instance.storage.workbenchPut("conversation", work.conversationId, {
        id: work.conversationId,
        projectId: work.projectId,
        title: work.goal.slice(0, 100),
        createdAt: work.createdAt,
      } satisfies ConversationRecord);
    this.instance.storage.workbenchPut("turn", work.turnId, {
      id: work.turnId,
      conversationId: work.conversationId,
      parentTurnId: parent?.turnId,
      runId: work.id,
      createdAt: work.createdAt,
      contextMode: "summary",
    } satisfies TurnRecord);
  }
  conversations() {
    return this.instance.storage
      .workbenchList("conversation")
      .reverse()
      .map((conversation) => ({
        ...conversation,
        turns: this.instance.storage
          .workbenchList("turn")
          .filter((turn) => turn.conversationId === conversation.id),
      }));
  }
  async initialize() {
    for (const work of this.works()) {
      const run = this.instance.storage.getRun(work.id);
      if (run?.state === "running") await this.instance.runtime.recoverRun(work.id);
    }
    void this.drain();
  }
  private put<K extends keyof WorkbenchRecords>(kind: K, id: string, value: WorkbenchRecords[K]) {
    this.instance.storage.tx(() => this.instance.storage.workbenchPut(kind, id, value));
  }
  projects() {
    return this.instance.storage.workbenchList("project");
  }
  works() {
    return this.instance.storage.workbenchList("work").reverse();
  }
  interactions() {
    return this.instance.storage.workbenchList("interaction");
  }
  activities() {
    return this.instance.storage.workbenchList("activity");
  }
  private event(runId: string, kind: string, text: string, data?: Activity["data"]) {
    if (kind === "message" && text.length > 4000) {
      for (let offset = 0; offset < text.length; offset += 4000)
        this.event(runId, kind, text.slice(offset, offset + 4000), data);
      return;
    }
    const events = this.activities();
    const last = events.at(-1);
    if (
      kind === "message" &&
      last?.kind === kind &&
      last.runId === runId &&
      last.text.length + text.length <= 4000 &&
      Date.now() - last.at < 2000
    ) {
      this.put("activity", String(last.id), { ...last, text: last.text + text });
      return;
    }
    if (events.filter((e) => e.runId === runId).length >= 2000 && kind !== "completed") {
      const work = this.work(runId);
      this.put("work", runId, { ...work, activityDropped: (work.activityDropped ?? 0) + 1 });
      return;
    }
    const id = (events.at(-1)?.id ?? 0) + 1;
    this.put("activity", String(id), {
      id,
      runId,
      kind,
      data,
      text: text.slice(0, 4000),
      at: Date.now(),
    });
  }
  settings() {
    return {
      home: this.home,
      organism: this.instance.kernel.getOrganism(ORGANISM_ID),
      defaultExecutor: this.executorConfig().default,
      executors: this.executorConfig().enabled.map((name) => {
        const choices = this.executorConfig().choices?.[name] ?? this.customExecutor(name) ?? {};
        if (this.customExecutor(name) || name === "pi")
          return {
            name,
            installed: true,
            models: choices.models,
            reasoningEfforts: choices.reasoningEfforts,
          };
        if (name === "opencode")
          return {
            name,
            installed: executableAvailable(process.env.PROTEUS_OPENCODE_COMMAND ?? "opencode"),
            models: choices.models,
            reasoningEfforts: choices.reasoningEfforts,
          };
        try {
          this.entry(name);
          return {
            name,
            installed: true,
            models: choices.models,
            reasoningEfforts: choices.reasoningEfforts,
          };
        } catch {
          return {
            name,
            installed: false,
            models: choices.models,
            reasoningEfforts: choices.reasoningEfforts,
          };
        }
      }),
      limits: { files: 2000, bytes: 64 * 1024 * 1024 },
      candidates: this.instance.storage.listCandidates(ORGANISM_ID, 30),
      promotions: this.instance.storage.listPromotions(ORGANISM_ID, 30),
    };
  }
  private executorConfig() {
    return executorConfiguration(this.options.executorAdapter);
  }
  private customExecutor(name: string) {
    return this.executorConfig().adapters.find((a) => a.name === name);
  }
  private entry(name: string) {
    if (name !== "codex" && name !== "claude") throw new Error(`unknown_executor: ${name}`);
    return resolvePackageBin(
      name === "codex" ? "@agentclientprotocol/codex-acp" : "@agentclientprotocol/claude-agent-acp",
      name === "codex" ? "codex-acp" : "claude-agent-acp",
    );
  }
  addProject(input: unknown) {
    const parsed = ProjectInput.parse(input);
    const path = repository(parsed.path);
    readProject(path);
    const existing = this.projects().find((p) => p.path === path);
    const project: Project = {
      id: existing?.id ?? randomUUID(),
      path,
      name: parsed.name ?? basename(path),
      testCommand: parsed.testCommand,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.put("project", project.id, project);
    return project;
  }
  project(id: string) {
    const project = this.projects().find((p) => p.id === id);
    if (!project) throw new Error("项目不存在");
    return project;
  }
  work(id: string) {
    const work = this.instance.storage.workbenchGet("work", id);
    if (!work) throw new Error("任务不存在");
    return work;
  }
  list() {
    return this.works().map((work) => ({
      ...work,
      evidence: undefined,
      baseline: undefined,
      result: undefined,
      inputDir: undefined,
      run: this.instance.storage.getRun(work.id),
    }));
  }
  conversation(id: string) {
    const turns: Work[] = [];
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && turns.length < 30 && !seen.has(current)) {
      seen.add(current);
      const work = this.work(current);
      turns.unshift(work);
      current = work.parentId;
    }
    return {
      id: this.work(id).conversationId,
      contextMode: "summary" as const,
      truncated: !!current,
      turns: turns.map((work) => ({
        id: work.id,
        turnId: work.turnId,
        goal: work.goal,
        summary: work.result?.summary ?? null,
        state: this.instance.storage.getRun(work.id)?.state,
        createdAt: work.createdAt,
      })),
    };
  }
  detail(id: string) {
    const work = this.work(id);
    return {
      ...work,
      baseline: undefined,
      inputDir: undefined,
      run: this.instance.storage.getRun(id),
      conversation: this.conversation(id),
      events: this.instance.storage.listEvents({ runId: id }, 500),
      activity: this.activities().filter((e) => e.runId === id),
      interactions: this.interactions().filter((e) => e.runId === id),
      experience: this.instance.storage.getExperienceByRun(id),
    };
  }
  submit(input: unknown) {
    if (this.closing) throw new Error("Host 正在停止");
    if (this.governanceBusy) throw new Error("行为管理操作正在执行，请稍后提交");
    const parsed = SubmitInput.parse(input);
    const digest = hash(canonicalJson(parsed));
    const prior = this.instance.storage.workbenchGet("operation", parsed.requestId);
    if (prior) {
      if (prior.digest !== digest) throw new Error("请求标识已用于不同内容");
      return { runId: prior.id };
    }
    const project = this.project(parsed.projectId);
    if (!this.executorConfig().enabled.includes(parsed.executor))
      throw new Error(
        `unknown_executor: ${parsed.executor}；当前启用：${this.executorConfig().enabled.join(", ")}。请刷新工作台并重新选择执行器`,
      );
    if (!this.options.executorFactory && !this.customExecutor(parsed.executor)) {
      if (parsed.executor === "opencode") {
        if (!executableAvailable(process.env.PROTEUS_OPENCODE_COMMAND ?? "opencode"))
          throw new Error("OpenCode 未安装或命令不可执行");
      } else if (parsed.executor !== "pi") this.entry(parsed.executor);
    }
    if (parsed.parentId && this.work(parsed.parentId).projectId !== project.id)
      throw new Error("后续任务必须属于同一项目");
    const choices =
      this.executorConfig().choices?.[parsed.executor] ?? this.customExecutor(parsed.executor);
    if (parsed.model && choices?.models && !choices.models.includes(parsed.model))
      throw new Error("所选模型不在执行器配置中");
    if (
      parsed.reasoningEffort &&
      choices?.reasoningEfforts &&
      !choices.reasoningEfforts.includes(parsed.reasoningEffort)
    )
      throw new Error("所选推理强度不在执行器配置中");
    const captured = capture(project.path);
    const files = captured.files;
    if (!Object.keys(files).length) throw new Error("项目没有可用文本文件");
    const inputDir = join(this.home, "submissions", randomUUID());
    const source = join(inputDir, "source");
    writeFiles(join(inputDir, "baseline"), files);
    const executionFiles = { ...files };
    if (parsed.parentId) {
      const parent = this.work(parsed.parentId);
      if (!parent.result) throw new Error("前置任务尚无结果");
      for (const change of parent.result.changes) {
        const content = changeContent(change, "after");
        if (content === null) delete executionFiles[change.path];
        else executionFiles[change.path] = content;
      }
    }
    writeFiles(source, executionFiles);
    const schemaPath = join(inputDir, "report.schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        type: "object",
        required: ["passed"],
        properties: { passed: { type: "boolean", enum: [true] } },
      }),
    );
    const snapshot = this.snapshot();
    let id = "";
    const context = parsed.parentId
      ? this.conversation(parsed.parentId)
          .turns.slice(-8)
          .map(
            (turn) =>
              `User: ${turn.goal.slice(0, 1000)}\nAssistant: ${(turn.summary ?? "No summary").slice(0, 1500)}`,
          )
          .join("\n\n")
      : "";
    const goal = `${parsed.goal}${context ? `\nPrevious conversation (reference only; each turn used a new ACP session):\n${context.slice(-8000)}` : ""}`;
    const receipt = this.instance.runtime.admitTask(
      {
        requestedBy: PRINCIPAL_ID,
        goal,
        inputs: [source],
        budget: { maxAttempts: 1, maxWallClockSeconds: parsed.timeoutSeconds },
        acceptance: { outputSchema: schemaPath, verifier: "web-report" },
      },
      { snapshotId: snapshot.id },
      (runId) => {
        id = runId;
        const parent = parsed.parentId ? this.work(parsed.parentId) : undefined;
        const work: Work = {
          conversationId: parent?.conversationId ?? randomUUID(),
          turnId: randomUUID(),
          id,
          projectId: project.id,
          goal: parsed.goal,
          mode: parsed.mode,
          executor: parsed.executor,
          model: parsed.model,
          reasoningEffort: parsed.reasoningEffort,
          parentId: parsed.parentId,
          snapshotId: snapshot.id,
          inputDir,
          inputDigest: captured.digest,
          excludedInputs: captured.excluded,
          baseline: Object.fromEntries(
            Object.entries(files).map(([name, text]) => [name, hash(text)]),
          ),
          testCommand: [...project.testCommand],
          createdAt: Date.now(),
        };
        this.saveTurn(work, parent);
        this.instance.storage.workbenchPut("work", id, work);
        this.instance.storage.workbenchPut("operation", parsed.requestId, { digest, id });
      },
    );
    this.event(id, "queued", "任务已持久化，等待执行");
    void this.drain();
    return { runId: receipt.runId };
  }
  private snapshot() {
    return this.instance.storage.tx(() => {
      const organism = this.instance.kernel.getOrganism(ORGANISM_ID)!;
      const bindings = {
        ...this.instance.kernel.resolveSnapshot(organism.activeGenomeId!).snapshot.bindings,
      };
      for (const [slot, artifactId, content] of [
        [
          "task-graph",
          "web-graph",
          {
            schemaVersion: 2,
            kind: "dag-v1",
            nodes: [
              { id: "develop", type: "execute", executor: "web-coder", dependsOn: [] },
              {
                id: "verify",
                type: "verify",
                verifier: "web-report",
                inputFrom: "develop",
                dependsOn: ["develop"],
              },
            ],
          },
        ],
        ["acceptance-evaluator", "web-report", { schemaVersion: 1, kind: "hybrid-acceptance-v1" }],
      ] as const) {
        if (!this.instance.storage.getArtifact(artifactId))
          this.instance.storage.insertArtifact({
            id: artifactId,
            kind: slot,
            lineageId: LINEAGE_ID,
            ownerId: PRINCIPAL_ID,
            createdAt: Date.now(),
          });
        const blob = this.instance.blobs.write(canonicalJson(content));
        const version = this.instance.kernel.registerVersion({
          artifact: this.instance.storage.getArtifact(artifactId)!,
          schemaVersion: 1,
          contentDigest: blob.digest,
          contentRef: blob.ref,
          parents: [],
          dependencies: [],
          createdBy: PRINCIPAL_ID,
        });
        bindings[slot] = version.id;
      }
      return this.instance.kernel.createSnapshot(bindings, PRINCIPAL_ID);
    });
  }
  private async drain() {
    if (this.draining || this.closing) return;
    this.draining = true;
    try {
      for (const work of this.works().reverse()) {
        if (this.closing) break;
        if (this.instance.storage.getRun(work.id)?.state !== "pending") continue;
        try {
          await this.instance.runtime.executeRun(work.id);
        } catch (error) {
          const current = this.work(work.id);
          current.error = String(error);
          this.put("work", work.id, current);
          this.event(work.id, "error", String(error));
          await this.instance.runtime.recoverRun(work.id).catch(() => {});
        }
      }
    } finally {
      this.draining = false;
    }
  }
  private async execute(req: ExecutionRequest) {
    const work = this.work(req.runId);
    const controller = new AbortController();
    this.active.set(work.id, controller);
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    const cwd = join(req.workspaceDir, "project");
    const before = readOutput(join(work.inputDir, "baseline"));
    const executionBefore = readOutput(join(work.inputDir, "source"));
    writeFiles(cwd, executionBefore);
    const permission: AcpPermissionPolicy = async (params) => {
      const id = randomUUID();
      const interaction: Interaction = {
        id,
        runId: work.id,
        title: params.toolCall.title ?? "执行器请求权限",
        options: params.options.map((o) => ({ id: o.optionId, label: o.name })),
        state: "pending",
      };
      this.put("interaction", id, interaction);
      this.event(work.id, "permission", interaction.title);
      const choice = await new Promise<string | null>((resolveChoice) => {
        const finish = (value: string | null) => {
          controller.signal.removeEventListener("abort", abort);
          this.replies.delete(id);
          resolveChoice(value);
        };
        const abort = () => finish(null);
        this.replies.set(id, finish);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
      });
      this.put("interaction", id, {
        ...interaction,
        state: choice ? "answered" : "expired",
        selected: choice ?? undefined,
      });
      return choice
        ? { outcome: { outcome: "selected", optionId: choice } }
        : { outcome: { outcome: "cancelled" } };
    };
    try {
      const executor =
        (this.customExecutor(work.executor)
          ? executorFromAdapter(this.customExecutor(work.executor)!, permission)
          : undefined) ??
        this.options.executorFactory?.(work.executor, permission) ??
        (["pi", "opencode"].includes(work.executor)
          ? builtinExecutor(work.executor, permission)
          : new AcpExecutor({
              name: work.executor,
              agentEntry: this.entry(work.executor),
              permissionPolicy: permission,
              captureClaudeUsage: work.executor === "claude",
            }));
      this.event(work.id, "started", "在独立项目副本中执行");
      const prompt = `${req.prompt}\n\nWork only in the current project copy. ${work.mode === "edit" ? "Make the requested changes." : "Read/review only; do not modify project files."} Do not access the original repository or install dependencies. Write a final concise report to .proteus-summary.md. Host runs separately registered checks after completion.`;
      const result = await executor.start({
        ...req,
        model: work.model,
        reasoningEffort: work.reasoningEffort,
        workspaceDir: cwd,
        prompt,
        signal: controller.signal,
        onEvent: (event) => this.event(work.id, event.kind, event.text, event.data),
        onProgress: (progress) => {
          this.put("work", work.id, { ...this.work(work.id), progress });
          req.onProgress?.(progress);
        },
      });
      let after = readOutput(cwd);
      let diff = changes(before, after);
      const summaryFile = safePath(cwd, ".proteus-summary.md");
      const summary =
        existsSync(summaryFile) && !readFileSync(summaryFile).includes(0)
          ? readFileSync(summaryFile, "utf8").slice(0, 64000)
          : result.stdout.slice(-64000);
      let checks = { tested: false, passed: true, output: "未运行测试" };
      if (result.ok && !controller.signal.aborted && work.mode === "edit") {
        this.event(work.id, "verification", "执行项目登记的检查命令");
        checks = await runCheck(
          work.testCommand,
          cwd,
          controller.signal,
          Math.max(1, req.timeoutMs - (Date.now() - work.createdAt)),
          (text) => this.event(work.id, "test-output", text),
        );
      }
      after = readOutput(cwd);
      diff = changes(before, after);
      const passed =
        result.ok &&
        !controller.signal.aborted &&
        checks.passed &&
        (work.mode === "edit" || changes(executionBefore, after).length === 0);
      const current = this.work(work.id);
      current.evidence = result.evidence;
      current.result = { summary, changes: diff, checks, workspace: cwd };
      if (!passed)
        current.error = controller.signal.aborted
          ? "任务已请求停止"
          : result.stderr || "检查失败，或只读任务修改了文件";
      this.put("work", work.id, current);
      const outputRef = join(req.workspaceDir, "output.json");
      writeFileSync(outputRef, JSON.stringify({ passed }));
      this.event(
        work.id,
        "completed",
        passed ? "执行完成；请审阅结果" : (current.error ?? "执行未通过"),
      );
      return { ...result, outputRef };
    } finally {
      clearTimeout(timer);
      this.active.delete(work.id);
      for (const interaction of this.interactions().filter(
        (i) => i.runId === work.id && i.state === "pending",
      )) {
        this.replies.get(interaction.id)?.(null);
        this.put("interaction", interaction.id, { ...interaction, state: "expired" });
      }
    }
  }
  async cancel(id: string) {
    this.work(id);
    const result = await this.instance.runtime.cancel(id);
    this.active.get(id)?.abort();
    return result;
  }
  reply(id: string, choice: string) {
    const interaction = this.instance.storage.workbenchGet("interaction", id);
    if (!interaction || interaction.state !== "pending" || !this.replies.has(id))
      throw new Error("审批已失效");
    if (!interaction.options.some((o) => o.id === choice)) throw new Error("无效选项");
    this.replies.get(id)!(choice);
    return { accepted: true };
  }
  async reconcile(id: string) {
    this.work(id);
    return this.instance.runtime.reconcileRun(id);
  }
  apply(id: string) {
    const work = this.work(id);
    if (work.appliedAt) return { appliedAt: work.appliedAt };
    if (work.applyState === "needs-recovery" || work.applyState === "applying")
      throw new Error("应用中断，需要先恢复备份");
    if (
      work.mode !== "edit" ||
      !work.result ||
      this.instance.storage.getRun(id)?.state !== "succeeded"
    )
      throw new Error("仅可应用通过验收的修改任务");
    const root = repository(this.project(work.projectId).path);
    return applyChangeSet(root, work.baseline, work.result.changes, (state, appliedAt) => {
      work.applyState = state;
      if (appliedAt) work.appliedAt = appliedAt;
      this.put("work", id, work);
    });
  }
  restoreApplication(id: string) {
    const work = this.work(id);
    if (work.applyState !== "needs-recovery" || !work.result)
      throw new Error("没有待恢复的应用操作");
    const root = repository(this.project(work.projectId).path);
    restoreChangeSet(root, work.result.changes);
    work.applyState = "rolled-back";
    this.put("work", id, work);
    return { restored: true };
  }
  governance() {
    const { storage, kernel, evolution } = this.instance;
    return {
      organism: kernel.getOrganism(ORGANISM_ID),
      datasets: storage.listExperienceDatasets(undefined, 100, ORGANISM_ID),
      jobs: storage.listConsolidationJobs({ organismId: ORGANISM_ID }, 100),
      candidates: storage.listCandidates(ORGANISM_ID, 100).map((candidate) => ({
        ...candidate,
        status: evolution.candidateStatus(candidate.id),
        evaluations: storage.listEvaluationsByCandidate(candidate.id, 20),
      })),
      promotions: storage.listPromotions(ORGANISM_ID, 100),
    };
  }
  async govern(input: unknown) {
    const parsed = GovernanceInput.parse(input);
    const digest = hash(canonicalJson(parsed));
    const prior = this.instance.storage.workbenchGet("governance-operation", parsed.requestId);
    if (prior) {
      if (prior.digest !== digest) throw new Error("操作标识已用于其他内容");
      if (prior.state === "completed") return prior.result;
      throw new Error(prior.error ?? "操作结果待核对，不会自动重发");
    }
    if (this.instance.kernel.getOrganism(ORGANISM_ID)?.revision !== parsed.expectedRevision)
      throw new Error("版本已变化，请刷新后重新选择");
    if (this.draining || this.active.size) throw new Error("请等待代码任务结束后再操作行为版本");
    if (
      this.instance.storage
        .workbenchList("governance-operation")
        .some((op) => op.state === "running")
    )
      throw new Error("已有管理操作执行中或等待核对");
    this.put("governance-operation", parsed.requestId, { digest, state: "running" });
    this.governanceBusy = true;
    try {
      const evolution = this.instance.evolution;
      const target = parsed.target ?? "";
      let result: unknown;
      switch (parsed.action) {
        case "freeze":
          result = evolution.freezeExperienceWindow({
            purpose: "development",
            createdBy: PRINCIPAL_ID,
          });
          break;
        case "learn":
          result = evolution.submitConsolidationJob({
            datasetId: target,
            mode: "rule",
            createdBy: PRINCIPAL_ID,
            validationSetId: parsed.validationSetId || undefined,
          });
          break;
        case "run-learning":
          result = await evolution.runPendingConsolidationJobs(1);
          break;
        case "cancel-learning":
          result = evolution.cancelConsolidationJob(target);
          break;
        case "evaluate":
          result = await evolution.evaluatePolicyCandidate(target);
          break;
        case "promote":
          result = evolution.promote(target, {
            authorizedBy: PRINCIPAL_ID,
            operationId: parsed.requestId,
          });
          break;
        case "rollback":
          result = evolution.rollback({
            toSnapshotId: target,
            authorizedBy: PRINCIPAL_ID,
            operationId: parsed.requestId,
          });
          break;
      }
      this.put("governance-operation", parsed.requestId, { digest, state: "completed", result });
      return result;
    } catch (error) {
      this.put("governance-operation", parsed.requestId, {
        digest,
        state: "failed",
        error: String(error),
      });
      throw error;
    } finally {
      this.governanceBusy = false;
    }
  }
  async close() {
    this.closing = true;
    for (const id of this.active.keys()) await this.cancel(id);
    while (this.draining || this.governanceBusy) await new Promise((r) => setTimeout(r, 20));
    this.instance.close();
    unlinkSync(this.lock);
  }
}
