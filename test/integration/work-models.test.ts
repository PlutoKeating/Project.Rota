import { afterEach, describe, expect, it, vi } from "vitest";
import ddl from "../../migrations/0001_init.sql?raw";
import app from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createKv, D1Stub } from "../helpers/d1";
import { resolveProvider } from "../../src/worker/llm/gateway";
function env(): Env {
  return {
    DB: new D1Stub(ddl) as unknown as D1Database,
    CONFIG: createKv() as unknown as KVNamespace,
    ASSETS: {} as Fetcher,
    APP_ENV: "test",
    AUTH_DEV_BYPASS: "true",
    OIDC_ISSUER: "https://id.example",
    OIDC_CLIENT_ID: "test",
    PROVIDER_ENCRYPTION_KEY: btoa("a".repeat(32)),
  };
}
async function call(
  e: Env,
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await app.request(
    "/api" + path,
    {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    },
    e,
  );
  return { status: r.status, data: (await r.json()) as any };
}
afterEach(() => vi.unstubAllGlobals());
describe("work and models", () => {
  it('rejects duplicate personnel before any writes and creates membership atomically',async()=>{
   const e=env();const org=await call(e,'/orgs',{name:'导入部门',kind:'department'});
   const duplicate=await call(e,'/persons/import',{items:[{fullName:'甲',studentNo:'1'},{fullName:'乙',studentNo:'1'}],orgId:org.data.id});
   expect(duplicate.status).toBe(409);expect((await call(e,'/persons')).data.items).toHaveLength(0);
   const good=await call(e,'/persons/import',{items:[{fullName:'甲',studentNo:'1'}],orgId:org.data.id});expect(good.status).toBe(201);
   expect((await call(e,'/memberships')).data.items).toHaveLength(1);
  });

  it("creates work atomically, rejecting dates outside a term without leaving a task", async () => {
    const e = env();
    const org = await call(e, "/orgs", { name: "部门", kind: "department" });
    await call(e, "/terms", {
      name: "学期",
      startDate: "2026-09-07",
      weekCount: 4,
      periods: [{ periodIndex: 1, startTime: "08:00", endTime: "09:00" }],
    });
    const body = {
      title: "值班",
      orgId: org.data.id,
      startsAt: "2026-09-08T09:00:00+08:00",
      endsAt: "2026-09-08T10:00:00+08:00",
      requiredHeadcount: 2,
      repeatWeeks: 2,
    };
    const good = await call(e, "/work", body);
    expect(good.status).toBe(201);
    expect(good.data.shiftIds).toHaveLength(2);
    expect((await call(e, "/work", { ...body, repeatWeeks: 10 })).status).toBe(
      400,
    );
    expect((await call(e, "/tasks")).data.items).toHaveLength(1);
    expect(
      (await call(e, "/work", { ...body, startsAt: "invalid" })).status,
    ).toBe(400);
  });
  it("encrypts secrets, never returns ciphertext, preserves keys on edits and honors order", async () => {
    const e = env();
    const a = await call(e, "/admin/llm-providers", {
      name: "A",
      kind: "openai_compatible",
      baseUrl: "https://api.example/v1",
      model: "a",
      apiKey: "secret-a",
    });
    const b = await call(e, "/admin/llm-providers", {
      name: "B",
      kind: "openai_compatible",
      baseUrl: "https://api.example/v1",
      model: "b",
      apiKey: "secret-b",
    });
    expect(a.status).toBe(201);
    expect(JSON.stringify(a.data)).not.toContain("secret-a");
    expect(a.data.params.encryptedKey).toBeUndefined();
    expect(a.data.params.hasKey).toBe(true);
    await call(
      e,
      `/admin/llm-providers/${a.data.id}`,
      { params: { vision: true } },
      "PATCH",
    );
    expect((await resolveProvider(e, a.data.id)).apiKey).toBe("secret-a");
    await call(e, "/admin/model-order", { ids: [b.data.id, a.data.id] }, "PUT");
    expect((await resolveProvider(e)).model).toBe("b");
    expect(
      (await call(e, "/admin/model-order", { ids: ["missing"] }, "PUT")).status,
    ).toBe(400);
  });
  it("uses cached catalog on refresh outage", async () => {
    const e = env();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              demo: {
                name: "Demo",
                npm: "@ai-sdk/openai-compatible",
                api: "https://api.example/v1",
                models: {
                  vision: {
                    name: "Vision",
                    modalities: { input: ["text", "image"] },
                    limit: { context: 1000 },
                  },
                },
              },
            }),
          ),
        ),
    );
    const first = await call(e, "/admin/model-catalog");
    expect(first.status).toBe(200);
    expect(first.data.providers[0].models[0].vision).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const stale = await call(e, "/admin/model-catalog/refresh", {});
    expect(stale.data.stale).toBe(true);
    expect(stale.data.providers).toHaveLength(1);
  });
});
