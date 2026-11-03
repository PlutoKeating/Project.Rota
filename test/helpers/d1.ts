import { DatabaseSync } from "node:sqlite";

/**
 * 用 Node 内置 sqlite 模拟 D1 的最小接口。
 *
 * 这样领域与路由可以在没有 workerd 的环境里跑真实 SQL：
 * 建表、插数据、走一遍 app.request()，比 mock 一层 ORM 可靠得多。
 * 只实现本项目用到的 D1 子集：prepare / bind / first / all / run / batch。
 */

type Bind = string | number | null;

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Bind[] = [],
  ) {}

  bind(...params: Bind[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  runSync(): { success: true; meta: Record<string, unknown> } {
    this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: {} };
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    if (column) return (row[column] ?? null) as T | null;
    return row as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    return this.runSync();
  }
}

export class D1Stub {
  private readonly db: DatabaseSync;

  constructor(ddl: string) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(ddl);
  }

  prepare(sql: string): Statement {
    return new Statement(this.db, sql);
  }

  async batch(statements: Statement[]): Promise<unknown[]> {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export interface FakeKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export function createKv(): FakeKv {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

export function createFiles(): { put: () => Promise<unknown>; get: () => Promise<null>; delete: () => Promise<void> } {
  return {
    async put() {
      return {};
    },
    async get() {
      return null;
    },
    async delete() {
      return;
    },
  };
}
