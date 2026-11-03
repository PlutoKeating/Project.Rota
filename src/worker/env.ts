export interface Env {
  DB: D1Database;
  FILES?: R2Bucket;
  STORAGE_URL?: string;
  STORAGE_AUTHORIZATION?: string;
  CONFIG: KVNamespace;
  ASSETS: Fetcher;
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  APP_ENV: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET?: string;
  APP_ORIGIN?: string;
  AUTH_DEV_BYPASS?: string;
}

export interface HealthResponse {
  ok: boolean;
  env: string;
  db: "up" | "down";
  ts: string;
}
