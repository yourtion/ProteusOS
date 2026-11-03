import type { Settings as SettingsModel } from "../models";
import { EmptyState, EvidenceDetails, PageHeader, Panel, StatusBadge } from "../ui";
export function SettingsPage({ settings }: { settings: SettingsModel | null }) {
  if (!settings)
    return (
      <section className="content">
        <EmptyState title="正在读取运行环境…" />
      </section>
    );
  return (
    <section className="content">
      <PageHeader title="助手与运行环境" description="查看执行器可用性、实例位置和行为版本。" />
      <div className="panel-grid">
        <Panel title="执行器" description="安装状态不代表已认证，实际可用性以运行结果为准。">
          {settings.executors.length ? (
            <div className="record-list executor-list">
              {settings.executors.map((executor) => (
                <article className="record-row" key={executor.name}>
                  <div className="record-main">
                    <strong>{executor.name}</strong>
                    <p className="note">
                      {executor.name === settings.defaultExecutor ? "默认执行器" : "可选执行器"}
                    </p>
                  </div>
                  <StatusBadge tone={executor.installed ? "success" : "warning"}>
                    {executor.installed ? "已安装" : "未安装"}
                  </StatusBadge>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="暂无执行器" description="请先在宿主环境配置执行器。" />
          )}
          <p className="note">
            使用宿主机已有登录或环境配置，凭据不会发送到浏览器。项目副本不等于操作系统沙箱，工具权限请逐项审阅。
          </p>
        </Panel>
        <div className="panel-stack">
          <Panel title="本地实例">
            <dl className="metadata">
              <dt>实例目录</dt>
              <dd>
                <code>{settings.home}</code>
              </dd>
              <dt>默认执行器</dt>
              <dd>{settings.defaultExecutor || "未配置"}</dd>
            </dl>
            <EvidenceDetails title="个体与版本数据" value={settings.organism} />
          </Panel>
          <Panel
            title="候选与采用记录"
            description="只读查看；采用与回滚操作请前往「经验与行为版本」。"
          >
            <dl className="metadata">
              <dt>候选</dt>
              <dd>{settings.candidates.length}</dd>
              <dt>采用记录</dt>
              <dd>{settings.promotions.length}</dd>
            </dl>
            <EvidenceDetails
              title="完整记录"
              value={{ candidates: settings.candidates, promotions: settings.promotions }}
            />
          </Panel>
        </div>
      </div>
    </section>
  );
}
