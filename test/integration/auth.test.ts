import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import ddl from "../../migrations/0001_init.sql?raw";
import adminGuard from "../../migrations/0004_admin_guard.sql?raw";
import authDdl from "../../migrations/0002_auth.sql?raw";
import app from "../../src/worker/index";
import { tokenHash } from "../../src/worker/auth";
import type { Env } from "../../src/worker/env";
import { createKv, D1Stub } from "../helpers/d1";

const origin = "https://rota.example";
function env(): Env {
  return { DB: new D1Stub(ddl + authDdl + adminGuard) as unknown as D1Database,
    CONFIG: createKv() as unknown as KVNamespace, ASSETS: {} as Fetcher,
    APP_ENV: "production", APP_ORIGIN: origin,
    OIDC_ISSUER: "https://id.example/", OIDC_CLIENT_ID: "rota" } as Env;
}
async function session(e: Env, role = "owner", enabled = 1) {
  await e.DB.prepare("insert into admin_user (id, oidc_subject, full_name, role, enabled, created_at) values ('u','sub','Test',?,?,datetime('now'))").bind(role, enabled).run();
  await e.DB.prepare("insert into auth_session values (?,'u',?)").bind(await tokenHash("test-session"), Math.floor(Date.now()/1000)+3600).run();
  return { cookie: "__Host-rota_session=test-session", origin };
}
afterEach(() => vi.unstubAllGlobals());

describe("认证边界", () => {
  it("生产环境拒绝匿名业务请求，即使错误配置了开发绕过", async () => {
    const e = env(); e.AUTH_DEV_BYPASS = "true";
    for (const path of ["/api/terms", "/api/export/schedule.csv", "/api/admin/settings", "/api/imports"]) {
      expect((await app.request(origin + path, {}, e)).status).toBe(401);
    }
    const me = await app.request(origin + "/api/auth/me", {}, e);
    expect(await me.json()).toMatchObject({ authenticated: false, mode: "oidc" });
  });
  it("按数据库即时检查角色及启用状态，拒绝伪造与过期会话", async () => {
    const e = env(); const headers = await session(e, "admin");
    expect((await app.request(origin + "/api/terms", { headers }, e)).status).toBe(200);
    expect((await app.request(origin + "/api/admin/settings", { headers }, e)).status).toBe(403);
    await e.DB.prepare("update admin_user set enabled=0").run();
    expect((await app.request(origin + "/api/terms", { headers }, e)).status).toBe(401);
    await e.DB.prepare("update admin_user set enabled=1").run();
    await e.DB.prepare("update auth_session set expires_at=0").run();
    expect((await app.request(origin + "/api/terms", { headers }, e)).status).toBe(401);
    expect((await app.request(origin + "/api/terms", { headers: { cookie: "__Host-rota_session=forged" } }, e)).status).toBe(401);
  });
  it("写请求拒绝跨站和缺少 Origin；审计记录真实用户", async () => {
    const e = env(); const headers = await session(e);
    for (const source of ["https://evil.example", ""]) {
      expect((await app.request(origin + "/api/persons", { method: "POST", headers: { ...headers, origin: source } }, e)).status).toBe(403);
    }
    const res = await app.request(origin + "/api/persons", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ fullName: "Example" }) }, e);
    expect(res.status).toBe(200);
    expect(await e.DB.prepare("select actor_id from audit_event").first()).toMatchObject({ actor_id: "u" });
  });
  it("所有者管理白名单，不能停用自己，停用后撤销会话", async () => {
    const e = env(); const headers = { ...await session(e), "content-type": "application/json" };
    const added = await app.request(origin + "/api/admin/users", { method: "POST", headers, body: JSON.stringify({ oidcSubject: "new-sub", fullName: "New admin" }) }, e);
    expect(added.status).toBe(201);
    const { id } = await added.json() as { id: string };
    expect((await app.request(origin + "/api/admin/users/u", { method: "PATCH", headers, body: JSON.stringify({ enabled: false }) }, e)).status).toBe(400);
    expect((await app.request(origin + "/api/admin/users/" + id, { method: "PATCH", headers, body: JSON.stringify({ enabled: false }) }, e)).status).toBe(200);
    expect(await e.DB.prepare("select enabled from admin_user where id=?").bind(id).first()).toMatchObject({ enabled: 0 });
  });
  it("退出销毁服务端会话，旧 Cookie 不可重用", async () => {
    const e = env(); const headers = await session(e);
    expect((await app.request(origin + "/api/auth/logout", { method: "POST", headers }, e)).status).toBe(200);
    expect((await app.request(origin + "/api/terms", { headers }, e)).status).toBe(401);
  });
});

