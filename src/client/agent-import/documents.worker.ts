import SevenZip from "7z-wasm";
import wasmUrl from "7z-wasm/7zz.wasm?url";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import mammoth from "mammoth";
import { parseMsDoc } from "@file-viewer/doc";
import { parsePpt } from "@file-viewer/ppt";

const scope = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (value: unknown) => void;
};
const plain = (xml: string) =>
  xml
    .replace(/<\/(?:[\w]+:)?(?:p|tr|row|t)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const ext = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";
scope.onmessage = async ({ data }) => {
  try {
    const { path, bytes, action, args } = data;
    let suffix = ext(path);
    // Container signatures identify formats only; business interpretation stays with the Agent.
    const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8));
    if (action !== "unpack" && head[0] === 0xd0 && head[1] === 0xcf) {
      const container = XLSX.CFB.read(new Uint8Array(bytes), { type: "array" });
      const paths = container.FullPaths.join("\n");
      suffix = /WordDocument/.test(paths)
        ? "doc"
        : /PowerPoint Document/.test(paths)
          ? "ppt"
          : "xls";
    } else if (action !== "unpack" && head[0] === 0x50 && head[1] === 0x4b) {
      const container = await JSZip.loadAsync(bytes);
      suffix = container.file("word/document.xml")
        ? "docx"
        : container.file("ppt/presentation.xml")
          ? "pptx"
          : container.file("xl/workbook.xml")
            ? "xlsx"
            : "zip";
      if (suffix === "zip") throw Error("这是压缩文件，请调用 unpack 查看内容");
    }
    if (
      action !== "unpack" &&
      (["zip", "rar", "7z", "tar", "gz", "tgz"].includes(suffix) ||
        (head[0] === 0x37 && head[1] === 0x7a) ||
        (head[0] === 0x52 && head[1] === 0x61) ||
        (head[0] === 0x1f && head[1] === 0x8b))
    )
      throw Error("这是压缩文件，请调用 unpack 查看内容");
    let result: unknown;
    const assets: { path: string; bytes: Uint8Array; mime: string }[] = [];
    if (action === "unpack") {
      const lines: string[] = [];
      const seven = await SevenZip({
        locateFile: () => wasmUrl,
        print: (line: string) => lines.push(line),
        printErr: (line: string) => lines.push(line),
      });
      seven.FS.writeFile("/input", new Uint8Array(bytes));
      const password = "-p" + (args.password ?? "");
      const code = (seven.callMain as unknown as (args: string[]) => number)([
        "l",
        "-slt",
        password,
        "/input",
      ]);
      if (code !== 0) throw Error("压缩包无法列目录，可能需要密码或已经损坏");
      const listing = lines.join("\n");
      const sizes = [...listing.matchAll(/^Size = (\d+)$/gm)].map((x) =>
        Number(x[1]),
      );
      if (
        sizes.length > 1000 ||
        sizes.reduce((a, b) => a + b, 0) > 500 * 1024 * 1024
      )
        throw Error("压缩包展开超过 500 MB 或 1000 文件");
      if (/^Symbolic Link =|^Hard Link =/m.test(listing))
        throw Error("压缩包包含链接，不予展开");
      for (const m of listing.matchAll(/^Path = (.+)$/gm)) {
        if (m[1] === "/input") continue;
        const p = m[1].replace(/\\/g, "/");
        if (
          p.startsWith("/") ||
          p.split("/").includes("..") ||
          /^[a-z]:/i.test(p)
        )
          throw Error("压缩包包含不安全路径");
      }
      seven.FS.mkdir("/out");
      const exit = (seven.callMain as unknown as (args: string[]) => number)([
        "x",
        "-y",
        password,
        "-o/out",
        "/input",
      ]);
      if (exit !== 0)
        throw Error("解包失败：密码错误、格式损坏或存在不支持的加密方式");
      let total = 0;
      const walk = (dir: string) => {
        for (const name of seven.FS.readdir(dir)) {
          if (name === "." || name === "..") continue;
          const full = dir + "/" + name,
            stat = seven.FS.stat(full);
          if (seven.FS.isDir(stat.mode)) walk(full);
          else {
            const value = seven.FS.readFile(full);
            total += value.byteLength;
            if (total > 500 * 1024 * 1024 || assets.length >= 1000)
              throw Error("展开材料超过上限");
            assets.push({
              path: full.slice(5),
              bytes: value,
              mime: "application/octet-stream",
            });
          }
        }
      };
      walk("/out");
      result = {
        files: assets.map((x) => ({ path: x.path, size: x.bytes.length })),
      };
    } else if (["xlsx", "xls", "csv"].includes(suffix)) {
      if (suffix === "xlsx") {
        const zip = await JSZip.loadAsync(bytes);
        for (const n of Object.keys(zip.files).filter((n) =>
          /^xl\/media\/.+\.(png|jpe?g|webp)$/i.test(n),
        ))
          assets.push({
            path: n,
            bytes: await zip.files[n].async("uint8array"),
            mime: /\.png$/i.test(n)
              ? "image/png"
              : /\.webp$/i.test(n)
                ? "image/webp"
                : "image/jpeg",
          });
      }
      const book = XLSX.read(bytes, {
        type: "array",
        cellStyles: true,
        cellHTML: false,
        cellNF: true,
      });
      const sheet = args.sheet || book.SheetNames[0];
      if (!book.Sheets[sheet]) throw Error("工作表不存在");
      const ws = book.Sheets[sheet];
      const range = XLSX.utils.decode_range(args.range || ws["!ref"] || "A1");
      if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 2000) {
        range.e.r = Math.min(range.e.r, range.s.r + 49);
        range.e.c = Math.min(range.e.c, range.s.c + 19);
      }
      const cells = [];
      for (let r = range.s.r; r <= range.e.r; r++)
        for (let c = range.s.c; c <= range.e.c; c++) {
          const address = XLSX.utils.encode_cell({ r, c }),
            cell = ws[address];
          if (cell)
            cells.push({
              address,
              value: cell.w ?? cell.v,
              formula: cell.f,
              style: cell.s,
              comment: cell.c,
            });
        }
      result = {
        sheets: book.SheetNames,
        sheet,
        extent: ws["!ref"],
        range: XLSX.utils.encode_range(range),
        merges: ws["!merges"],
        cells,
      };
    } else if (suffix === "doc") {
      const doc = parseMsDoc(bytes);
      for (const a of doc.assets)
        if (a.type === "image" && a.mime.startsWith("image/"))
          assets.push({
            path: a.id + "." + (a.mime.split("/")[1] || "png"),
            bytes: a.bytes,
            mime: a.mime,
          });
      const serial = JSON.stringify(
        { blocks: doc.blocks, warnings: doc.warnings },
        (key, value) =>
          ["bytes", "dataUrl"].includes(key) ? undefined : value,
      );
      result = {
        text: serial.slice(args.offset, args.offset + 24000),
        total: serial.length,
        format: "MS-DOC structured blocks",
        nextOffset:
          args.offset + 24000 < serial.length ? args.offset + 24000 : null,
      };
    } else if (suffix === "ppt") {
      const doc = parsePpt(bytes);
      for (const a of doc.assets)
        if (a.mimeType.startsWith("image/"))
          assets.push({
            path: a.id + "." + (a.mimeType.split("/")[1] || "png"),
            bytes: a.bytes,
            mime: a.mimeType,
          });
      const page = doc.slides[args.page - 1];
      if (!page) throw Error("幻灯片不存在");
      const serial = JSON.stringify(page, (key, value) =>
        ["bytes", "dataUrl"].includes(key) ? undefined : value,
      );
      result = {
        page: args.page,
        pages: doc.slides.length,
        text: serial.slice(args.offset, args.offset + 24000),
        total: serial.length,
        nextOffset:
          args.offset + 24000 < serial.length ? args.offset + 24000 : null,
      };
    } else if (["docx", "pptx"].includes(suffix)) {
      const zip = await JSZip.loadAsync(bytes);
      const xmls = Object.keys(zip.files)
        .filter((n) =>
          suffix === "docx"
            ? /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(
                n,
              )
            : /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(
                n,
              ),
        )
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      let text = "";
      if (suffix === "docx")
        text = (await mammoth.extractRawText({ arrayBuffer: bytes })).value;
      for (const n of xmls)
        text += "\n[" + n + "]\n" + plain(await zip.files[n].async("string"));
      for (const n of Object.keys(zip.files).filter((n) =>
        /\/media\/.+\.(png|jpe?g|webp)$/i.test(n),
      )) {
        const value = await zip.files[n].async("uint8array");
        assets.push({
          path: n,
          bytes: value,
          mime: /\.png$/i.test(n)
            ? "image/png"
            : /\.webp$/i.test(n)
              ? "image/webp"
              : "image/jpeg",
        });
      }
      result = {
        text: text.slice(args.offset, args.offset + 24000),
        total: text.length,
        nextOffset:
          args.offset + 24000 < text.length ? args.offset + 24000 : null,
        images: assets.map((a) => a.path),
        note: "文本抽取不保证版式，课表需结合内嵌图片或原 XML 核对。",
        xml: xmls[args.page - 1]
          ? {
              path: xmls[args.page - 1],
              content: (
                await zip.files[xmls[args.page - 1]].async("string")
              ).slice(args.offset, args.offset + 24000),
              total: (await zip.files[xmls[args.page - 1]].async("string"))
                .length,
            }
          : null,
      };
    } else {
      const text = new TextDecoder(args.encoding || "utf-8").decode(bytes);
      result = {
        text: text.slice(args.offset, args.offset + 24000),
        total: text.length,
        nextOffset:
          args.offset + 24000 < text.length ? args.offset + 24000 : null,
      };
    }
    scope.postMessage({ result, assets });
  } catch (e) {
    scope.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
