import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * SQLite 单 writer 封装：迁移、事务与薄查询助手。
 * 跨模块不变量必须在同一个 tx 内完成（见 docs/repository.md §2）。
 */
export class SqliteDb {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** 返回受影响行数 */
  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const row = this.db.prepare(sql).get(...params);
    return (row as T | undefined) ?? undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      throw new Error("嵌套事务不支持：跨模块不变量须在同一个提交单元内完成");
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  migrate(migrations: readonly Migration[]): void {
    this.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    const applied = new Set(
      this.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version),
    );
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.exec(m.sql);
        this.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          m.version,
          m.name,
          Date.now(),
        );
      });
    }
  }

  close(): void {
    this.db.close();
  }
}
