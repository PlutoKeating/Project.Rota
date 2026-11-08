import type { ModelMessage } from "ai";
import { dropDuplicateImages } from "../../shared/agent-import/context";

// Originals remain in the material store. Bound only the model transport copies,
// including images restored from checkpoints created before this budget existed.
export async function fitImagePayload(messages: ModelMessage[], total = 8000000): Promise<ModelMessage[]> {
  messages = dropDuplicateImages(messages);
  const count = messages.reduce((n, m) => n + (m.role === "user" && Array.isArray(m.content)
    ? m.content.filter((p) => p.type === "image" && typeof p.image === "string" && p.image.startsWith("data:")).length : 0), 0);
  if (!count) return messages;
  const budget = Math.floor(Math.min(1500000, total / count));
  return Promise.all(messages.map(async (m): Promise<ModelMessage> => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const content = [];
    for (const p of m.content) {
      if (p.type !== "image" || typeof p.image !== "string" || !p.image.startsWith("data:") || p.image.length <= budget) {
        content.push(p);
        continue;
      }
      const bitmap = await createImageBitmap(await (await fetch(p.image)).blob());
      try {
        const canvas = document.createElement("canvas");
        let scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
        let encoded = "";
        do {
          canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
          canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          encoded = canvas.toDataURL("image/jpeg", 0.9);
          scale *= 0.8;
        } while (encoded.length > budget && canvas.width > 1 && canvas.height > 1);
        if (encoded.length > budget) throw Error("图片传输预算不足，请分批读取材料");
        content.push({ ...p, image: encoded, mediaType: "image/jpeg" });
        content.push({ type: "text" as const, text: `此图为传输预览 ${canvas.width}×${canvas.height}，原读取图为 ${bitmap.width}×${bitmap.height}。原件及工具坐标不变；小字看不清时按原图坐标裁剪读取，不得猜测。` });
      } finally {
        bitmap.close();
      }
    }
    return { ...m, content };
  }));
}
