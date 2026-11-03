import { materials, putMaterial, type Job } from "./store";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

interface Args {
  path: string;
  offset?: number;
  page?: number;
  crop?: { x: number; y: number; width: number; height: number };
  scale?: number;
  [key: string]: unknown;
}
export interface DocumentResult {
  result: unknown;
  image?: string;
}
async function bitmap(blob: Blob, args: Args) {
  let canvas = document.createElement("canvas"),
    source: CanvasImageSource,
    width: number,
    height: number;
  let pages: number | undefined;
  let cleanup = () => {};
  if (args.format === "pdf" || /\.pdf$/i.test(args.path)) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
    const loading = pdfjs.getDocument({
      data: await blob.arrayBuffer(),
      useSystemFonts: true,
    });
    const pdf = await loading.promise;
    pages = pdf.numPages;
    const page = await pdf.getPage(args.page ?? 1),
      viewport = page.getViewport({ scale: 1.5 });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({
      canvas,
      canvasContext: canvas.getContext("2d")!,
      viewport,
    }).promise;
    source = canvas;
    width = canvas.width;
    height = canvas.height;
    cleanup = () => {
      void loading.destroy();
    };
  } else {
    const img = await createImageBitmap(blob);
    source = img;
    width = img.width;
    height = img.height;
    cleanup = () => img.close();
  }
  const crop = args.crop ?? { x: 0, y: 0, width, height };
  if (crop.x + crop.width > width || crop.y + crop.height > height)
    throw Error("裁剪超出图片范围");
  const factor = Math.min(
    args.scale ?? 1,
    4096 / Math.max(crop.width, crop.height),
  );
  const output = document.createElement("canvas");
  output.width = Math.ceil(crop.width * factor);
  output.height = Math.ceil(crop.height * factor);
  output
    .getContext("2d")!
    .drawImage(
      source,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      output.width,
      output.height,
    );
  cleanup();
  return {
    result: {
      path: args.path,
      width,
      height,
      crop,
      page: args.page ?? 1,
      pages,
    },
    image: output.toDataURL("image/png"),
  };
}
export async function documentTool(
  job: Job,
  action: string,
  args: Args,
): Promise<DocumentResult> {
  const files = await materials(job.id),
    file = files.find((f) => f.path === args.path);
  if (!file) throw Error("文件不存在");
  const head = new Uint8Array(await file.blob.slice(0, 12).arrayBuffer());
  const signature = String.fromCharCode(...head);
  const isPdf = signature.startsWith("%PDF-");
  const isImage =
    (head[0] === 0x89 && signature.slice(1, 4) === "PNG") ||
    (head[0] === 0xff && head[1] === 0xd8) ||
    signature.startsWith("GIF8") ||
    (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP");
  if (isPdf) args = { ...args, format: "pdf" };
  if (
    action === "view_image" ||
    isPdf ||
    isImage ||
    /\.(png|jpe?g|webp|gif|bmp|pdf)$/i.test(file.path)
  ) {
    const value = await bitmap(file.blob, args);
    const info = value.result as { pages?: number };
    await putMaterial(job.id, {
      ...file,
      inspected: true,
      totalPages: info.pages ?? file.totalPages,
      pagesRead: [...new Set([...(file.pagesRead ?? []), args.page ?? 1])],
    });
    return value;
  }
  if (action === "unpack" && file.path.split("!/").length > 8)
    throw Error("嵌套压缩包超过 8 层");
  const worker = new Worker(new URL("./documents.worker.ts", import.meta.url), {
    type: "module",
  });
  const value = await new Promise<{
    result: unknown;
    assets: { path: string; bytes: Uint8Array; mime: string }[];
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(Error("文件工具运行超时，可重试或在复核时补充材料"));
    }, 90000);
    worker.onmessage = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      if (e.data.error) reject(Error(e.data.error));
      else resolve(e.data);
    };
    worker.onerror = () => {
      clearTimeout(timeout);
      worker.terminate();
      reject(Error("本地文档工具加载失败，请刷新后重试"));
    };
    file.blob
      .arrayBuffer()
      .then((bytes) =>
        worker.postMessage(
          {
            action,
            path: file.path,
            bytes,
            args: { offset: 0, page: 1, ...args },
          },
          [bytes],
        ),
      )
      .catch(reject);
  });
  let size = files.reduce((sum, f) => sum + f.blob.size, 0);
  if (
    files.length +
      value.assets.filter(
        (a) => !files.some((f) => f.path === file.path + "!/" + a.path),
      ).length >
    1500
  )
    throw Error("展开后的文件数量超过上限");
  for (const asset of value.assets) {
    if (asset.path.startsWith("/") || asset.path.split("/").includes(".."))
      throw Error("文件路径不安全");
    const path = file.path + "!/" + asset.path;
    if (files.some((f) => f.path === path)) continue;
    size += asset.bytes.byteLength;
    if (size > 600 * 1024 * 1024) throw Error("展开材料超过 600 MB");
    await putMaterial(job.id, {
      path,
      origin: file.path,
      blob: new Blob([new Uint8Array(asset.bytes)], { type: asset.mime }),
    });
  }
  const info = value.result as { pages?: number };
  await putMaterial(job.id, {
    ...file,
    inspected: true,
    totalPages: info.pages ?? file.totalPages,
    pagesRead: [...new Set([...(file.pagesRead ?? []), args.page ?? 1])],
  });
  return {
    result: {
      content: value.result,
      derivedFiles: value.assets.map((a) => file.path + "!/" + a.path),
    },
  };
}
