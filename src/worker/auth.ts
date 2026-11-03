import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./env";
import { HttpError } from "./lib/core";

export interface CurrentUser {
  id: string;
  name: string;
  role: "owner" | "admin";
  mode: "disabled" | "oidc";
}

declare module "hono" {
  interface ContextVariableMap { user: CurrentUser }
}

export const LOCAL_OWNER: CurrentUser = { id: "local-owner", name: "本地管理员", role: "owner", mode: "disabled" };
export const SESSION_COOKIE = "__Host-rota_session";
export const FLOW_COOKIE = "__Host-rota_flow";
export const SESSION_SECONDS = 8 * 60 * 60;

// 双重开关，仅隔离的本地开发和测试环境可绕过认证。
export function localAuth(env: Env): boolean {
  return env.AUTH_DEV_BYPASS === "true" && ["development", "test"].includes(env.APP_ENV);
}

export async function tokenHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

export function setAuthCookie(c: Context, name: string, value: string, maxAge: number) {
  setCookie(c, name, value, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge });
}

export function clearAuthCookie(c: Context, name: string) {
  deleteCookie(c, name, { secure: true, httpOnly: true, sameSite: "Lax", path: "/" });
}

export async function getCurrentUser(c: Context<{ Bindings: Env }>): Promise<CurrentUser | null> {
  if (localAuth(c.env)) return LOCAL_OWNER;
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare(`select u.id, u.full_name as name, u.role
    from auth_session s join admin_user u on u.id = s.user_id
    where s.token_hash = ? and s.expires_at > ? and u.enabled = 1`)
    .bind(await tokenHash(token), Math.floor(Date.now() / 1000)).first<{ id: string; name: string; role: string }>();
  if (!row || !["owner", "admin"].includes(row.role)) return null;
  return { id: row.id, name: row.name, role: row.role as CurrentUser["role"], mode: "oidc" };
}

export async function requireOwner(c: Context<{ Bindings: Env }>): Promise<CurrentUser> {
  const user = c.get("user") ?? await getCurrentUser(c);
  if (!user) throw new HttpError(401, "unauthorized", "请先登录");
  if (user.role !== "owner") throw new HttpError(403, "forbidden", "需要所有者权限");
  return user;
}

export function requireSameOrigin(c: Context<{ Bindings: Env }>) {
  if (localAuth(c.env)) return;
  const expected = c.env.APP_ORIGIN;
  if (!expected || c.req.header("origin") !== expected || c.req.header("sec-fetch-site") === "cross-site") {
    throw new HttpError(403, "forbidden", "请求来源无效，请从本站重新操作");
  }
}