describe("OIDC 授权码与 PKCE", () => {
  async function flow(variant = "valid") {
    const e = env(); await session(e);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "test", alg: "RS256", use: "sig" };
    let nonce = "";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openid-configuration")) return Response.json({ issuer: e.OIDC_ISSUER, authorization_endpoint: "https://id.example/authorize", token_endpoint: "https://id.example/token", jwks_uri: "https://id.example/jwks", response_types_supported: ["code"], id_token_signing_alg_values_supported: ["RS256"] });
      if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
      if (url.endsWith("/token")) {
        expect(String(init?.body)).toContain("code_verifier=");
        const key = variant === "signature" ? (await generateKeyPair("RS256")).privateKey : privateKey;
        const id = await new SignJWT({ nonce: variant === "nonce" ? "wrong" : nonce })
          .setProtectedHeader({ alg: "RS256", kid: "test" }).setSubject(variant === "unlisted" ? "other" : "sub")
          .setIssuer(variant === "issuer" ? "https://evil.example/" : e.OIDC_ISSUER)
          .setAudience(variant === "audience" ? "other" : e.OIDC_CLIENT_ID)
          .setIssuedAt().setExpirationTime(variant === "expired" ? "-1h" : "1h").sign(key);
        return Response.json({ access_token: "access", token_type: "Bearer", id_token: id });
      }
      throw new Error("Unexpected URL");
    });
    vi.stubGlobal("fetch", fetchMock);
    const login = await app.request(origin + "/api/auth/login", {}, e);
    expect(login.status).toBe(302);
    const url = new URL(login.headers.get("location")!);
    nonce = url.searchParams.get("nonce")!;
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(login.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(login.headers.get("set-cookie")).toMatch(/Secure/);
    const callback = origin + "/api/auth/callback?code=test&state=" + url.searchParams.get("state");
    return { e, cookie, callback, fetchMock };
  }
  it("完整登录验签、设会话，回调只能使用一次", async () => {
    const { e, cookie, callback } = await flow();
    const result = await app.request(callback, { headers: { cookie } }, e);
    expect(result.headers.get("location")).toBe("/");
    const cookies = result.headers.get("set-cookie")!.split(/, (?=__Host-)/);
    const sessionCookie = cookies.find(c => c.startsWith("__Host-rota_session="))!.split(";")[0];
    expect((await app.request(origin + "/api/terms", { headers: { cookie: sessionCookie } }, e)).status).toBe(200);
    expect((await app.request(callback, { headers: { cookie } }, e)).headers.get("location")).toContain("expired");
  });
  it.each(["nonce", "signature", "issuer", "audience", "expired", "unlisted"])("拒绝无效 %s", async variant => {
    const { e, cookie, callback } = await flow(variant);
    expect((await app.request(callback, { headers: { cookie } }, e)).headers.get("location")).toContain("auth_error=");
    expect(await e.DB.prepare("select count(*) as n from auth_session").first()).toMatchObject({ n: 1 });
  });
  it("缺少浏览器绑定或 state 不一致时不交换授权码", async () => {
    const { e, cookie, callback, fetchMock } = await flow();
    expect((await app.request(callback, {}, e)).headers.get("location")).toContain("invalid_state");
    expect((await app.request(callback + "wrong", { headers: { cookie } }, e)).headers.get("location")).toContain("invalid_state");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
