import { Hono } from "hono";
import type { ShiftView } from "../../shared/types";
import { assignShift, autoAssignTask, DEFAULT_SCHEDULE_CONFIG, previewShift, unassign, type ScheduleConfig } from "../domain/scheduler";
import type { Env } from "../env";
import { asString, dbAll, notFound, optInt, optString, readJson } from "../lib/core";

const schedule = new Hono<{ Bindings: Env }>();

async function loadConfig(env: Env, override?: { cooldownDays?: number; weights?: ScheduleConfig["weights"] }): Promise<ScheduleConfig> {
  let stored: Partial<ScheduleConfig> = {};
  const raw = await env.CONFIG.get("settings");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { defaultCooldownDays?: number; weights?: ScheduleConfig["weights"] };
      stored = {
        cooldownDays: parsed.defaultCooldownDays,
        weights: parsed.weights,
      };
    } catch {
      stored = {};
    }
  }
  return {
    cooldownDays: override?.cooldownDays ?? stored.cooldownDays ?? DEFAULT_SCHEDULE_CONFIG.cooldownDays,
    weights: { ...DEFAULT_SCHEDULE_CONFIG.weights, ...stored.weights, ...override?.weights },
  };
}

schedule.get("/shifts", async (c) => {
  const from = optString(c.req.query("from"), "from");
  const to = optString(c.req.query("to"), "to");
  const orgId = optString(c.req.query("orgId"), "orgId");
  const status = optString(c.req.query("status"), "status");

  const rows = await dbAll<ShiftView & { taskTitle: string }>(
    c.env.DB,
    `select s.*, t.title as task_title, t.org_id
       from shift s
       join task t on t.id = s.task_id
      where (? is null or t.org_id = ?)
        and (? is null or s.status = ?)
        and (? is null or s.starts_at >= ?)
        and (? is null or s.starts_at < ?)
      order by s.starts_at
      limit 500`,
    orgId,
    orgId,
    status,
    status,
    from,
    from,
    to,
    to,
  );

  if (rows.length === 0) return c.json({ items: [] });

  const ids = rows.map((row) => row.id);
  const assignments = await dbAll<{
    id: string;
    shiftId: string;
    personId: string;
    status: string;
    score: number | null;
    reason: string | null;
    assignedAt: string | null;
    assignedBy: string | null;
    personName: string;
  }>(
    c.env.DB,
    `select a.id, a.shift_id, a.person_id, a.status, a.score, a.reason,
            a.assigned_at, a.assigned_by, p.full_name as person_name
       from assignment a
       join person p on p.id = a.person_id
      where a.shift_id in (${ids.map(() => "?").join(",")})
      order by a.assigned_at`,
    ...ids,
  );

  const byShift = new Map<string, typeof assignments>();
  for (const item of assignments) {
    const list = byShift.get(item.shiftId) ?? [];
    list.push(item);
    byShift.set(item.shiftId, list);
  }

  return c.json({
    items: rows.map((row) => ({ ...row, assignments: byShift.get(row.id) ?? [] })),
  });
});

schedule.post("/shifts/:id/preview", async (c) => {
  const shiftId = asString(c.req.param("id"), "id");
  const body = await readJson<{ cooldownDays?: number; weights?: ScheduleConfig["weights"] }>(c).catch(() => ({}));
  const config = await loadConfig(c.env, body);
  return c.json(await previewShift(c.env.DB, shiftId, config));
});

schedule.post("/shifts/:id/assign", async (c) => {
  const shiftId = asString(c.req.param("id"), "id");
  const body: { personId?: string; cooldownDays?: number; weights?: ScheduleConfig["weights"] } =
    await readJson<{ personId?: string; cooldownDays?: number; weights?: ScheduleConfig["weights"] }>(c).catch(() => ({}));
  const config = await loadConfig(c.env, body);
  const personId = typeof body.personId === "string" && body.personId ? body.personId : null;
  return c.json(await assignShift(c.env.DB, shiftId, personId, config, "local-owner"));
});

schedule.post("/tasks/:id/auto-assign", async (c) => {
  const taskId = asString(c.req.param("id"), "id");
  const body = await readJson<{ cooldownDays?: number; weights?: ScheduleConfig["weights"] }>(c).catch(() => ({}));
  const config = await loadConfig(c.env, body);
  return c.json(await autoAssignTask(c.env.DB, taskId, config, "local-owner"));
});

schedule.delete("/assignments/:id", async (c) => {
  const id = asString(c.req.param("id"), "id");
  const result = await unassign(c.env.DB, id, "local-owner");
  return c.json(result);
});

export { schedule };
