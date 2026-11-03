import { Hono } from "hono";
import type { HealthResponse } from "../shared/types";
import { admin } from "./api/admin";
import { auth } from "./api/auth";
import { courses } from "./api/courses";
import { exportApi } from "./api/export";
import { fairness } from "./api/fairness";
import { imports } from "./api/imports";
import { people } from "./api/people";
import { schedule } from "./api/schedule";
import { tasks } from "./api/tasks";
import { terms } from "./api/terms";
import type { Env } from "./env";
import { getCurrentUser, requireSameOrigin } from "./auth";
import { HttpError } from "./lib/core";

import { remoteData } from "./remote-data";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  console.error("[unhandled]", err);
  return c.json({ error: { code: "internal", message: "服务器内部错误" } }, 500);
});

app.use("/api/*", async (c, next) => {
  if (c.env.DATA_SERVICE_URL) c.env = { ...c.env, ...remoteData(c.env) };
  await next();
});

app.get("/api/health", async (c) => {
  let db: "up" | "down" = "down";
  try {
    const row = await c.env.DB.prepare("select 1 as ok").first<{ ok: number }>();
    if (row?.ok === 1) db = "up";
  } catch {
    db = "down";
  }
  const body: HealthResponse = {
    ok: db === "up",
    env: c.env.APP_ENV,
    db,
    ts: new Date().toISOString(),
  };
  return c.json(body, db === "up" ? 200 : 503);
});

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.path.startsWith("/api/auth/")) return next();
  const user = await getCurrentUser(c);
  if (!user) throw new HttpError(401, "unauthorized", "请先登录");
  c.set("user", user);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) requireSameOrigin(c);
  await next();
});

app.route("/api", terms);
app.route("/api", people);
app.route("/api", courses);
app.route("/api/imports", imports);
app.route("/api/admin", admin);
app.route("/api/auth", auth);
app.route("/api", tasks);
app.route("/api", schedule);
app.route("/api", fairness);
app.route("/api", exportApi);

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: { code: "not_found", message: `接口不存在：${c.req.path}` } }, 404);
  }
  return c.text("Not Found", 404);
});

export default app;
