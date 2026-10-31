import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { Button, EvidenceDetails, Field, Notice, StatusBadge } from "../src/ui";
import { Projects } from "../src/pages/Projects";
import { SettingsPage } from "../src/pages/Settings";
import { Governance } from "../src/Governance";
import { TaskInspector, type InspectorTab } from "../src/TaskInspector";
import type { Detail, Settings } from "../src/models";

const detail: Detail = {
  id: "run",
  projectId: "project",
  conversationId: "conversation",
  turnId: "turn",
  goal: "检查项目",
  mode: "edit",
  executor: "codex",
  snapshotId: "snapshot",
  inputDir: "/tmp",
  baseline: {},
  testCommand: [],
  createdAt: 0,
  run: { state: "succeeded", failureReason: null, deadlineAt: 1000 },
  activity: [],
  interactions: [],
  experience: null,
  conversation: { truncated: false, turns: [] },
};
function inspector(tab: InspectorTab, work = detail) {
  return render(
    <TaskInspector
      detail={work}
      tab={tab}
      onTab={() => {}}
      change={null}
      onChange={() => {}}
      onClose={() => {}}
      busy={false}
      onAction={async (fn) => fn()}
      onUpdated={() => {}}
    />,
  );
}

describe("shared workbench UI contracts", () => {
  it("keeps auxiliary actions out of form submission and prevents repeated pending actions", () => {
    const html = render(
      <form>
        <Button>取消</Button>
        <Button type="submit" pending>
          保存
        </Button>
      </form>,
    );
    expect(html).toMatch(/type="button"[^>]*>取消/);
    expect(html).toMatch(/type="submit"[^>]*disabled=""[^>]*aria-busy="true"/);
  });
  it("associates labels and help text without discarding existing accessibility descriptions", () => {
    const html = render(
      <>
        <p id="policy">路径限制</p>
        <Field label="仓库" hint="填写绝对路径">
          <input id="repo" aria-describedby="policy" />
        </Field>
        <Field label="需求" hiddenLabel>
          <textarea />
        </Field>
      </>,
    );
    expect(html).toContain('for="repo"');
    expect(html).toContain('aria-describedby="policy repo-hint"');
    expect(html).toContain('id="repo-hint"');
    const labels = [...html.matchAll(/<label for="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(labels).size).toBe(2);
    expect(html).toContain(`id="${labels[1]}"`);
  });
  it("does not present missing or future states as success", () => {
    const html = render(
      <>
        <StatusBadge />
        <StatusBadge state="future-state" />
        <StatusBadge state="failed" />
        <StatusBadge state="waiting" />
      </>,
    );
    expect(html).not.toContain("tone-success");
    expect(html).toContain('tone-neutral">未知');
    expect(html).toContain('tone-neutral">future-state');
    expect(html).toContain('tone-danger">执行失败');
    expect(html).toContain('tone-warning">等待处理');
  });
  it("keeps evidence collapsed and escaped, with errors announced distinctly", () => {
    const html = render(
      <>
        <Notice tone="danger">请求失败</Notice>
        <EvidenceDetails title="原始结果" value={{ text: "<script>alert(1)</script>" }} />
      </>,
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('open=""');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("page and inspector states", () => {
  it("offers an accessible empty project form and separates unconfigured checks from success", () => {
    const empty = render(
      <Projects
        busy={false}
        onBusyChange={() => {}}
        projects={[]}
        limits={{ files: 2000, bytes: 64 * 1024 * 1024 }}
        onSaved={async () => {}}
      />,
    );
    expect(empty).toContain("64 MiB");
    expect(empty).toContain("还没有连接项目");
    expect(empty).toContain('type="submit"');
    const populated = render(
      <Projects
        busy={false}
        onBusyChange={() => {}}
        projects={[{ id: "p", name: "demo", path: "/tmp/demo", testCommand: [], createdAt: 0 }]}
        onSaved={async () => {}}
      />,
    );
    expect(populated).toContain('tone-warning">未配置检查');
    expect(populated).toContain("编辑配置");
  });
  it("reports executor installation independently of authentication", () => {
    const settings: Settings = {
      home: "/tmp/instance",
      defaultExecutor: "codex",
      limits: { files: 2000, bytes: 64 * 1024 * 1024 },
      executors: [
        { name: "codex", installed: true },
        { name: "claude", installed: false },
      ],
      organism: null,
      candidates: [],
      promotions: [],
    };
    const html = render(<SettingsPage settings={settings} />);
    expect(html).toContain("安装状态不代表已认证");
    expect(html).toContain('tone-warning">未安装');
    expect(html).toContain("默认执行器");
    expect(html).not.toContain('open=""');
  });
  it("distinguishes a loading governance page from an empty result", () => {
    const html = render(<Governance />);
    expect(html).toContain("正在读取行为版本");
    expect(html).not.toContain("尚无候选");
    expect(html).not.toContain("冻结许可经验");
  });
  it("renders every inspector view with a selected accessible control and honest empty state", () => {
    const cases: [InspectorTab, string][] = [
      ["changes", "尚无文件结果"],
      ["tools", "尚无工具事件"],
      ["trace", "尚无轨迹事件"],
      ["usage", "尚无可靠报告"],
      ["checks", "未验证"],
      ["evidence", "下载结果与证据 JSON"],
    ];
    for (const [tab, text] of cases) {
      const html = inspector(tab);
      expect(html).toContain(text);
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
      expect(html).toContain("关闭任务详情");
      expect(html).not.toContain("tone-success");
    }
  });
  it("only offers application for completed edit results with changes", () => {
    const result = {
      summary: "完成",
      changes: [{ path: "a.ts", before: "old", after: "new" }],
      checks: { tested: true, passed: true, output: "ok" },
      workspace: "/tmp/output",
    };
    const completed = { ...detail, result };
    expect(inspector("changes", completed)).toContain("应用到原项目");
    expect(inspector("changes", { ...completed, mode: "read" })).not.toContain("应用到原项目");
    expect(
      inspector("changes", { ...completed, result: { ...result, changes: [] } }),
    ).not.toContain("应用到原项目");
    expect(
      inspector("changes", { ...completed, run: { ...detail.run, state: "failed" } }),
    ).not.toContain("应用到原项目");
    expect(inspector("changes", { ...completed, appliedAt: 1000 })).toMatch(
      /disabled=""[^>]*>已应用到项目/,
    );
  });
  it("does not render a previously selected file missing from the current result", () => {
    const html = render(
      <TaskInspector
        detail={detail}
        tab="changes"
        onTab={() => {}}
        change={{ path: "other.txt", before: "stale content", after: "stale output" }}
        onChange={() => {}}
        onClose={() => {}}
        busy={false}
        onAction={async (fn) => fn()}
        onUpdated={() => {}}
      />,
    );
    expect(html).not.toContain("stale content");
    expect(html).not.toContain("other.txt");
  });
});
