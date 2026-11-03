import { Hono } from "hono";
import { listFairness, recomputeFairness } from "../domain/ledger";
import type { Env } from "../env";
import { optString, readJson } from "../lib/core";

const fairness = new Hono<{ Bindings: Env }>();

fairness.get("/fairness", async (c) => {
  const rows = await listFairness(c.env.DB, {
    orgId: optString(c.req.query("orgId"), "orgId"),
    windowKey: optString(c.req.query("windowKey"), "windowKey"),
  });
  return c.json({ items: rows });
});

fairness.post("/fairness/recompute", async (c) => {
  const body: { orgId?: string } = await readJson<{ orgId?: string }>(c).catch(() => ({}));
  const rows = await recomputeFairness(c.env.DB, { orgId: body.orgId ?? null });
  return c.json({ rows });
});

export { fairness };
