declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): Record<string, unknown>[];
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    };
    close(): void;
  }
}

declare module "*?raw" {
  const content: string;
  export default content;
}
