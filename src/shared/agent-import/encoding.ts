/** Format decoding only: no identities, course semantics, or business values are inferred. */
export function decodeDocumentText(
  input: Uint8Array | ArrayBuffer,
  requested = "auto",
) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let encoding = requested;
  if (encoding === "auto") {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
    else {
      const header = new TextDecoder("windows-1252").decode(
        bytes.slice(0, 4096),
      );
      encoding =
        /charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(header)?.[1] ?? "utf-8";
      if (encoding === "utf-8") {
        try {
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            bytes,
          );
        } catch {
          encoding = "gb18030";
        }
      }
    }
  }
  return { encoding, text: new TextDecoder(encoding).decode(bytes) };
}
