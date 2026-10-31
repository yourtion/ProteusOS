import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
/** Real browser workflow. Set PROTEUS_PLAYWRIGHT_MODULE to a Playwright module URL if not installed locally. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const { chromium } = await import(process.env.PROTEUS_PLAYWRIGHT_MODULE ?? "playwright");
const root = resolve(process.argv[2]);
const fixture = JSON.parse(readFileSync(join(root, "validation.json"), "utf8"));
const browser = await chromium.launch({
  channel: process.env.PROTEUS_BROWSER_CHANNEL,
  headless: true,
});
let restarted;
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
process.once("SIGTERM", () => browser.close().finally(() => process.exit(1)));
const errors = [];
const failures = [];
const phases = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("PAGE_ERROR", e.message);
});
page.on("response", (r) => {
  if (r.status() >= 400) failures.push({ status: r.status(), path: new URL(r.url()).pathname });
});
const output = join(root, "screenshots");
mkdirSync(output, { recursive: true });
const phase = async (name) => {
  phases.push(name);
  console.log("PASS", name);
  await page.screenshot({
    path: join(output, `${String(phases.length).padStart(2, "0")}-${name}.png`),
    fullPage: true,
  });
};
try {
  await page.goto(readFileSync(join(root, "url.txt"), "utf8"));
  await page.getByRole("heading", { name: "今天，想一起做点什么？", exact: true }).waitFor();
  await phase("clean-login");
  if (await page.getByRole("button", { name: "添加第一个项目 ↗", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "添加第一个项目 ↗", exact: true }).click();
    await page.getByLabel("项目名称", { exact: true }).fill("Browser acceptance");
    await page.getByLabel("Git 仓库绝对路径", { exact: true }).fill(fixture.project);
    await page
      .getByLabel("测试命令参数 JSON", { exact: true })
      .fill(JSON.stringify([fixture.node, "check.mjs"]));
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "任务需求", exact: true }).waitFor();
  await page
    .getByRole("combobox", { name: "执行器", exact: true })
    .locator("option")
    .last()
    .waitFor({ state: "attached" });
  assert.deepEqual(
    await page
      .getByRole("combobox", { name: "执行器", exact: true })
      .locator("option")
      .allTextContents(),
    ["traex", "opencode-w"],
  );
  assert.equal(
    await page.getByRole("combobox", { name: "执行器", exact: true }).inputValue(),
    "traex",
  );
  await phase("project-and-executors");
  await page.getByRole("textbox", { name: "任务需求", exact: true }).fill("EDIT 修复加法");
  await page.getByLabel("模型", { exact: true }).fill("alternate-model");
  await page.getByLabel("推理强度", { exact: true }).fill("high");
  await page.getByRole("button", { name: "开始任务 ↗", exact: true }).click();
  await page.getByRole("heading", { name: "需要你的处理", exact: true }).waitFor();
  await phase("task-permission");
  await page.getByRole("button", { name: "允许修改", exact: true }).click();
  await page.getByText("自动检查通过", { exact: true }).waitFor();
  assert.match(await page.locator(".conversation-thread").innerText(), /alternate-model.*high/);
  assert.match(readFileSync(join(fixture.project, "math.mjs"), "utf8"), /a-b/);
  await phase("task-completed");
  await page.getByRole("button", { name: "M math.mjs", exact: true }).click();
  await page.locator(".diff .before").waitFor();
  assert.match(await page.locator(".diff .before").innerText(), /a-b/);
  assert.match(await page.locator(".diff .after").innerText(), /a\+b/);
  assert.equal(errors.length, 0);
  await phase("diff-view");
  await page.getByRole("button", { name: "检查", exact: true }).click();
  await page.getByRole("heading", { name: "独立检查", exact: true }).waitFor();
  await phase("checks-view");
  await page.getByRole("button", { name: "变更", exact: true }).click();
  await page.getByRole("button", { name: "应用到原项目", exact: true }).click();
  await page.getByRole("button", { name: "确认应用", exact: true }).click();
  await page.getByRole("button", { name: "已应用到项目", exact: true }).waitFor();
  assert.match(readFileSync(join(fixture.project, "math.mjs"), "utf8"), /a\+b/);
  await phase("apply-changes");

  for (const tab of ["工具", "Trace", "用量", "证据"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await phase("inspector-" + tab);
  }
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载结果与证据 JSON", exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(join(root, "exported-evidence.json"));
  assert.equal(
    JSON.parse(readFileSync(join(root, "exported-evidence.json"), "utf8")).executor,
    "traex",
  );
  await phase("evidence-export");
  await page.reload();
  await page.getByText("自动检查通过", { exact: true }).waitFor();
  await phase("reload-selected-task");
  await page.getByRole("button", { name: "补充需求", exact: true }).click();
  await page.getByRole("textbox", { name: "任务需求", exact: true }).fill("READ 解释修复后的加法");
  await page.getByRole("combobox", { name: "任务类型", exact: true }).selectOption("read");
  await page.getByRole("button", { name: "开始任务 ↗", exact: true }).click();
  await page.getByText("本次未运行自动测试；执行完成不代表代码正确。", { exact: true }).waitFor();
  assert.ok((await page.locator(".history-turn").count()) >= 1);
  await phase("read-follow-up");
  await page.getByRole("button", { name: "＋ 新任务", exact: true }).click();
  await page.getByRole("combobox", { name: "执行器", exact: true }).selectOption("opencode-w");
  assert.equal(await page.getByLabel("模型", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("推理强度", { exact: true }).inputValue(), "");
  await page.getByRole("textbox", { name: "任务需求", exact: true }).fill("FAIL 测试执行器失败");
  await page.getByRole("button", { name: "开始任务 ↗", exact: true }).click();
  await page.locator(".toolbar .badge").filter({ hasText: "失败" }).waitFor();
  await phase("executor-failure");
  await page.getByRole("button", { name: "＋ 新任务", exact: true }).click();
  await page.getByRole("combobox", { name: "执行器", exact: true }).selectOption("traex");
  await page.getByRole("textbox", { name: "任务需求", exact: true }).fill("SLOW 测试取消");
  await page.getByRole("button", { name: "开始任务 ↗", exact: true }).click();
  await page.getByRole("button", { name: "请求停止", exact: true }).click();
  await page.locator(".toolbar .badge").filter({ hasText: "已停止" }).waitFor();
  await phase("cancel-task");
  await page.getByRole("button", { name: "＋ 新任务", exact: true }).click();
  await page.getByRole("combobox", { name: "任务类型", exact: true }).selectOption("edit");
  await page.getByRole("textbox", { name: "任务需求", exact: true }).fill("EDIT 测试拒绝权限");
  await page.getByRole("button", { name: "开始任务 ↗", exact: true }).click();
  await page.getByRole("button", { name: "拒绝修改", exact: true }).click();
  await page.locator(".toolbar .badge").filter({ hasText: "失败" }).waitFor();
  await phase("deny-permission");
  await page.getByRole("button", { name: "＋ 新任务", exact: true }).click();
  await page.getByRole("textbox", { name: "任务需求", exact: true }).fill("EDIT 测试非法模型");
  await page.getByLabel("模型", { exact: true }).fill("not-a-configured-model");
  await page.getByRole("button", { name: "开始任务 ↗", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "所选模型不在执行器配置中" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "查询或重试同一提交", exact: true }).count(),
    0,
  );
  await phase("invalid-model-no-retry");
  await page.getByLabel("模型", { exact: true }).fill("fixture-model");
  await page
    .getByRole("textbox", { name: "任务需求", exact: true })
    .fill("BUGGY 检查失败不会允许应用");
  await page.getByRole("button", { name: "开始任务 ↗", exact: true }).click();
  await page.getByRole("button", { name: "允许修改", exact: true }).click();
  await page.getByText("自动检查失败", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "应用到原项目", exact: true }).count(), 0);
  await phase("failed-check-no-apply");

  await page.getByRole("button", { name: "＋ 新任务", exact: true }).click();
  await page.getByRole("textbox", { name: "任务需求", exact: true }).fill("BINARY 修改二进制资源");
  await page.getByRole("button", { name: "开始任务 ↗", exact: true }).click();
  await page.getByRole("button", { name: "允许修改", exact: true }).click();
  await page.getByText("自动检查通过", { exact: true }).waitFor();
  await page.getByRole("button", { name: "M asset.bin", exact: true }).click();
  assert.match(await page.locator(".diff .before").innerText(), /文件：4 bytes.*SHA-256/);
  assert.match(await page.locator(".diff .after").innerText(), /文件：4 bytes.*SHA-256/);
  await page.getByRole("button", { name: "应用到原项目", exact: true }).click();
  await page.getByRole("button", { name: "确认应用", exact: true }).click();
  await page.getByRole("button", { name: "已应用到项目", exact: true }).waitFor();
  assert.deepEqual([...readFileSync(join(fixture.project, "asset.bin"))], [0, 4, 5, 6]);
  await phase("binary-diff");
  await page.getByRole("button", { name: "助手与设置", exact: true }).click();
  await page.getByRole("heading", { name: "运行环境与版本", exact: true }).waitFor();
  assert.match(await page.locator("main").innerText(), /traex/);
  await phase("settings-page");
  await page.getByRole("button", { name: "经验与行为版本", exact: true }).click();
  await page.getByRole("heading", { name: "经验与行为版本", exact: true }).waitFor();
  await page.getByRole("button", { name: "冻结许可经验", exact: true }).click();
  await page.getByRole("button", { name: "确认执行", exact: true }).waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await phase("governance-confirm-cancel");

  await page.getByRole("button", { name: "冻结许可经验", exact: true }).click();
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  await page.getByText("最近操作回执", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "开发数据集", exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "提交学习", exact: true }).click();
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  const queued = page
    .locator("summary")
    .filter({ hasText: / · queued/ })
    .first();
  await queued.waitFor();
  await queued.click();
  await page.getByRole("button", { name: "取消作业", exact: true }).click();
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: / · cancelled/ })
    .first()
    .waitFor();
  await phase("governance-freeze-submit-cancel");
  await page.getByRole("button", { name: "项目与检查配置", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("Second project");
  await page.getByLabel("Git 仓库绝对路径", { exact: true }).fill(fixture.secondProject);
  await page.getByLabel("测试命令参数 JSON", { exact: true }).fill("[]");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await page
    .getByRole("combobox", { name: "当前项目", exact: true })
    .selectOption({ label: "Browser acceptance" });
  await page.getByRole("button").filter({ hasText: "BINARY 修改二进制资源" }).click();
  await page.getByRole("button", { name: "补充需求", exact: true }).click();
  await page.getByText(/基于任务/).waitFor();
  await page
    .getByRole("combobox", { name: "当前项目", exact: true })
    .selectOption({ label: "Second project" });
  assert.equal(
    await page.getByText(/基于任务/).count(),
    0,
    "switching projects must clear follow-up context",
  );
  await phase("switch-project-follow-up");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "展开或收起项目与任务", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新任务", exact: true }).click();
  await page.getByRole("textbox", { name: "任务需求", exact: true }).waitFor();
  assert.ok(await page.locator("body").evaluate((el) => el.scrollWidth <= innerWidth + 1));
  await phase("mobile-new-task");

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page
    .getByRole("combobox", { name: "当前项目", exact: true })
    .selectOption({ label: "Browser acceptance" });
  await page
    .getByRole("textbox", { name: "任务需求", exact: true })
    .fill("EDIT RETRY 丢失响应后重试");
  let drop = true;
  await page.route("**/api/runs", async (route) => {
    if (drop && route.request().method() === "POST") {
      drop = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "开始任务 ↗", exact: true }).click();
  await page.getByRole("button", { name: "查询或重试同一提交", exact: true }).waitFor();
  await page.getByRole("button", { name: "查询或重试同一提交", exact: true }).click();
  await page.getByRole("button", { name: "允许修改", exact: true }).click();
  await page.getByText("自动检查通过", { exact: true }).waitFor();
  assert.equal(
    await page.locator("nav button").filter({ hasText: "EDIT RETRY 丢失响应后重试" }).count(),
    1,
  );
  await page.unroute("**/api/runs");
  await phase("lost-response-idempotent-retry");

  const authenticatedUrl = readFileSync(join(root, "url.txt"), "utf8");
  await page.goto(authenticatedUrl.split("#")[0] + "#invalid-test-token");
  await page.getByRole("alert").filter({ hasText: "启动凭据失效" }).waitFor();
  await page.getByRole("heading", { name: "连接本地助手", exact: true }).waitFor();
  assert.equal(await page.getByText("自动检查通过", { exact: true }).count(), 0);
  await phase("reauthentication-hides-stale-task");
  await page.goto(authenticatedUrl);
  await page.getByText("自动检查通过", { exact: true }).waitFor();
  await page.getByText("● 已连接", { exact: true }).waitFor();
  const original = readFileSync(join(fixture.project, "math.mjs"), "utf8");
  writeFileSync(join(fixture.project, "math.mjs"), "// user changed original\n" + original);
  await page.getByRole("button", { name: "变更", exact: true }).click();
  await page.getByRole("button", { name: "应用到原项目", exact: true }).click();
  await page.getByRole("button", { name: "确认应用", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "项目已变化" }).waitFor();
  assert.match(readFileSync(join(fixture.project, "math.mjs"), "utf8"), /^\/\/ user changed/);
  writeFileSync(join(fixture.project, "math.mjs"), original);
  await phase("apply-conflict-preserves-original");
  const selected = await page.evaluate(() => sessionStorage.getItem("proteus-selected-run"));
  const metadata = JSON.parse(readFileSync(join(root, "validation.json"), "utf8"));
  process.kill(metadata.pid, "SIGTERM");
  for (let i = 0; i < 200; i++) {
    if (!existsSync(join(root, "instance", ".workbench.lock"))) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(existsSync(join(root, "instance", ".workbench.lock")), false);
  restarted = spawn(
    process.execPath,
    [fileURLToPath(new URL("../fixtures/web/clean-workbench.mjs", import.meta.url)), root],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const restartedUrl = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("restart timeout")), 20000);
    restarted.stdout.on("data", (chunk) => {
      text += String(chunk);
      if (text.includes("Proteus 工作台：")) {
        clearTimeout(timer);
        const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]+/);
        resolve(match?.[0]);
      }
    });
    restarted.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("restart failed"));
    });
  });
  await page.goto(restartedUrl);
  await page.getByText("自动检查通过", { exact: true }).waitFor();
  await page.getByText("● 已连接", { exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("proteus-selected-run")), selected);
  await phase("server-restart-restores-task");
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(readFileSync(join(root, "url.txt"), "utf8").split("#")[0]);
  await guestPage.getByRole("heading", { name: "连接本地助手", exact: true }).waitFor();
  assert.equal(await guestPage.getByRole("textbox", { name: "任务需求", exact: true }).count(), 0);
  await guest.close();
  await phase("unauthenticated-context-denied");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ phases, errors, failures }));
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error("BROWSER_WORKFLOW_FAILED", error.message);
  console.error(
    "BODY",
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
  process.exitCode = 1;
} finally {
  writeFileSync(
    join(root, "browser-report.json"),
    JSON.stringify(
      {
        phases,
        errors,
        failures,
        browser: browser.version(),
        node: process.version,
        fixture: "isolated HOME, database, two Git projects and scripted ACP agent",
      },
      null,
      2,
    ),
  );
  await context.close();
  await browser.close();
  if (restarted && restarted.exitCode === null) {
    const stopped = once(restarted, "exit");
    restarted.kill("SIGTERM");
    await stopped;
  }
}
