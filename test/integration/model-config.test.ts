import { describe, expect, it } from "vitest";
import ddl from "../../migrations/0001_init.sql?raw";
import app from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { D1Stub } from "../helpers/d1";
function setup() {
  const DB = new D1Stub(
    ddl + ";CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  ) as unknown as D1Database;
  const env = {
    DB,
    CONFIG: {
      get: async (key: string) =>
        (
          await DB.prepare("select value from app_kv where key=?")
            .bind(key)
            .first<{ value: string }>()
        )?.value ?? null,
      put: async (key: string, value: string) => {
        await DB.prepare(
          "insert into app_kv values (?,?) on conflict(key) do update set value=excluded.value",
        )
          .bind(key, value)
          .run();
      },
    },
    APP_ENV: "test",
    AUTH_DEV_BYPASS: "true",
    PROVIDER_ENCRYPTION_KEY: btoa("a".repeat(32)),
  } as unknown as Env;
  const call = async (
    path: string,
    body?: unknown,
    method = body ? "PUT" : "GET",
  ) => {
    const r = await app.request(
      "/api/admin/" + path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      },
      env,
    );
    return { status: r.status, data: (await r.json()) as any };
  };
  return { call, DB };
}
const model = (id: string) => ({
  id,
  name: id,
  kind: "openai_compatible",
  baseUrl: "https://api.example/v1",
  model: id,
  enabled: true,
  apiKey: "private-test-key",
  params: { vision: true },
});
describe("whole-page model draft persistence", () => {
  it("saves models, order, encrypted keys and audit together, preserves keys and deletes locally removed rows", async () => {
    const { call, DB } = setup();
    const initial = await call("model-config");
    const saved = await call("model-config", {
      expectedVersion: initial.data.version,
      items: [model("a"), model("b")],
    });
    expect(saved.status).toBe(200);
    expect(saved.data.items.map((p: any) => p.id)).toEqual(["a", "b"]);
    expect(JSON.stringify(saved.data)).not.toContain("private-test-key");
    expect(saved.data.items[0].params.hasKey).toBe(true);
    const ciphertext = await DB.prepare(
      "select params from llm_provider where id=?",
    )
      .bind("b")
      .first<{ params: string }>();
    const changed = await call("model-config", {
      expectedVersion: saved.data.version,
      items: [{ ...saved.data.items[1], enabled: false }],
    });
    expect(changed.status).toBe(200);
    expect(changed.data.items).toHaveLength(1);
    expect((await call("model-order")).data.ids).toEqual(["b"]);
    expect(
      await DB.prepare("select params from llm_provider where id=?")
        .bind("b")
        .first(),
    ).toEqual(ciphertext);
    expect(
      (
        await DB.prepare("select count(*) as n from audit_event where action=?")
          .bind("admin.llm_config.update")
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
    expect(
      (
        await call("model-config", {
          expectedVersion: saved.data.version,
          items: [],
        })
      ).status,
    ).toBe(409);
    expect((await call("model-config")).data.items).toHaveLength(1);
  });
  it("validates the whole draft before writing and detects legacy edits", async () => {
    const { call } = setup();
    const baseline = (await call("model-config")).data;
    expect(
      (
        await call("model-config", {
          expectedVersion: baseline.version,
          items: [model("a"), { ...model("b"), model: "" }],
        })
      ).status,
    ).toBe(400);
    expect((await call("model-config")).data).toEqual(baseline);
    await call("llm-providers", model("legacy"), "POST");
    expect(
      (
        await call("model-config", {
          expectedVersion: baseline.version,
          items: [],
        })
      ).status,
    ).toBe(409);
  });
  it("allows only one concurrent writer of the same snapshot", async () => {
    const { call } = setup();
    const initial = (await call("model-config")).data;
    const writes = await Promise.all(
      ["a", "b"].map((id) =>
        call("model-config", {
          expectedVersion: initial.version,
          items: [model(id)],
        }),
      ),
    );
    expect(writes.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await call("model-config")).data.items).toHaveLength(1);
  });
  it("rolls back all rows and order if the transactional audit write fails", async () => {
    const { call, DB } = setup();
    const baseline = (await call("model-config")).data;
    await DB.prepare(
      "create trigger audit_failure before insert on audit_event begin select raise(abort, 'test_failure'); end",
    ).run();
    expect(
      (
        await call("model-config", {
          expectedVersion: baseline.version,
          items: [model("a")],
        })
      ).status,
    ).toBe(500);
    expect((await call("model-config")).data).toEqual(baseline);
  });
});
