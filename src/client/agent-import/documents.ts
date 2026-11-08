import {
  recordCoverage,
  completePages,
  type CoverageRead,
} from "../../shared/agent-import/coverage";
import { materials, putMaterial, type Job, type Material } from "./store";
import { Gate } from "./limiter";
import { canonical } from "../../shared/agent-import/model";
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
  try {
    if (args.format === "pdf" || /\.pdf$/i.test(args.path)) {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
      const loading = pdfjs.getDocument({
        data: await blob.arrayBuffer(),
        useSystemFonts: true,
      });
      cleanup = () => {
        void loading.destroy();
      };
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
      if ((args.page ?? 1) !== 1)
        throw Error(
          "单张图片只有 page=1；图片内的多页排版请用 crop 坐标查看，不存在独立的 page=2",
        );
      pages = 1;
      const img = await createImageBitmap(blob);
      source = img;
      width = img.width;
      height = img.height;
      cleanup = () => img.close();
    }
    const requested = args.crop ?? { x: 0, y: 0, width, height };
    if (
      requested.x < 0 ||
      requested.y < 0 ||
      requested.x >= width ||
      requested.y >= height ||
      requested.width <= 0 ||
      requested.height <= 0
    )
      throw Error(
        `裁剪起点超出原图范围：原图 ${width} × ${height}，x 须小于 ${width}，y 须小于 ${height}，宽高须为正数。`,
      );
    const crop = {
      ...requested,
      width: Math.min(requested.width, width - requested.x),
      height: Math.min(requested.height, height - requested.y),
    };
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
    return {
      result: {
        path: args.path,
        width,
        height,
        crop,
        clipped:
          crop.width !== requested.width || crop.height !== requested.height,
        renderedWidth: output.width,
        renderedHeight: output.height,
        page: args.page ?? 1,
        pages,
        coverage: [
          {
            key: `page:${args.page ?? 1}`,
            extent: [0, 0, width, height],
            region: [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height],
          },
        ] satisfies CoverageRead[],
      },
      image: output.toDataURL("image/png"),
    };
  } finally {
    cleanup();
  }
}
// ---- Shared execution resources -------------------------------------------
// Tool results are pure functions of (file bytes, action, args); actors that
// read the same shared sheet or page reuse one in-flight or finished result.
const CACHE_BUDGET = 150_000_000;
const cache = new Map<string, { value: Promise<unknown>; size: number }>();
let cached = 0;
function sizeOf(value: any): number {
  let size = typeof value?.image === "string" ? value.image.length : 0;
  for (const asset of value?.assets ?? []) size += asset.bytes?.byteLength ?? 0;
  try {
    size += JSON.stringify(value?.result ?? value ?? null).length;
  } catch {
    size += 1000;
  }
  return size;
}
function memo<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value as Promise<T>;
  }
  const entry = { value: make() as Promise<unknown>, size: 0 };
  cache.set(key, entry);
  entry.value.then(
    (value) => {
      if (cache.get(key) !== entry) return;
      entry.size = sizeOf(value);
      cached += entry.size;
      for (const [k, e] of cache) {
        if (cached <= CACHE_BUDGET || k === key) break;
        cache.delete(k);
        cached -= e.size;
      }
    },
    () => {
      // Never cache failures; a later call may succeed (e.g. after a timeout).
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return entry.value as Promise<T>;
}
const keyOf = (jobId: string, file: Material, kind: string, args: unknown) =>
  [jobId, file.path, file.blob.size, kind, canonical(args)].join("\u0000");

// Canvas rendering runs on the main thread; bound it so parallel actors do not
// allocate dozens of full-page bitmaps at once.
const canvasGate = new Gate(2);

// Reusable parser workers. A worker is replaced only after timeout or crash.
const POOL = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const workerGate = new Gate(POOL);
const idleWorkers: Worker[] = [];
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function runWorker(
  file: Material,
  action: string,
  args: Args,
): Promise<{
  result: unknown;
  assets: { path: string; bytes: Uint8Array; mime: string }[];
}> {
  return workerGate.run(async () => {
    clearTimeout(idleTimer);
    const worker =
      idleWorkers.pop() ??
      new Worker(new URL("./documents.worker.ts", import.meta.url), {
        type: "module",
      });
    let healthy = true;
    try {
      const bytes = await file.blob.arrayBuffer();
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          healthy = false;
          reject(Error("文件工具运行超时，可重试或在复核时补充材料"));
        }, 90000);
        worker.onmessage = (e) => {
          clearTimeout(timeout);
          if (e.data.error) reject(Error(e.data.error));
          else resolve(e.data);
        };
        worker.onerror = () => {
          clearTimeout(timeout);
          healthy = false;
          reject(Error("本地文档工具加载失败：页面版本可能已更新，请暂停后刷新页面再继续"));
        };
        worker.postMessage(
          {
            action,
            path: file.path,
            bytes,
            args: { offset: 0, page: 1, ...args },
          },
          [bytes],
        );
      });
    } finally {
      worker.onmessage = worker.onerror = null;
      if (healthy) idleWorkers.push(worker);
      else worker.terminate();
      idleTimer = setTimeout(() => {
        for (const w of idleWorkers.splice(0)) w.terminate();
      }, 60000);
    }
  });
}

