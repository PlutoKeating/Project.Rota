import type { Context } from "hono";
import type { Env } from "./env";

/**
 * 认证占位。
 *
 * TODO(OIDC)：接入 https://id.plutokeating.beer 时，只需要替换本文件里的
 * 两个函数，并在 api/auth.ts 实现 login / callback：
 *
 * 1. getCurrentUser：
 *    - 从 Cookie（HttpOnly + Secure + SameSite=Lax）取会话；
 *    - 校验 OIDC ID Token（iss / aud / exp / 签名），或用授权码换 token 后校验；
 *    - 用 oidc_subject 查 `admin_user`，确认 enabled=1，返回数据库里的角色；
 *    - 未登录返回 null（现在返回本地 owner，调用方无需判空）。
 * 2. requireOwner：
 *    - 调 getCurrentUser，未登录抛 401，角色不是 owner 抛 403。
 *
 * 其余业务代码统一通过 `c.get("user")`（或本文件的函数）取当前用户，
 * 不要在路由里自己解析 Cookie / Token。
 */

export type AuthMode = "disabled" | "oidc";

export interface CurrentUser {
  id: string;
  name: string;
  role: "owner";
  mode: AuthMode;
}

/** 占位模式下的本地管理员，ID 固定，便于审计日志辨认。 */
export const LOCAL_OWNER: CurrentUser = {
  id: "local-owner",
  name: "本地管理员",
  role: "owner",
  mode: "disabled",
};

export async function getCurrentUser(c: Context<{ Bindings: Env }>): Promise<CurrentUser> {
  void c;
  return LOCAL_OWNER;
}

/** 占位模式下永远通过；接入 OIDC 后改为 401 / 403 判断。 */
export async function requireOwner(c: Context<{ Bindings: Env }>): Promise<CurrentUser> {
  return getCurrentUser(c);
}
