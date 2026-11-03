import { Hono } from "hono";
import type { Env } from "../env";
import { dbAll, optString } from "../lib/core";
import { listFairness } from "../domain/ledger";

const exportApi = new Hono<{ Bindings: Env }>();

const WEEKDAYS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const text = /^[\s]*[=+@-]/.test(raw) ? "'" + raw : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows: unknown[][]): string {
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function download(body: string, fileName: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
    },
  });
}

exportApi.get("/export/schedule.csv", async (c) => {
  const from = optString(c.req.query("from"), "from");
  const to = optString(c.req.query("to"), "to");
  const orgId = optString(c.req.query("orgId"), "orgId");

  const rows = await dbAll<{
    startsAt: string;
    endsAt: string;
    title: string;
    orgName: string | null;
    location: string | null;
    status: string;
    personName: string | null;
  }>(
    c.env.DB,
    `select s.starts_at, s.ends_at, t.title, o.name as org_name, s.location, s.status,
            group_concat(p.full_name, '、') as person_name
       from shift s
       join task t on t.id = s.task_id
       left join organization o on o.id = t.org_id
       left join assignment a on a.shift_id = s.id and a.status != 'declined'
       left join person p on p.id = a.person_id
      where (? is null or t.org_id = ?)
        and (? is null or s.starts_at >= ?)
        and (? is null or s.starts_at < ?)
      group by s.id
      order by s.starts_at`,
    orgId,
    orgId,
    from,
    from,
    to,
    to,
  );

  const body = csv([
    ["日期", "星期", "开始", "结束", "任务", "部门", "地点", "已排人", "状态"],
    ...rows.map((row) => {
      const date = row.startsAt.slice(0, 10);
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      return [
        date,
        WEEKDAYS[weekday === 0 ? 7 : weekday],
        row.startsAt.slice(11, 16),
        row.endsAt.slice(11, 16),
        row.title,
        row.orgName ?? "",
        row.location ?? "",
        row.personName ?? "",
        row.status,
      ];
    }),
  ]);

  return download(body, `rota-schedule-${new Date().toISOString().slice(0, 10)}.csv`);
});

exportApi.get("/export/fairness.csv", async (c) => {
  const orgId = optString(c.req.query("orgId"), "orgId");
  const windowKey = optString(c.req.query("windowKey"), "windowKey");
  const rows = await listFairness(c.env.DB, { orgId, windowKey });

  const body = csv([
    ["姓名", "部门", "窗口", "次数", "分钟", "结转", "上次被排"],
    ...rows.map((row) => [
      row.fullName,
      row.orgName ?? "",
      row.windowKey,
      row.shiftCount,
      row.minutes,
      row.carryOver,
      row.lastAssignedAt ?? "",
    ]),
  ]);

  return download(body, `rota-fairness-${new Date().toISOString().slice(0, 10)}.csv`);
});

export { exportApi };
