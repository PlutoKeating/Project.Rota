import { requireOwner } from "../auth";
import { Hono } from "hono";
import type { Context } from "hono";
import type {
  AppSettings,
  AuditEvent,
  LlmProvider,
  LlmProviderKind,
  ScoreWeights,
} from "../../shared/types";
import type { Env } from "../env";
import { testProvider } from "../llm/gateway";
import {
  asBool,
  asInt,
  asString,
  badRequest,
  dbAll,
  dbOne,
  dbRun,
  notFound,
  nowIso,
  oneOf,
  optString,
  parseJson,
  readJson,
  toBool,
  ulid,
} from "../lib/core";

/**
 * 管理后台：应用设置（KV）、模型供应商 CRUD、审计查询。
 *
 * 约定：
 * - 设置存 KV 的 `settings` 键，JSON；每次写都顺手写 `settings:version`，
 *   让运行中的进程能感知配置变化。
 * - 模型供应商配置存 D1，密钥只存 Worker Secret 的名字（api_key_secret），
 *   接口永远不返回密钥值。
 * - 所有写操作落 audit_event，actor_id 来自当前登录账号。
 */
export const admin = new Hono<{ Bindings: Env }>();

admin.use("*", async (c, next) => { await requireOwner(c); await next(); });

const PROVIDER_KINDS: readonly LlmProviderKind[] = [
  "openai_compatible",
  "anthropic",
  "google",
  "cloudflare_ai",
];

const DEFAULT_SETTINGS: AppSettings = {
  defaultCooldownDays: 3,
  weights: {
    fairness: 0.45,
    starvation: 0.3,
    preference: 0.15,
    priority: 0.1,
    recency: 0.2,
  },
  importProviderId: null,
  exportIncludePhone: false,
};

interface ProviderRow {
  id: string;
  name: string | null;
  kind: LlmProviderKind;
  baseUrl: string | null;
  model: string | null;
  apiKeySecret: string | null;
  enabled: number | boolean | null;
  params: string | null;
  updatedAt: string | null;
}

interface AuditRow {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payload: string | null;
  createdAt: string;
}

const PROVIDER_COLUMNS =
  "id, name, kind, base_url, model, api_key_secret, enabled, params, updated_at";

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

admin.get("/settings", async (c) => {
  const raw = await c.env.CONFIG.get("settings");
  if (!raw) return c.json(cloneDefaults());
  try {
    return c.json(normalizeSettings(parseJson<unknown>(raw)));
  } catch {
    // KV 里的值被手改坏了也不能让后台打不开，回退默认值。
    return c.json(cloneDefaults());
  }
});

admin.put("/settings", async (c) => {
  const body = await readObjectBody(c);
  const next = normalizeSettings(body);

  if (next.importProviderId) {
    const provider = await dbOne<{ id: string }>(
      c.env.DB,
      "select id from llm_provider where id = ?",
      next.importProviderId,
    );
    if (!provider) throw badRequest("importProviderId 指向的模型供应商不存在");
  }

  await c.env.CONFIG.put("settings", JSON.stringify(next));
  await c.env.CONFIG.put("settings:version", String(Date.now()));
  await audit(c, "admin.settings.update", "settings", "settings", {
    defaultCooldownDays: next.defaultCooldownDays,
    importProviderId: next.importProviderId,
    exportIncludePhone: next.exportIncludePhone,
  });
  return c.json(next);
});

// ---------------------------------------------------------------------------
// 模型供应商
// ---------------------------------------------------------------------------

admin.get("/llm-providers", async (c) => {
  const rows = await dbAll<ProviderRow>(
    c.env.DB,
    `select ${PROVIDER_COLUMNS} from llm_provider order by name, id`,
  );
  return c.json({ items: rows.map(providerView) });
});

admin.post("/llm-providers", async (c) => {
  const body = await readObjectBody(c);
  const name = asString(body.name, "name", 100);
  const kind = oneOf(body.kind, PROVIDER_KINDS, "kind");
  const baseUrl = normalizeBaseUrl(body.baseUrl, kind);
  const model = asString(body.model, "model", 200);
  const apiKeySecret = providerSecretName(body.apiKeySecret);
  const enabled = asBool(body.enabled, true);
  const params = providerParams(body.params);

  const id = ulid();
  await dbRun(
    c.env.DB,
    "insert into llm_provider (id, name, kind, base_url, model, api_key_secret, enabled, params, updated_at) values (?,?,?,?,?,?,?,?,?)",
    id,
    name,
    kind,
    baseUrl,
    model,
    apiKeySecret,
    enabled ? 1 : 0,
    params ? JSON.stringify(params) : null,
    nowIso(),
  );
  await bumpLlmVersion(c.env);
  await audit(c, "admin.llm_provider.create", "llm_provider", id, {
    name,
    kind,
    baseUrl,
    model,
    apiKeySecret,
    enabled,
  });

  const row = await getProviderRow(c.env.DB, id);
  if (!row) throw notFound("模型供应商不存在");
  return c.json(providerView(row), 201);
});

