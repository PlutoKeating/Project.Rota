export interface Env {
  /** Internal SQL compatibility interface; production is backed by the ECS data service. */
  DB: D1Database;
  DATA_SERVICE_URL?: string;
  DATA_SERVICE_AUTHORIZATION?: string;
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
