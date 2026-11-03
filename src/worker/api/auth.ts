import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth";

/**
 * 认证路由占位。当前所有请求都视为本地 owner。
 * 接入 OIDC 后在这里实现 login / callback，并替换 ../auth.ts 的两个函数。
 */
export const auth = new Hono<{ Bindings: Env }>();

auth.get("/me", async (c) => {
  const user = await getCurrentUser(c);
  return c.json({
    authenticated: true,
    user,
    mode: "disabled",
  });
});

auth.get("/login", (c) =>
  c.json(
    {
      error: {
        code: "not_implemented",
        message: "账号体系待接入（id.plutokeating.beer OIDC），当前为本地占位模式",
      },
    },
    501 as const,
  ),
);

auth.get("/callback", (c) =>
  c.json(
    {
      error: {
        code: "not_implemented",
        message: "账号体系待接入（id.plutokeating.beer OIDC），当前为本地占位模式",
      },
    },
    501 as const,
  ),
);

auth.post("/logout", (c) => c.json({ ok: true }));