admin.patch("/llm-providers/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getProviderRow(c.env.DB, id);
  if (!existing) throw notFound("模型供应商不存在");

  const body = await readObjectBody(c);
  const name = body.name !== undefined ? asString(body.name, "name", 100) : existing.name ?? "";
  const kind =
    body.kind !== undefined ? oneOf(body.kind, PROVIDER_KINDS, "kind") : existing.kind;
  const baseUrl = normalizeBaseUrl(
    body.baseUrl !== undefined ? body.baseUrl : existing.baseUrl,
    kind,
  );
  const model =
    body.model !== undefined ? asString(body.model, "model", 200) : existing.model ?? "";
  if (!model) throw badRequest("model 必须是非空字符串");
  const apiKeySecret =
    body.apiKeySecret !== undefined
      ? providerSecretName(body.apiKeySecret)
      : existing.apiKeySecret;
  const enabled =
    body.enabled !== undefined ? asBool(body.enabled, true) : toBool(existing.enabled);
  const params =
    body.params !== undefined
      ? providerParams(body.params)
      : parseJson<Record<string, unknown>>(existing.params);

  await dbRun(
    c.env.DB,
    "update llm_provider set name = ?, kind = ?, base_url = ?, model = ?, api_key_secret = ?, enabled = ?, params = ?, updated_at = ? where id = ?",
    name,
    kind,
    baseUrl,
    model,
    apiKeySecret,
    enabled ? 1 : 0,
    params ? JSON.stringify(params) : null,
    nowIso(),
    id,
  );
  await bumpLlmVersion(c.env);
  await audit(c, "admin.llm_provider.update", "llm_provider", id, {
    name,
    kind,
    baseUrl,
    model,
    apiKeySecret,
    enabled,
    fields: Object.keys(body),
  });

  const row = await getProviderRow(c.env.DB, id);
  if (!row) throw notFound("模型供应商不存在");
  return c.json(providerView(row));
});

admin.delete("/llm-providers/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getProviderRow(c.env.DB, id);
  if (!existing) throw notFound("模型供应商不存在");

  await dbRun(c.env.DB, "delete from llm_provider where id = ?", id);
  await bumpLlmVersion(c.env);
  await audit(c, "admin.llm_provider.delete", "llm_provider", id, {
    name: existing.name,
    kind: existing.kind,
  });
  return c.json({ ok: true });
});

admin.post("/llm-providers/:id/test", async (c) => {
  const id = c.req.param("id");
  const existing = await getProviderRow(c.env.DB, id);
  if (!existing) throw notFound("模型供应商不存在");

  const result = await testProvider(c.env, id);
  await audit(c, "admin.llm_provider.test", "llm_provider", id, {
    ok: result.ok,
    message: result.message.slice(0, 200),
  });
  return c.json(result);
});

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

admin.get("/audit", async (c) => {
  const rawLimit = c.req.query("limit");
  const limit = rawLimit ? Math.min(500, asInt(rawLimit, "limit", 1)) : 50;
  const rows = await dbAll<AuditRow>(
    c.env.DB,
    "select id, actor_id, action, target_type, target_id, payload, created_at from audit_event order by created_at desc, id desc limit ?",
    limit,
  );
  return c.json({ items: rows.map(auditView) });
});

// ---------------------------------------------------------------------------
// 设置校验
// ---------------------------------------------------------------------------

function cloneDefaults(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    weights: { ...DEFAULT_SETTINGS.weights },
  };
}

function normalizeSettings(value: unknown): AppSettings {
  if (value === undefined || value === null) return cloneDefaults();
  const input = asRecord(value);
  if (!input) throw badRequest("settings 必须是 JSON 对象");

  const settings = cloneDefaults();

  if (input.defaultCooldownDays !== undefined && input.defaultCooldownDays !== null) {
    const days = asInt(input.defaultCooldownDays, "defaultCooldownDays", 0);
    if (days > 365) throw badRequest("defaultCooldownDays 不能超过 365");
    settings.defaultCooldownDays = days;
  }

  settings.weights = normalizeWeights(input.weights, settings.weights);

  if ("importProviderId" in input) {
    settings.importProviderId = optString(input.importProviderId, "importProviderId", 100);
  }

  if (input.exportIncludePhone !== undefined) {
    settings.exportIncludePhone = asBool(input.exportIncludePhone);
  }

  return settings;
}

function normalizeWeights(value: unknown, base: ScoreWeights): ScoreWeights {
  if (value === undefined || value === null) return { ...base };
  const input = asRecord(value);
  if (!input) throw badRequest("weights 必须是对象");

  const pick = (key: keyof ScoreWeights): number => {
    const raw = input[key];
    if (raw === undefined || raw === null) return base[key];
    const num = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(num) || num < 0 || num > 1) {
      throw badRequest(`weights.${key} 必须是 0~1 的数字`);
    }
    return num;
  };

  return {
    fairness: pick("fairness"),
    starvation: pick("starvation"),
    preference: pick("preference"),
    priority: pick("priority"),
    recency: pick("recency"),
  };
}

