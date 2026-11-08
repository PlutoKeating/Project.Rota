import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Native Node service is intentionally JavaScript.
import { createDataServer, openDatabase } from "../../storage/server.mjs";
import app from "../../src/worker/index";
import {
  diff,
  materialize,
  applyChanges,
  mutate,
  canonical,
  type Snapshot,
  type Evidence,
} from "../../src/shared/agent-import/model";

it("commits a 19-person batch through the data service without shipping expanded events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rota-scale-"));
  const db = openDatabase(join(dir, "rota.sqlite"));
  const auth = "x".repeat(32);
  const server = createDataServer({ db, authorization: auth, files: join(dir, "files") });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const env = {
    APP_ENV: "development",
    AUTH_DEV_BYPASS: "true",
    DATA_SERVICE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    DATA_SERVICE_AUTHORIZATION: auth,
  } as never;
  let largest = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/query")) largest = Math.max(largest, String(init?.body ?? "").length);
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(
        "/api" + path,
        { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
        env,
      );
      return { status: res.status, data: (await res.json()) as any };
    };
    const snap = await call("GET", "/agent-imports/snapshot");
    expect(snap.status, JSON.stringify(snap.data)).toBe(200);
    const base = snap.data.data as Snapshot;
    const s = structuredClone(base);
    const periods = Array.from({ length: 12 }, (_, i) => ({
      index: i + 1,
      start: `${String(8 + i).padStart(2, "0")}:00`,
      end: `${String(8 + i).padStart(2, "0")}:45`,
    }));
    mutate(s, "term", "create", { name: "秋", start_date: "2026-08-31", week_count: 18 }, "term");
    for (const p of periods)
      mutate(s, "class_period", "create", { term_id: "term", period_index: p.index, start_time: p.start, end_time: p.end }, "period" + p.index);
    mutate(s, "timetable_profile", "create", { term_id: "term", name: "作息", periods: JSON.stringify(periods) }, "profile");
    for (let p = 0; p < 19; p++) {
      mutate(s, "person", "create", { full_name: "人" + p, class_name: "会计2601" }, "p" + p);
      for (let k = 0; k < 20; k++)
        mutate(s, "timetable_entry", "create", {
          person_id: "p" + p,
          term_id: "term",
          profile_id: "profile",
          name: "课程" + k,
          weekday: (k % 7) + 1,
          period_from: (k % 6) * 2 + 1,
          period_to: Math.min(12, (k % 6) * 2 + 1 + (k % 3)),
          weeks: JSON.stringify(k % 2 ? [1, 3, 5, 7, 9, 11, 13, 15, 17] : Array.from({ length: 16 }, (_, w) => w + 1)),
          teacher: "老师",
          location: "教室" + k,
        }, `e${p}-${k}`);
    }
    const evidence: Record<string, Evidence[]> = {};
    for (const [entity, rows] of Object.entries(s))
      for (const r of rows)
        evidence[entity + ":" + r.id] = [{ source: "a.png", locator: "整图", explanation: "材料明确记载", inferred: false }];
    const changes = diff(base, s, evidence);
    const id = (await call("POST", "/agent-imports")).data.id;
    expect((await call("POST", `/agent-imports/${id}/lease`, { changes })).status).toBe(200);
    const applied = await call("POST", `/agent-imports/${id}/apply`, { changes, summary: "规模" });
    expect(applied.status, applied.data?.error?.message).toBe(200);

    const expected = materialize(applyChanges(base, changes), base).timetable_event;
    const actual = db.prepare("SELECT * FROM timetable_event").all() as Record<string, unknown>[];
    expect(expected.length).toBeGreaterThan(5000);
    const key = (rows: Record<string, unknown>[]) =>
      rows.map((r) => canonical({ ...r })).sort();
    expect(key(actual)).toEqual(key(expected));
    // Events no longer travel as JSON rows: every request stays far below the tunnel's budget.
    expect(largest).toBeLessThan(600_000);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
