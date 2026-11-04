import {
  recordCoverage,
  completePages,
  type CoverageRead,
} from "../../shared/agent-import/coverage";
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
    const { renderSheet } = await import("./sheet-image");
    const rendered = await renderSheet(content);
    if (action === "ocr_image") {
      const { recognizeImage } = await import("./ocr");
      return {
        image: rendered.image,
        result: {
          ...(value.result as object),
          ocr: await recognizeImage(rendered.image),
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
    const value = await bitmap(file.blob, args);
    const info = value.result as {
      pages?: number;
      page?: number;
      coverage?: CoverageRead[];
    };
    const readCoverage = structuredClone(file.readCoverage ?? {});
    recordCoverage(readCoverage, info.coverage ?? []);
    await putMaterial(job.id, {
      ...file,
      inspected: true,
      totalPages: info.pages ?? file.totalPages,
      readCoverage,
      pagesRead: completePages(readCoverage),
    });
    if (action === "ocr_image") {
      const { recognizeImage } = await import("./ocr");
      const ocr = await recognizeImage(
        value.image,
        args.language as "chi_sim" | "eng" | "chi_sim+eng" | undefined,
        args.layout as "auto" | "sparse" | "block" | undefined,
      );
      return {
        ...value,
        result: {
          ...value.result,
          ocr,
          coordinateSpace:
            "OCR 行坐标相对此次裁剪后渲染图 renderedWidth × renderedHeight；crop 表示原图区域。OCR 可能错字，须与原图核对。",
        },
      };
    }
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
  const info = value.result as {
    pages?: number;
    page?: number;
    coverage?: CoverageRead[];
  };
  const readCoverage = structuredClone(file.readCoverage ?? {});
  recordCoverage(readCoverage, info.coverage ?? []);
  await putMaterial(job.id, {
    ...file,
    inspected: true,
    totalPages: info.pages ?? file.totalPages,
    readCoverage,
    pagesRead: completePages(readCoverage),
  });
  return {
    result: {
      content: value.result,
      derivedFiles: value.assets.map((a) => file.path + "!/" + a.path),
    },
  };
}

let documentQueue: Promise<unknown> = Promise.resolve();
export function documentTool(
  job: Job,
  action: string,
  args: Args,
): Promise<DocumentResult> {
  const next = documentQueue
    .catch(() => {})
    .then(() => documentToolImpl(job, action, args));
  documentQueue = next;
  return next;
}
