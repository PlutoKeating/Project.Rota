import { parse, type DefaultTreeAdapterMap } from "parse5";
/** Read text outside exported HTML tables. No scripts, URLs or business extraction. */
export function outsideTableText(html: string): string {
  const skip = new Set(["table", "script", "style", "head", "template"]);
  const blocks = new Set(["br", "p", "div", "li", "section", "h1", "h2", "h3"]);
  function text(node: DefaultTreeAdapterMap["node"]): string {
    if ("tagName" in node && skip.has(node.tagName)) return "";
    if ("value" in node) return node.value;
    if (!("childNodes" in node)) return "";
    const value = node.childNodes.map(text).join("");
    return "tagName" in node && blocks.has(node.tagName)
      ? "\n" + value + "\n"
      : value;
  }
  return text(parse(html))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
