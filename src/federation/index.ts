import { z } from "zod";
import type { Clock, IdGen, Kernel, ArtifactVersion } from "../kernel/index.ts";
import { policyEvaluationPlanDigest, type Evolution } from "../evolution/index.ts";
import type { CandidateRecord } from "../evolution/types.ts";
import { canonicalJson, digestOf, type BlobStore } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";
import type {
  ImportRecord,
  PublicationRecord,
  ShareBundle,
  ShareEnvelope,
  SharedEvidence,
} from "./types.ts";

export type { ImportRecord, PublicationRecord, ShareBundle, ShareEnvelope } from "./types.ts";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const parentSchema = z.strictObject({ id, contentDigest: digest, lineageId: id });
const envelopeSchema = z.strictObject({
  digest,
  bundle: z.strictObject({
    format: z.literal("proteus-share-v1"),
    publicationId: id,
    teamId: id,
    scope: id,
    publisher: id,
    createdAt: z.number().int().nonnegative(),
    roots: z.array(id).min(1).max(256),
    versions: z
      .array(
        z.strictObject({
          id,
          artifactId: id,
          kind: id,
          lineageId: id,
          scope: id,
          schemaVersion: z.number().int().positive(),
          content: z.string().max(8_000_000),
          contentDigest: digest,
          dependencies: z.array(id).max(256),
          parents: z.array(parentSchema).max(256),
          withheldParentCount: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(256),
    evidence: z
      .array(
        z.strictObject({
          protocolDigest: digest,
          verdict: z.literal("eligible"),
          samples: z.number().int().min(4),
          baseSuccessRate: z.number().min(0).max(1).nullable(),
          candidateSuccessRate: z.number().min(0).max(1).nullable(),
        }),
      )
      .max(64),
  }),
});

export class FederationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Local selective exchange. Transported claims never become local evaluation or authority. */
export class Federation {
  private readonly deps: {
    kernel: Kernel;
    storage: Storage;
    blobs: BlobStore;
    evolution: Evolution;
    organismId: string;
    actorId: string;
    clock: Clock;
    ids: IdGen;
  };
  constructor(deps: Federation["deps"]) {
    this.deps = deps;
  }

  private actor(actor: string): void {
    this.deps.kernel.assertOrganismAccess(this.deps.organismId, this.deps.actorId);
    this.deps.kernel.assertOrganismAccess(this.deps.organismId, actor);
  }

  createTeam(teamId: string, opts: { createdBy: string }) {
    this.actor(opts.createdBy);
    id.parse(teamId);
    return this.deps.storage.tx(() => {
      const previous = this.deps.kernel.getPrincipal(teamId);
      if (previous) {
        if (previous.kind !== "team")
          throw new FederationError("identity_conflict", "身份已存在且不是团队");
        this.deps.kernel.assertScopeAccess(`team:${teamId}`, opts.createdBy, "manage");
        return previous;
      }
      const team = this.deps.kernel.createPrincipal(teamId, "team");
      this.deps.storage.insertAccessGrant(
        `team:${teamId}`,
        opts.createdBy,
        "manage",
        opts.createdBy,
        this.deps.clock.now(),
      );
      this.event(`team-${teamId}`, "team.created", { teamId, createdBy: opts.createdBy });
      return team;
    });
  }

  grantTeam(
    teamId: string,
    principalId: string,
    permission: "read" | "publish" | "manage",
    opts: { authorizedBy: string },
  ) {
    this.actor(opts.authorizedBy);
    if (!["read", "publish", "manage"].includes(permission))
      throw new FederationError("invalid_permission", "团队权限不合法");
    return this.deps.storage.tx(() => {
      this.deps.kernel.grantAccess(`team:${teamId}`, principalId, permission, opts.authorizedBy);
      this.event(`team-${teamId}`, "team.access.granted", {
        teamId,
        principalId,
        permission,
        authorizedBy: opts.authorizedBy,
      });
      return { teamId, principalId, permission };
    });
  }

  fork(opts: { versionIds: string[]; scope: string; createdBy: string }): {
    lineageId: string;
    versions: Record<string, string>;
  } {
    this.actor(opts.createdBy);
    if (!opts.versionIds.length || new Set(opts.versionIds).size !== opts.versionIds.length)
      throw new FederationError("invalid_versions", "明确选择不重复的 fork 版本");
    if (
      opts.scope !== "public" &&
      opts.scope !== `organism:${this.deps.organismId}` &&
      !opts.scope.startsWith("team:")
    )
      throw new FederationError("invalid_scope", "fork 目标须为 public、当前个体或团队");
    if (opts.scope.startsWith("team:"))
      this.deps.kernel.assertScopeAccess(opts.scope, opts.createdBy, "publish");
    const selected = new Set(opts.versionIds);
    const sources = opts.versionIds.map((v) => this.version(v, opts.createdBy));
    for (const source of sources)
      for (const dependencyId of source.dependencies) {
        const dependency = this.version(dependencyId, opts.createdBy);
        if (!selected.has(dependencyId) && !this.shareable(dependency.scope, opts.scope))
          throw new FederationError(
            "private_dependency",
            "fork 包含未明确选择的私有依赖；须逐项选择或保留可访问的依赖",
          );
      }
    return this.deps.storage.tx(() => {
      const lineageId = this.deps.ids.next();
      this.deps.kernel.createLineage(
        lineageId,
        opts.scope.startsWith("team:") ? opts.scope.slice(5) : opts.createdBy,
        opts.scope,
      );
      const versions: Record<string, string> = {};
      const pending = [...sources];
      while (pending.length) {
        const index = pending.findIndex((v) =>
          v.dependencies.every((d) => !selected.has(d) || versions[d]),
        );
        if (index < 0) throw new FederationError("dependency_cycle", "fork 依赖形成环");
        const source = pending.splice(index, 1)[0]!;
        const artifact = {
          id: this.deps.ids.next(),
          kind: this.deps.storage.getArtifact(source.artifactId)!.kind,
          lineageId,
          ownerId: opts.scope.startsWith("team:") ? opts.scope.slice(5) : opts.createdBy,
          createdAt: this.deps.clock.now(),
        };
        this.deps.storage.insertArtifact(artifact);
        versions[source.id] = this.deps.kernel.registerVersion({
          artifact,
          schemaVersion: source.schemaVersion,
          contentDigest: source.contentDigest,
          contentRef: source.contentRef,
          parents: [source.id],
          dependencies: source.dependencies.map((d) => versions[d] ?? d),
          scope: opts.scope,
          createdBy: opts.createdBy,
        }).id;
      }
      this.event(`lineage-${lineageId}`, "versions.forked", {
        lineageId,
        scope: opts.scope,
        versions,
        createdBy: opts.createdBy,
      });
      return { lineageId, versions };
    });
  }

  publish(opts: {
    teamId: string;
    versionIds: string[];
    scope: string;
    evidenceRefs?: string[];
    createdBy: string;
  }): PublicationRecord {
    this.actor(opts.createdBy);
    this.deps.kernel.assertScopeAccess(`team:${opts.teamId}`, opts.createdBy, "publish");
    if (opts.scope !== "public" && opts.scope !== `team:${opts.teamId}`)
      throw new FederationError("invalid_scope", "发布 scope 必须为 public 或发布团队");
    if (!opts.versionIds.length || new Set(opts.versionIds).size !== opts.versionIds.length)
      throw new FederationError("invalid_versions", "发布必须明确选择精确版本且不得重复");
    const closure = new Map<string, ArtifactVersion>();
    const pending = [...opts.versionIds];
    while (pending.length) {
      const versionId = pending.pop()!;
      if (closure.has(versionId)) continue;
      const version = this.version(versionId, opts.createdBy);
      if (!this.shareable(version.scope, opts.scope))
        throw new FederationError("private_dependency", "发布根版本或依赖不允许在目标 scope 分享");
      if (!heritableKind(this.deps.storage.getArtifact(version.artifactId)!.kind))
        throw new FederationError("unshareable_kind", "此类型不属于可共享行为产物");
      if (digestOf(this.deps.blobs.read(version.contentRef)) !== version.contentDigest)
        throw new FederationError("content_drift", "版本 blob 缺失或摘要漂移");
      closure.set(version.id, version);
      pending.push(...version.dependencies);
    }
    const evidence = (opts.evidenceRefs ?? []).map((ref) =>
      this.summarizeEvidence(ref, [...closure.values()]),
    );
    const publicationId = this.deps.ids.next();
    const bundle: ShareBundle = {
      format: "proteus-share-v1",
      publicationId,
      teamId: opts.teamId,
      scope: opts.scope,
      publisher: opts.createdBy,
      createdAt: this.deps.clock.now(),
      roots: [...opts.versionIds].sort(),
      versions: [...closure.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((v) => {
          const visibleParents = v.parents
            .map((p) => this.deps.storage.getArtifactVersion(p))
            .filter((p): p is ArtifactVersion => !!p && this.shareable(p.scope, opts.scope));
          return {
            id: v.id,
            artifactId: v.artifactId,
            kind: this.deps.storage.getArtifact(v.artifactId)!.kind,
            lineageId: v.lineageId,
            scope: v.scope!,
            schemaVersion: v.schemaVersion,
            content: this.deps.blobs.read(v.contentRef),
            contentDigest: v.contentDigest,
            dependencies: [...v.dependencies],
            parents: visibleParents.map((p) => ({
              id: p.id,
              contentDigest: p.contentDigest,
              lineageId: p.lineageId,
            })),
            withheldParentCount: v.parents.length - visibleParents.length,
          };
        }),
      evidence,
    };
    const encoded = canonicalJson(bundle);
    const { digest: bundleDigest, ref: bundleRef } = this.deps.blobs.write(encoded);
    envelopeSchema.parse({ digest: bundleDigest, bundle });
    return this.deps.storage.tx(() => {
      const publication: PublicationRecord = {
        id: publicationId,
        teamId: opts.teamId,
        scope: opts.scope,
        bundleDigest,
        bundleRef,
        versionIds: [...opts.versionIds],
        createdBy: opts.createdBy,
        createdAt: bundle.createdAt,
      };
      this.deps.storage.insertPublication(publication);
      this.event(`publication-${publicationId}`, "versions.published", {
        publicationId,
        bundleDigest,
        scope: opts.scope,
        selectedEvidence: opts.evidenceRefs ?? [],
      });
      return publication;
    });
  }

  exportPublication(publicationId: string, actor: string): ShareEnvelope {
    this.actor(actor);
    const publication = this.deps.storage.getPublication(publicationId);
    if (!publication) throw new FederationError("unknown_publication", "发布记录不存在");
    this.deps.kernel.assertScopeAccess(publication.scope, actor, "read");
    const bundle = JSON.parse(this.deps.blobs.read(publication.bundleRef)) as ShareBundle;
    if (digestOf(canonicalJson(bundle)) !== publication.bundleDigest)
      throw new FederationError("content_drift", "发布包损坏");
    return { digest: publication.bundleDigest, bundle };
  }

  importBundle(input: unknown, opts: { createdBy: string }): ImportRecord {
    this.actor(opts.createdBy);
    const envelope = envelopeSchema.parse(input);
    if (canonicalJson(envelope).length > 16_000_000)
      throw new FederationError("bundle_too_large", "分享包超出导入预算");
    if (digestOf(canonicalJson(envelope.bundle)) !== envelope.digest)
      throw new FederationError("bundle_digest_mismatch", "分享包摘要不符");
    const bundle = envelope.bundle;
    if (bundle.scope !== "public" && bundle.scope !== `team:${bundle.teamId}`)
      throw new FederationError("invalid_scope", "分享包 scope 与团队不一致");
    if (bundle.scope !== "public")
      this.deps.kernel.assertScopeAccess(bundle.scope, opts.createdBy, "read");
    const sourceVersions = new Map(bundle.versions.map((v) => [v.id, v]));
    if (
      sourceVersions.size !== bundle.versions.length ||
      new Set(bundle.roots).size !== bundle.roots.length ||
      bundle.roots.some((v) => !sourceVersions.has(v))
    )
      throw new FederationError("invalid_bundle", "重复版本或根版本缺失");
    for (const v of sourceVersions.values()) {
      if (!heritableKind(v.kind) || !this.shareable(v.scope, bundle.scope))
        throw new FederationError("private_dependency", "外部版本类型或 scope 不允许分享");
      if (
        digestOf(v.content) !== v.contentDigest ||
        v.dependencies.some((d) => !sourceVersions.has(d))
      )
        throw new FederationError("invalid_bundle", "内容摘要不符或依赖闭包缺失");
    }
    return this.deps.storage.tx(() => {
      const previous = this.deps.storage.findSharedImport(this.deps.organismId, envelope.digest);
      if (previous) return previous;
      const importId = this.deps.ids.next();
      const lineageId = this.deps.ids.next();
      this.deps.kernel.createLineage(lineageId, opts.createdBy, `organism:${this.deps.organismId}`);
      for (const v of sourceVersions.values()) {
        this.deps.storage.insertExternalVersionRef({
          id: v.id,
          contentDigest: v.contentDigest,
          lineageId: v.lineageId,
          publicationDigest: envelope.digest,
        });
        for (const parent of v.parents)
          this.deps.storage.insertExternalVersionRef({
            ...parent,
            publicationDigest: envelope.digest,
          });
      }
      const versions: Record<string, string> = {};
      const pending = [...sourceVersions.values()];
      while (pending.length) {
        const index = pending.findIndex((v) => v.dependencies.every((d) => versions[d]));
        if (index < 0) throw new FederationError("dependency_cycle", "外部依赖形成环");
        const v = pending.splice(index, 1)[0]!;
        const artifact = {
          id: this.deps.ids.next(),
          kind: v.kind,
          lineageId,
          ownerId: opts.createdBy,
          createdAt: this.deps.clock.now(),
        };
        this.deps.storage.insertArtifact(artifact);
        const { ref } = this.deps.blobs.write(v.content);
        versions[v.id] = this.deps.kernel.registerVersion({
          artifact,
          schemaVersion: v.schemaVersion,
          contentDigest: v.contentDigest,
          contentRef: ref,
          parents: [v.id],
          dependencies: v.dependencies.map((d) => versions[d]!),
          scope: `organism:${this.deps.organismId}`,
          createdBy: opts.createdBy,
        }).id;
      }
      const imported: ImportRecord = {
        bundleRef: this.deps.blobs.write(canonicalJson(bundle)).ref,
        id: importId,
        organismId: this.deps.organismId,
        bundleDigest: envelope.digest,
        publicationId: bundle.publicationId,
        versions,
        rootVersionIds: bundle.roots.map((v) => versions[v]!),
        state: "imported",
        createdBy: opts.createdBy,
        createdAt: this.deps.clock.now(),
      };
      this.deps.storage.insertSharedImport(imported);
      this.event(`import-${importId}`, "versions.imported", {
        importId,
        bundleDigest: envelope.digest,
        publicationId: bundle.publicationId,
        versions,
        evidenceStatus: "external-claim",
      });
      return imported;
    });
  }

  inherit(
    importId: string,
    opts: {
      validationSetId: string;
      versionIds?: string[];
      createdBy: string;
      hypothesis?: string;
    },
  ): CandidateRecord {
    this.actor(opts.createdBy);
    return this.deps.storage.tx(() => {
      const imported = this.ownedImport(importId);
      if (imported.state === "rejected")
        throw new FederationError("import_rejected", "已拒绝的版本不能继续继承");
      const organism = this.deps.kernel.getOrganism(this.deps.organismId)!;
      if (!organism.activeGenomeId)
        throw new FederationError("no_active_genome", "先安装本地 seed");
      const { snapshot: base, versions: baseVersions } = this.deps.kernel.resolveSnapshot(
        organism.activeGenomeId,
      );
      const set = this.deps.evolution.validationSet(opts.validationSetId);
      if (
        !set.planRef ||
        !set.planDigest ||
        set.state !== "ready" ||
        set.usageCount !== 0 ||
        set.candidateId
      )
        throw new FederationError(
          "validation_set_exhausted",
          "候选创建前须准备未使用的本地验证计划",
        );
      const plan = JSON.parse(this.deps.blobs.read(set.planRef));
      if (policyEvaluationPlanDigest(plan) !== set.planDigest)
        throw new FederationError("evaluation_plan_drift", "固定验证方案内容漂移");
      const bindings = { ...base.bindings };
      const slots = new Set<string>();
      const selection = opts.versionIds ?? imported.rootVersionIds;
      if (!selection.length || selection.some((v) => !Object.values(imported.versions).includes(v)))
        throw new FederationError("invalid_selection", "只允许选择当前导入记录中的精确版本");
      for (const versionId of selection) {
        const v = this.version(versionId, opts.createdBy);
        const kind = this.deps.storage.getArtifact(v.artifactId)!.kind;
        if (slots.has(kind))
          throw new FederationError("duplicate_slot", "同一槽位不能继承多个版本");
        slots.add(kind);
        if (kind === "acceptance-evaluator") {
          if (v.contentDigest !== baseVersions.get(kind)?.contentDigest)
            throw new FederationError(
              "judge_change_requires_separate_candidate",
              "裁判升级须独立候选，不能由共享版本自行放行",
            );
          continue;
        }
        bindings[kind] = versionId;
      }
      const snapshot = this.deps.kernel.createSnapshot(bindings, opts.createdBy);
      const candidate: CandidateRecord = {
        id: this.deps.ids.next(),
        organismId: this.deps.organismId,
        baseSnapshotId: base.id,
        baseRevision: organism.revision,
        proposedSnapshotId: snapshot.id,
        hypothesis: opts.hypothesis ?? "对共享版本在本地固定任务与权限下进行独立验证",
        proposedBy: opts.createdBy,
        sourceRefs: {
          candidateType: "inheritance",
          importId,
          publicationDigest: imported.bundleDigest,
          validationSetId: set.id,
          policyEvaluationPlanDigest: set.planDigest,
          evaluatorVersionId: base.bindings["acceptance-evaluator"]!,
        },
        datasetRef: null,
        createdAt: this.deps.clock.now(),
      };
      this.deps.storage.insertCandidate(candidate);
      this.deps.storage.updateValidationSet(set.id, {
        candidateId: candidate.id,
        updatedAt: candidate.createdAt,
      });
      this.event(`candidate-${candidate.id}`, "candidate.proposed", {
        candidateId: candidate.id,
        candidateType: "inheritance",
        importId,
        publicationDigest: imported.bundleDigest,
        baseSnapshotId: base.id,
        baseRevision: organism.revision,
        proposedSnapshotId: snapshot.id,
      });
      return candidate;
    });
  }

  rejectImport(importId: string, opts: { createdBy: string; note?: string }): ImportRecord {
    this.actor(opts.createdBy);
    return this.deps.storage.tx(() => {
      const imported = this.ownedImport(importId);
      if (this.deps.storage.hasAdoptedImport(importId, this.deps.organismId))
        throw new FederationError(
          "import_already_adopted",
          "已采用的版本须显式回滚，拒绝不会撤销采用",
        );
      this.deps.storage.rejectSharedImport(importId);
      this.event(`import-${importId}`, "versions.rejected", {
        importId,
        createdBy: opts.createdBy,
        note: opts.note ?? null,
      });
      return { ...imported, state: "rejected" };
    });
  }

  private ownedImport(id: string): ImportRecord {
    const imported = this.deps.storage.getSharedImport(id);
    if (!imported || imported.organismId !== this.deps.organismId)
      throw new FederationError("forbidden", "导入不存在或属于其他个体");
    return imported;
  }

  importRecord(id: string): ImportRecord {
    this.actor(this.deps.actorId);
    return this.ownedImport(id);
  }

  private summarizeEvidence(ref: string, publishedVersions: ArtifactVersion[]): SharedEvidence {
    const evaluation = this.deps.storage.getEvaluation(ref);
    const candidate = evaluation
      ? this.deps.storage.getCandidate(evaluation.candidateId)
      : undefined;
    if (
      !evaluation ||
      !candidate ||
      candidate.organismId !== this.deps.organismId ||
      evaluation.verdict !== "eligible" ||
      evaluation.runs.length < 4
    )
      throw new FederationError(
        "unshareable_evidence",
        "只允许明确选择本个体通过评估且样本足够的数字汇总证据",
      );
    const evaluatedSnapshot = this.deps.kernel.getSnapshot(candidate.proposedSnapshotId)!;
    const evaluatedVersions = [
      ...this.deps.kernel.resolveVersionClosure(Object.values(evaluatedSnapshot.bindings)).values(),
    ];
    if (
      publishedVersions.some(
        (published) =>
          !evaluatedVersions.some(
            (evaluated) =>
              evaluated.contentDigest === published.contentDigest &&
              evaluated.schemaVersion === published.schemaVersion &&
              this.deps.storage.getArtifact(evaluated.artifactId)?.kind ===
                this.deps.storage.getArtifact(published.artifactId)?.kind,
          ),
      )
    )
      throw new FederationError("evidence_mismatch", "评估未验证此次发布的版本内容或依赖");
    return {
      protocolDigest: evaluation.protocolDigest,
      verdict: "eligible",
      samples: evaluation.runs.length,
      baseSuccessRate: evaluation.policy?.base.successRate ?? null,
      candidateSuccessRate: evaluation.policy?.candidate.successRate ?? null,
    };
  }

  private version(id: string, actor: string): ArtifactVersion {
    this.deps.kernel.assertVersionAccess(id, actor);
    return this.deps.storage.getArtifactVersion(id)!;
  }

  private shareable(scope: string | undefined, target: string): boolean {
    return scope === "public" || (target !== "public" && scope === target);
  }

  private event(streamId: string, type: string, payload: Record<string, unknown>): void {
    this.deps.storage.appendEvent({
      streamId,
      type,
      payload,
      organismId: this.deps.organismId,
      occurredAt: this.deps.clock.now(),
    });
  }
}

function heritableKind(kind: string): boolean {
  return (
    ["task-graph", "routing-policy", "acceptance-evaluator", "decision-view"].includes(kind) ||
    /^capability\/[a-z][a-z0-9-]*$/.test(kind)
  );
}
