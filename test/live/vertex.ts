import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const origin = "https://vertex-test.invalid";

/** Local test transport only: the existing Google SDK owns the request/response protocol. */
export function vertexFetch({
  project,
  location = "global",
  getToken,
  upstream = fetch,
}: {
  project: string;
  location?: string;
  getToken: (refresh?: boolean) => Promise<string>;
  upstream?: typeof fetch;
}): typeof fetch {
  if (
    !/^[a-z][a-z0-9-]{4,62}$/.test(project) ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(location)
  )
    throw Error("Invalid Vertex project/location");
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin) return upstream(input, init);
    const match = url.pathname.match(
      /^\/v1beta\/models\/([a-zA-Z0-9._-]+):(generateContent|streamGenerateContent)$/,
    );
    if (!match || request.method !== "POST")
      throw Error("Unsupported local Vertex request");
    const host =
      location === "global"
        ? "aiplatform.googleapis.com"
        : `${location}-aiplatform.googleapis.com`;
    const target = new URL(
      `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${match[1]}:${match[2]}`,
    );
    if (url.searchParams.get("alt") === "sse")
      target.searchParams.set("alt", "sse");
    const headers = new Headers(request.headers);
    headers.delete("x-goog-api-key");
    const body = await request.text();
    for (let attempt = 0; ; attempt++) {
      headers.set("authorization", `Bearer ${await getToken(attempt > 0)}`);
      const response = await upstream(target, {
        method: "POST",
        headers: new Headers(headers),
        body,
        signal: request.signal,
        redirect: "manual",
      });
      if (response.status !== 401 || attempt > 0 || request.signal.aborted)
        return response;
      await response.body?.cancel();
    }
  };
}

export async function vertexTestEnvironment() {
  const project =
    process.env.ROTA_VERTEX_PROJECT ||
    (await exec("gcloud", ["config", "get-value", "project"])).stdout.trim();
  const location = process.env.ROTA_VERTEX_LOCATION || "global";
  const model = process.env.ROTA_LIVE_MODEL || "gemini-4-argon";
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw Error("Invalid Vertex model ID");
  let cachedToken = "",
    refreshAt = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = vertexFetch({
    project,
    location,
    upstream: previousFetch,
    getToken: async (refresh = false) => {
      if (refresh || Date.now() >= refreshAt) {
        cachedToken = (
          await exec("gcloud", ["auth", "print-access-token"], {
            timeout: 30000,
          })
        ).stdout.trim();
        if (!cachedToken) throw Error("gcloud returned no access token");
        // gcloud may return a cached token with less than an hour remaining.
        refreshAt = Date.now() + 5 * 60000;
      }
      return cachedToken;
    },
  });
  const provider = {
    id: "vertex-local",
    name: "本机 Vertex",
    kind: "google",
    base_url: origin + "/v1beta",
    model,
    api_key_secret: "VERTEX_TEST_PLACEHOLDER",
    enabled: 1,
    params: JSON.stringify({ vision: true, toolCalling: true }),
  };
  return {
    env: {
      VERTEX_TEST_PLACEHOLDER: "local-transport-placeholder",
      DB: {
        prepare(sql: string) {
          if (
            !/^\s*select\b/i.test(sql) ||
            !/\bfrom\s+llm_provider\b/i.test(sql)
          )
            throw Error("Vertex test permits in-memory provider reads only");
          const statement = {
            bind: () => statement,
            first: async (column?: keyof typeof provider) =>
              column ? provider[column] : provider,
            all: async () => ({ results: [provider] }),
          };
          return statement;
        },
      },
      CONFIG: {
        get: async (key: string) =>
          key === "llm:order" ? JSON.stringify([provider.id]) : null,
      },
    },
    model,
    restore() {
      globalThis.fetch = previousFetch;
      cachedToken = "";
    },
  };
}
