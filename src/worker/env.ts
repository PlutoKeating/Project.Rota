export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  CONFIG: KVNamespace;
  ASSETS: Fetcher;
  APP_ENV: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
}

export interface HealthResponse {
  ok: boolean;
  env: string;
  db: "up" | "down";
  ts: string;
}
