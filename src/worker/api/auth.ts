import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import * as oauth from "oauth4webapi";
import type { Env } from "../env";
import { clearAuthCookie, FLOW_COOKIE, getCurrentUser, localAuth, requireSameOrigin, SESSION_COOKIE, SESSION_SECONDS, setAuthCookie, tokenHash } from "../auth";
import { HttpError, nowIso, ulid } from "../lib/core";

export const auth = new Hono<{ Bindings: Env }>();

async function metadata(env: Env) {
  const issuer = new URL(env.OIDC_ISSUER);
  return oauth.processDiscoveryResponse(issuer, await oauth.discoveryRequest(issuer));
}

function callbackUrl(env: Env): string {
  if (!env.APP_ORIGIN || new URL(env.APP_ORIGIN).protocol !== "https:") {
    throw new HttpError(503, "unavailable", "登录尚未配置完成");
  }
  return new URL("/api/auth/callback", env.APP_ORIGIN).href;
}

auth.get("/me", async c => {
  const user = await getCurrentUser(c);
  return c.json({ authenticated: !!user, user, mode: localAuth(c.env) ? "disabled" : "oidc" });
});

auth.get("/login", async c => {
  const redirectUri = callbackUrl(c.env);
  const as = await metadata(c.env);
  const state = oauth.generateRandomState();
  const verifier = oauth.generateRandomCodeVerifier();
  const nonce = oauth.generateRandomNonce();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare("delete from auth_flow where expires_at <= ?").bind(now),
    c.env.DB.prepare("delete from auth_session where expires_at <= ?").bind(now),
    c.env.DB.prepare("insert into auth_flow (state_hash, verifier, nonce, expires_at) values (?,?,?,?)")
      .bind(await tokenHash(state), verifier, nonce, now + 600),
  ]);
  setAuthCookie(c, FLOW_COOKIE, state, 600);
  const url = new URL(as.authorization_endpoint!);
  url.search = new URLSearchParams({ client_id: c.env.OIDC_CLIENT_ID, redirect_uri: redirectUri,
    response_type: "code", scope: "openid profile email", state, nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256" }).toString();
  return c.redirect(url.href);
});

auth.get("/callback", async c => {
  const state = getCookie(c, FLOW_COOKIE);
  clearAuthCookie(c, FLOW_COOKIE);
  if (!state || state !== c.req.query("state")) return c.redirect("/?auth_error=invalid_state");
  const flow = await c.env.DB.prepare("delete from auth_flow where state_hash = ? and expires_at > ? returning verifier, nonce")
    .bind(await tokenHash(state), Math.floor(Date.now() / 1000)).first<{ verifier: string; nonce: string }>();
  if (!flow) return c.redirect("/?auth_error=expired");
  try {
    const as = await metadata(c.env);
    const client: oauth.Client = { client_id: c.env.OIDC_CLIENT_ID };
    const params = oauth.validateAuthResponse(as, client, new URL(c.req.url), state);
    const clientAuth = c.env.OIDC_CLIENT_SECRET ? oauth.ClientSecretBasic(c.env.OIDC_CLIENT_SECRET) : oauth.None();
    const response = await oauth.authorizationCodeGrantRequest(as, client, clientAuth, params, callbackUrl(c.env), flow.verifier);
    const result = await oauth.processAuthorizationCodeResponse(as, client, response, { expectedNonce: flow.nonce, requireIdToken: true });
    await oauth.validateApplicationLevelSignature(as, response);
    const claims = oauth.getValidatedIdTokenClaims(result)!;
    // 从不自动授予新账号管理员权限；名单由所有者明确维护。
    const user = await c.env.DB.prepare("select id from admin_user where oidc_subject = ? and enabled = 1 and role in ('owner','admin')")
      .bind(claims.sub).first<{ id: string }>();
    if (!user) return c.redirect("/?auth_error=not_allowed");
    const token = oauth.generateRandomCodeVerifier();
    const previous = getCookie(c, SESSION_COOKIE);
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.batch([
      c.env.DB.prepare("delete from auth_session where token_hash = ?").bind(await tokenHash(previous ?? "")),
      c.env.DB.prepare("insert into auth_session (token_hash, user_id, expires_at) values (?,?,?)")
        .bind(await tokenHash(token), user.id, now + SESSION_SECONDS),
      c.env.DB.prepare("update admin_user set last_login_at = ? where id = ?").bind(nowIso(), user.id),
      c.env.DB.prepare("insert into audit_event (id, actor_id, action, created_at) values (?,?,'auth.login',?)").bind(ulid(), user.id, nowIso()),
    ]);
    setAuthCookie(c, SESSION_COOKIE, token, SESSION_SECONDS);
    return c.redirect("/");
  } catch {
    // 不记录令牌、授权码或上游错误内容。
    return c.redirect("/?auth_error=failed");
  }
});

auth.post("/logout", async c => {
  requireSameOrigin(c);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("delete from auth_session where token_hash = ?").bind(await tokenHash(token)).run();
  clearAuthCookie(c, SESSION_COOKIE);
  return c.json({ ok: true });
});
