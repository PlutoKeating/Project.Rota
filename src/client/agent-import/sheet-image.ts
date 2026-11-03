import { toPng } from "html-to-image";
import * as XLSX from "xlsx";
interface SheetView {
  sheet: string;
  range: string;
  cells: { address: string; value: unknown }[];
  merges?: XLSX.Range[];
  outsideTables?: { text: string };
}
/** Render explicit cell coordinates and merges. No course/person recognition occurs here. */
export async function renderSheet(view: SheetView) {
  const range = XLSX.utils.decode_range(view.range);
  const wrapper = document.createElement("div");
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.style.cssText =
    "position:fixed;left:-100000px;top:0;pointer-events:none";
  const root = document.createElement("div");
  root.style.cssText =
    "background:white;color:black;font:14px/1.45 Arial,sans-serif;padding:12px;box-sizing:border-box";
  root.style.width = (range.e.c - range.s.c + 1) * 180 + 64 + "px";
  const title = document.createElement("div");
  title.textContent = `${view.sheet} · ${view.range}（单元格坐标与合并关系，非原始打印版式）`;
  root.append(title);
  const table = document.createElement("table");
  table.style.cssText =
    "border-collapse:collapse;table-layout:fixed;width:100%;font:14px/1.45 Arial,sans-serif;color:black;background:white";
  const makeCell = (tag: "th" | "td", text: string) => {
    const cell = document.createElement(tag);
    cell.textContent = text;
    cell.style.cssText =
      "border:1px solid #777;padding:5px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere;font-weight:normal;background:white;color:black";
    return cell;
  };
  const header = table.insertRow();
  const corner = makeCell("th", "");
  corner.style.width = "40px";
  header.append(corner);
  for (let c = range.s.c; c <= range.e.c; c++)
    header.append(makeCell("th", XLSX.utils.encode_col(c)));
  const cells = new Map(view.cells.map((c) => [c.address, c.value]));
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = table.insertRow();
    row.append(makeCell("th", String(r + 1)));
    for (let c = range.s.c; c <= range.e.c; c++) {
      const merge = view.merges?.find(
        (m) => m.s.r <= r && m.e.r >= r && m.s.c <= c && m.e.c >= c,
      );
      if (
        merge &&
        (r !== Math.max(range.s.r, merge.s.r) ||
          c !== Math.max(range.s.c, merge.s.c))
      )
        continue;
      const cell = makeCell(
        "td",
        String(cells.get(XLSX.utils.encode_cell({ r, c })) ?? ""),
      );
      if (merge) {
        cell.rowSpan = Math.min(range.e.r, merge.e.r) - r + 1;
        cell.colSpan = Math.min(range.e.c, merge.e.c) - c + 1;
      }
      row.append(cell);
    }
  }
  root.append(table);
  if (view.outsideTables?.text) {
    const footer = document.createElement("div");
    footer.style.whiteSpace = "pre-wrap";
    footer.textContent = "表格外文本：\n" + view.outsideTables.text;
    root.append(footer);
  }
  wrapper.append(root);
  document.body.append(wrapper);
  try {
    const width = Math.ceil(root.getBoundingClientRect().width),
      height = Math.ceil(root.getBoundingClientRect().height);
    if (width > 4096 || height > 4096 || width * height > 12000000)
      throw Error(
        "表格渲染区域过大，请用 range 选择较小的单元格区域，分块查看并覆盖完整 extent",
      );
    const image = await toPng(root, {
      pixelRatio: 1,
      backgroundColor: "white",
      skipFonts: true,
    });
    return { image, width, height };
  } finally {
    wrapper.remove();
  }
}
