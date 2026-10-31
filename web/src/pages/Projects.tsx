import { useRef, useState } from "react";
import type { Project } from "../../../src/app/workbench/contracts";
import { api } from "../api";
import type { Settings } from "../models";
import { Button, EmptyState, Field, Notice, PageHeader, Panel, StatusBadge } from "../ui";
export function Projects({
  projects,
  limits,
  onSaved,
  busy,
  onBusyChange,
}: {
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  projects: Project[];
  limits?: Settings["limits"];
  onSaved: (project: Project) => Promise<void>;
}) {
  const [draft, setDraft] = useState({ path: "", name: "", command: "[]" });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  return (
    <section className="content">
      <PageHeader
        title="项目与检查配置"
        description={
          <>
            任务在独立副本执行，审阅后应用到原项目。
            {limits && (
              <>
                最多 {limits.files} 个文件 / {Math.floor(limits.bytes / 1024 / 1024)}{" "}
                MiB；二进制资源保留为文件。
              </>
            )}
          </>
        }
      />
      <Panel
        title={editing ? "编辑项目" : "添加项目"}
        description="选择普通 Git 仓库根目录，并登记本地检查命令。"
      >
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            onBusyChange(true);
            setError("");
            try {
              let command: unknown;
              try {
                command = JSON.parse(draft.command);
              } catch {
                throw new Error('检查命令需要是 JSON 数组，例如 ["node", "--test"]');
              }
              const project = await api<Project>("projects", {
                path: draft.path,
                name: draft.name || undefined,
                testCommand: command,
              });
              await onSaved(project);
            } catch (error) {
              setError(String(error));
            } finally {
              onBusyChange(false);
            }
          }}
        >
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="form-grid">
            <Field label="项目名称">
              <input
                ref={nameInput}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="可选，例如 ProteusOS"
              />
            </Field>
            <Field label="Git 仓库绝对路径">
              <input
                required
                value={draft.path}
                onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                placeholder="/Users/you/code/my-project"
              />
            </Field>
          </div>
          <Field
            label="测试命令参数 JSON"
            hint="空数组表示不运行测试。命令在副本中执行，不会自动安装依赖。"
          >
            <input
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder={'["node", "--test"]'}
            />
          </Field>
          <div className="actions">
            <Button variant="primary" type="submit" pending={busy}>
              {busy ? "保存中…" : "保存项目"}
            </Button>
            {editing && (
              <Button
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft({ path: "", name: "", command: "[]" });
                  setError("");
                }}
              >
                取消编辑
              </Button>
            )}
          </div>
        </form>
      </Panel>
      <Panel title={`已连接项目 · ${projects.length}`}>
        {!projects.length ? (
          <EmptyState title="还没有连接项目" description="填写上面的路径即可开始。" />
        ) : (
          <div className="record-list">
            {projects.map((project) => (
              <article className="record-row" key={project.id}>
                <div className="record-main">
                  <strong>{project.name}</strong>
                  <code>{project.path}</code>
                  <p className="note">检查：{project.testCommand.join(" ") || "未配置"}</p>
                </div>
                <StatusBadge tone={project.testCommand.length ? "neutral" : "warning"}>
                  {project.testCommand.length ? "已配置检查" : "未配置检查"}
                </StatusBadge>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setDraft({
                      path: project.path,
                      name: project.name,
                      command: JSON.stringify(project.testCommand),
                    });
                    setEditing(true);
                    setError("");
                    nameInput.current?.focus();
                  }}
                >
                  编辑配置
                </Button>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </section>
  );
}
