import type { Env } from "../env";
import { HttpError } from "../lib/core";
async function key(env: Env) {
  if (!env.PROVIDER_ENCRYPTION_KEY)
    throw new HttpError(
      503,
      "encryption_unavailable",
      "尚未配置模型密钥加密，请联系所有者",
    );
  const bytes = Uint8Array.from(atob(env.PROVIDER_ENCRYPTION_KEY), (c) =>
    c.charCodeAt(0),
  );
  if (bytes.length !== 32)
    throw new HttpError(503, "encryption_unavailable", "模型密钥加密配置无效");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(env),
    new TextEncoder().encode(value),
  );
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(encrypted)));
}
export async function unseal(env: Env, value: string) {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      await key(env),
      bytes.slice(12),
    ),
  );
}