// ---------------------------------------------------------------------------
// 供应商校验与序列化
// ---------------------------------------------------------------------------

async function getProviderRow(db: D1Database, id: string): Promise<ProviderRow | null> {
  return dbOne<ProviderRow>(
    db,
    `select ${PROVIDER_COLUMNS} from llm_provider where id = ?`,
    id,
  );
}

function providerView(row: ProviderRow): LlmProvider {
  return {
    id: row.id,
    name: row.name ?? "",
    kind: row.kind,
    baseUrl: row.baseUrl,
    model: row.model ?? "",
    // 只回密钥名，绝不回密钥值。
    apiKeySecret: row.apiKeySecret,
    enabled: toBool(row.enabled),
    params: parseJson<Record<string, unknown>>(row.params),
    updatedAt: row.updatedAt,
  };
}

function normalizeBaseUrl(value: unknown, kind: LlmProviderKind): string | null {
  const raw = optString(value, "baseUrl", 500);
  if (!raw) {
    if (kind === "cloudflare_ai") return null;
    throw badRequest(`kind=${kind} 需要 baseUrl`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("baseUrl 不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("baseUrl 必须以 http(s):// 开头");
  }
  return raw.replace(/\/+$/, "");
}

function providerSecretName(value: unknown): string | null {
  const name = optString(value, "apiKeySecret", 100);
  if (!name) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw badRequest("apiKeySecret 必须是 Worker Secret 名称（字母、数字、下划线，且不能以数字开头）");
  }
  return name;
}

function providerParams(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  const input = asRecord(value);
  if (!input) throw badRequest("params 必须是 JSON 对象");
  if (JSON.stringify(input).length > 10_000) throw badRequest("params 过大");
  return input;
}

function auditView(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    payload: parseJson<Record<string, unknown>>(row.payload),
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

async function readObjectBody(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
  const body = await readJson<unknown>(c);
  const record = asRecord(body);
  if (!record) throw badRequest("请求体必须是 JSON 对象");
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function bumpLlmVersion(env: Env): Promise<void> {
  await env.CONFIG.put("llm:version", String(Date.now()));
}

async function audit(
  c: Context<{ Bindings: Env }>,
  action: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await dbRun(
    c.env.DB,
    "insert into audit_event (id, actor_id, action, target_type, target_id, payload, actor_ip, created_at) values (?,?,?,?,?,?,?,?)",
    ulid(),
    c.get("user").id,
    action,
    targetType,
    targetId,
    JSON.stringify(payload),
    c.req.header("cf-connecting-ip") ?? null,
    nowIso(),
  );
}

// 账号只保存公开的 OIDC subject 与本系统授权，不接触身份服务实现。
admin.get("/users", async c => c.json({ items: await dbAll(c.env.DB,
  "select id, oidc_subject, full_name, role, enabled, last_login_at, created_at from admin_user order by created_at") }));

admin.post("/users", async c => {
  const body = await readObjectBody(c);
  const subject = asString(body.oidcSubject, "oidcSubject", 255);
  const name = asString(body.fullName, "fullName", 100);
  const role = oneOf(body.role ?? "admin", ["owner", "admin"] as const, "role");
  const id = ulid();
  if (await dbOne(c.env.DB, "select id from admin_user where oidc_subject=?", subject)) throw badRequest("账号已存在");
  await c.env.DB.batch([
    c.env.DB.prepare("insert into admin_user (id,oidc_subject,full_name,role,enabled,created_at) values (?,?,?,?,1,?)")
      .bind(id, subject, name, role, nowIso()),
    c.env.DB.prepare("insert into audit_event (id,actor_id,action,target_type,target_id,created_at) values (?,?,'admin.user.create','admin_user',?,?)")
      .bind(ulid(), c.get("user").id, id, nowIso()),
  ]);
  return c.json({ id }, 201);
});

admin.patch("/users/:id", async c => {
  const id = c.req.param("id");
  if (id === c.get("user").id) throw badRequest("不能修改自己的角色或停用自己");
  const existing = await dbOne<{ role: string; enabled: number }>(c.env.DB, "select role,enabled from admin_user where id=?", id);
  if (!existing) throw notFound("账号不存在");
  const body = await readObjectBody(c);
  const role = oneOf(body.role ?? existing.role, ["owner", "admin"] as const, "role");
  const enabled = body.enabled === undefined ? existing.enabled : Number(asBool(body.enabled));
  await c.env.DB.batch([
    c.env.DB.prepare("update admin_user set role=?,enabled=? where id=?").bind(role, enabled, id),
    c.env.DB.prepare("delete from auth_session where user_id=?").bind(id),
    c.env.DB.prepare("insert into audit_event (id,actor_id,action,target_type,target_id,payload,created_at) values (?,?,'admin.user.update','admin_user',?,?,?)")
      .bind(ulid(), c.get("user").id, id, JSON.stringify({ role, enabled }), nowIso()),
  ]);
  return c.json({ ok: true });
});
