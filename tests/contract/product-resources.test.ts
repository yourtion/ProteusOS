import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("initializes a product copy and loads bundled resources without tests or docs", () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-product-only-"));
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  try {
    cpSync(join(repository, "src"), join(root, "src"), { recursive: true });
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
      import { resolve, join } from 'node:path';
      import { execFileSync } from 'node:child_process';
      import { Workbench } from './src/app/workbench/service.ts';
      import { openInstance } from './src/app/instance.ts';
      import { installSeed } from './src/app/seed.ts';
      import { parseCapabilityModule } from './src/runtime/capability.ts';
      const app = openInstance('./instance');
      try {
        installSeed({ ...app, clock: { now: Date.now } });
        assert.ok(app.kernel.getOrganism('organism-default'));
        assert.ok(parseCapabilityModule(JSON.parse(readFileSync('./src/resources/changed-file-summary.module.json', 'utf8'))).ok);
        const materials=resolve('./materials'); mkdirSync(materials);writeFileSync(join(materials,'note.md'),'hello');
        const task={requestedBy:'principal-local',goal:'stats',inputs:[materials],budget:{maxAttempts:1,maxWallClockSeconds:30},acceptance:{outputSchema:resolve('./src/resources/stats-summary.schema.json'),verifier:'stats-acceptance'}};
        const normal=app.runtime.admitTask(task);
        assert.equal((await app.runtime.executeRun(normal.runId)).state,'succeeded');
        const snapshotId=app.kernel.getOrganism('organism-default').activeGenomeId;
        const evaluatorVersionId=app.kernel.resolveSnapshot(snapshotId).versions.get('acceptance-evaluator').id;
        const evaluation=app.runtime.admitTask(task,{purpose:'evaluation',snapshotId,evaluatorVersionId});
        assert.equal((await app.runtime.executeRun(evaluation.runId)).state,'succeeded');
        assert.equal(app.kernel.getOrganism('organism-default').activeGenomeId,snapshotId);
      } finally { app.close(); }
      const project=resolve('./project');execFileSync('git',['init','-q',project]);
      writeFileSync(join(project,'math.mjs'),'export const value = 1;');
      const workbench=new Workbench({home:resolve('./workbench'),executorFactory:()=>({name:'fixture',recoveryPolicy:'manual',async start(req){writeFileSync(join(req.workspaceDir,'math.mjs'),'export const value = 2;');return {ok:true,exitCode:0,stdout:'updated',stderr:'',durationMs:1,outputRef:null};}})});
      try {
        const p=workbench.addProject({path:project,testCommand:[process.execPath,'--check','math.mjs']});
        const receipt=workbench.submit({projectId:p.id,goal:'update',mode:'edit',executor:'codex',timeoutSeconds:30,requestId:'product-smoke-test'});
        for(let i=0;i<200 && !['succeeded','failed'].includes(workbench.detail(receipt.runId).run?.state);i++) await new Promise(r=>setTimeout(r,20));
        assert.equal(workbench.detail(receipt.runId).run.state,'succeeded');
        workbench.apply(receipt.runId);assert.match(readFileSync(join(project,'math.mjs'),'utf8'),/value = 2/);
      } finally {await workbench.close();}
      console.log('product resources passed');
    `,
      ],
      { cwd: root, encoding: "utf8", timeout: 15000 },
    );
    expect(output).toContain("product resources passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