// Material records are read-modify-write; commit them one at a time against
// the latest stored row so parallel readers never drop each other's coverage.
let commits: Promise<unknown> = Promise.resolve();
function commit<T>(fn: () => Promise<T>): Promise<T> {
  const next = commits.catch(() => {}).then(fn);
  commits = next;
  return next;
}
function recordRead(
  jobId: string,
  path: string,
  info: { pages?: number; coverage?: CoverageRead[] },
) {
  return commit(async () => {
    const file = (await materials(jobId)).find((f) => f.path === path);
    if (!file) return;
    const readCoverage = structuredClone(file.readCoverage ?? {});
    recordCoverage(readCoverage, info.coverage ?? []);
    await putMaterial(jobId, {
      ...file,
      inspected: true,
      totalPages: info.pages ?? file.totalPages,
      readCoverage,
      pagesRead: completePages(readCoverage),
    });
  });
}
function ocr(
  jobId: string,
  file: Material,
  args: Args,
  image: string,
  language?: "chi_sim" | "eng" | "chi_sim+eng",
  layout?: "auto" | "sparse" | "block",
) {
  return memo(keyOf(jobId, file, "ocr", { args, language, layout }), async () => {
    const { recognizeImage } = await import("./ocr");
    return recognizeImage(image, language, layout);
  });
}

async function documentToolImpl(
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
    action === "render_sheet" ||
    (["view_image", "ocr_image"].includes(action) &&
      /\.(xlsx?|csv)$/i.test(file.path))
  ) {
    if (args.crop)
      throw Error(
        "表格请用 render_sheet 的 range 按单元格区域放大，不使用图片像素 crop",
      );
    const value = await documentToolImpl(job, "read_document", args);
    const content = (value.result as { content?: any }).content;
    if (!content?.cells || !content?.range)
      throw Error("此文档不是可渲染的工作表，请用 read_document 读取");
    const rendered = await memo(keyOf(job.id, file, "sheet", args), () =>
      canvasGate.run(async () => {
        const { renderSheet } = await import("./sheet-image");
        return renderSheet(content);
      }),
    );
    if (action === "ocr_image") {
      return {
        image: rendered.image,
        result: {
          ...(value.result as object),
          ocr: await ocr(job.id, file, args, rendered.image),
        },
      };
    }
    return {
      image: rendered.image,
      result: {
        ...(value.result as object),
        renderedWidth: rendered.width,
        renderedHeight: rendered.height,
      },
    };
  }
  if (
    action === "view_image" ||
    action === "ocr_image" ||
    isPdf ||
    isImage ||
    /\.(png|jpe?g|webp|gif|bmp|pdf)$/i.test(file.path)
  ) {
    const { language, layout, ...view } = args;
    const value = await memo(keyOf(job.id, file, "bitmap", view), () =>
      canvasGate.run(() => bitmap(file.blob, view as Args)),
    );
    await recordRead(job.id, file.path, value.result as any);
    if (action === "ocr_image") {
      return {
        ...value,
        result: {
          ...value.result,
          ocr: await ocr(
            job.id,
            file,
            view as Args,
            value.image,
            language as "chi_sim" | "eng" | "chi_sim+eng" | undefined,
            layout as "auto" | "sparse" | "block" | undefined,
          ),
          coordinateSpace:
            "OCR 行坐标相对此次裁剪后渲染图 renderedWidth × renderedHeight；crop 表示原图区域。OCR 可能错字，须与原图核对。",
        },
      };
    }
    return value;
  }
  if (action === "unpack" && file.path.split("!/").length > 8)
    throw Error("嵌套压缩包超过 8 层");
  // Unpacking writes new materials and runs once; parsing is cached.
  const value =
    action === "unpack"
      ? await runWorker(file, action, args)
      : await memo(keyOf(job.id, file, "worker:" + action, args), () =>
          runWorker(file, action, args),
        );
  await commit(async () => {
    const files = await materials(job.id);
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
  });
  await recordRead(job.id, file.path, value.result as any);
  return {
    result: {
      content: value.result,
      derivedFiles: value.assets.map((a) => file.path + "!/" + a.path),
    },
  };
}

/** Parallel, cached document tools (worker pool + bounded canvas work). */
export function documentTool(
  job: Job,
  action: string,
  args: Args,
): Promise<DocumentResult> {
  return documentToolImpl(job, action, args);
}
