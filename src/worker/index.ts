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
import { HttpError } from "./lib/core";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  console.error("[unhandled]", err);
  return c.json({ error: { code: "internal", message: "服务器内部错误" } }, 500);
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
