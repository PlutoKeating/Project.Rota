import type { Env } from "../env";
import { HttpError } from "../lib/core";
export interface CatalogProvider {
  id: string;
  name: string;
  kind: string | null;
  baseUrl: string;
  models: { id: string; name: string; vision: boolean; toolCalling?: boolean; context: number }[];
}
export async function catalog(env: Env, force = false): Promise<{fetchedAt:string;providers:CatalogProvider[];stale:boolean;error?:string}> {
  const raw = await env.CONFIG.get("llm:catalog:v2");
  let cached: { fetchedAt: string; providers: CatalogProvider[] } | null = null;
  try {
    cached = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < 3600_000)
    return { ...cached, stale: false };
  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
      headers: {
        "User-Agent": "Project.Rota model catalog",
        Accept: "application/json",
      },
    });
    if (!response.ok) throw new Error("目录服务暂不可用");
    const data = (await response.json()) as Record<
      string,
      {
        id: string;
        name: string;
        npm?: string;
        api?: string;
        models?: Record<
          string,
          {
            id: string;
            name: string;
            tool_call?: boolean;
            modalities?: { input?: string[] };
            limit?: { context?: number };
          }
        >;
      }
    >;
    const providers = Object.entries(data)
      .map(([id, p]) => ({
        id,
        name: p.name || id,
        kind:
          id === "cloudflare-workers-ai"
            ? "cloudflare_ai"
            : p.npm === "@ai-sdk/anthropic"
              ? "anthropic"
              : p.npm === "@ai-sdk/google"
                ? "google"
                : ["@ai-sdk/openai-compatible", "@ai-sdk/openai"].includes(
                      p.npm ?? "",
                    )
                  ? "openai_compatible"
                  : null,
        baseUrl: (
          p.api ??
          (
            {
              openai: "https://api.openai.com/v1",
              anthropic: "https://api.anthropic.com",
              google: "https://generativelanguage.googleapis.com",
            } as Record<string, string>
          )[id] ??
          ""
        ).replace(
          p.npm === "@ai-sdk/google"
            ? /\/v1beta\/?$/
            : p.npm === "@ai-sdk/anthropic"
              ? /\/v1\/?$/
              : /\/$/,
          "",
        ),
        models: Object.entries(p.models ?? {}).map(([mid, m]) => ({
          id: m.id || mid,
          name: m.name || mid,
          vision: m.modalities?.input?.includes("image") ?? false,
          toolCalling: m.tool_call,
          context: m.limit?.context ?? 0,
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!providers.length) throw new Error("目录为空");
    // models.dev describes models; the provider's own Go list determines routable IDs.
    const go = providers.find((p) => p.id === "opencode-go");
    let warning: string | undefined;
    if (go) {
      try {
        const response = await fetch(
          "https://opencode.ai/inference/go/v1/models",
          {
            signal: AbortSignal.timeout(10000),
            redirect: "manual",
            headers: {
              "User-Agent": "Project.Rota/0.1.0",
              Accept: "application/json",
            },
          },
        );
        if (!response.ok) throw new Error("Go directory unavailable");
        const body = (await response.json()) as { data?: { id?: unknown }[] };
        if (
          !Array.isArray(body.data) ||
          body.data.some((m) => !m || typeof m.id !== "string")
        )
          throw new Error("Invalid Go directory");
        const available = new Set(body.data.map((m) => m.id));
        go.models = go.models.filter((m) => available.has(m.id));
      } catch {
        const previous = cached?.providers.find((p) => p.id === "opencode-go");
        const available = new Set(previous?.models.map((m) => m.id) ?? []);
        go.models = go.models.filter((m) => available.has(m.id));
        warning = previous
          ? "OpenCode Go 可用型号刷新失败，暂用上次验证的列表"
          : "OpenCode Go 可用型号目录暂不可用，请稍后刷新；已有配置仍可使用";
      }
    }
    const result = { fetchedAt: new Date().toISOString(), providers };
    if (!warning)
      await env.CONFIG.put("llm:catalog:v2", JSON.stringify(result));
    return {
      ...result,
      stale: !!warning,
      ...(warning ? { error: warning } : {}),
    };
  } catch {
    if (cached)
      return {
        ...cached,
        stale: true,
        error: "刷新失败，正在使用上次成功获取的目录",
      };
    throw new HttpError(
      502,
      "catalog_unavailable",
      "模型目录暂不可用，请稍后刷新；已有配置仍可使用",
    );
  }
}
