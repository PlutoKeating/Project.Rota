import { describe, expect, it, vi } from "vitest";
import { vertexFetch } from "./live/vertex";

describe("local Vertex test transport", () => {
  it("preserves the Google SDK payload and sends gcloud credentials only to the fixed Vertex endpoint", async () => {
    const upstream = vi.fn(async () => Response.json({ candidates: [] }));
    const getToken = vi.fn(async () => "test-oauth-token");
    const send = vertexFetch({ project: "test-project", getToken, upstream });
    const payload = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "source" }] }],
      tools: [{ functionDeclarations: [{ name: "tree" }] }],
    });
    await send(
      "https://vertex-test.invalid/v1beta/models/gemini-4-argon:generateContent?key=placeholder",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": "placeholder",
          "content-type": "application/json",
        },
        body: payload,
      },
    );
    const [url, options] = upstream.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-4-argon:generateContent",
    );
    expect(new Headers(options.headers).get("authorization")).toBe(
      "Bearer test-oauth-token",
    );
    expect(new Headers(options.headers).has("x-goog-api-key")).toBe(false);
    expect(options.body).toBe(payload);
    expect(options.redirect).toBe("manual");
  });
  it("does not read or attach credentials for unrelated requests", async () => {
    const getToken = vi.fn(async () => "secret");
    const upstream = vi.fn(async () => new Response("ok"));
    const send = vertexFetch({ project: "test-project", getToken, upstream });
    await send("https://example.test/resource");
    expect(getToken).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledWith(
      "https://example.test/resource",
      undefined,
    );
  });
  it("rejects arbitrary local proxy paths and invalid routing configuration", async () => {
    const getToken = vi.fn(async () => "secret");
    const send = vertexFetch({ project: "test-project", getToken });
    await expect(
      send("https://vertex-test.invalid/v1beta/other", { method: "POST" }),
    ).rejects.toThrow("Unsupported");
    expect(getToken).not.toHaveBeenCalled();
    expect(() => vertexFetch({ project: "bad/path", getToken })).toThrow(
      "Invalid",
    );
    expect(() =>
      vertexFetch({
        project: "test-project",
        location: "evil.example/",
        getToken,
      }),
    ).toThrow("Invalid");
  });
});
