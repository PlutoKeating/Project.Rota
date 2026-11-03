import { Hono } from "hono";
import type { Env, HealthResponse } from "./env";

const api = new Hono<{ Bindings: Env }>();

api.get("/health", async (c) => {
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

api.get("/terms", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "select id, name, start_date, week_count, status from term order by start_date desc",
    ).all();
    return c.json({ items: results ?? [] });
  } catch (error) {
    return c.json({ items: [], error: String(error) }, 500);
  }
});

const app = new Hono<{ Bindings: Env }>();
app.route("/api", api);

export default app;
