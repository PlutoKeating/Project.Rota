import { useEffect, useState } from "react";

export interface Route {
  /** 规范化后的路径，例如 `/`、`/tasks/01H...`。 */
  path: string;
  /** 去掉空段的路径片段，例如 `["tasks", "01H..."]`。 */
  segments: string[];
}

function readRoute(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  const withoutQuery = raw.split("?")[0] ?? "";
  const withSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const segments = withSlash.split("/").filter(Boolean);
  return { path: `/${segments.join("/")}`, segments };
}

/**
 * 手写 hash 路由。不引入 react-router：
 * 只有 9 个页面 + 两个详情页，hashchange 足够。
 */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const onChange = (): void => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    if (!window.location.hash) {
      // 首次进入没有 hash 时补一个，但不污染历史记录。
      window.history.replaceState(null, "", "#/");
    }
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

function toHash(path: string): string {
  if (path.startsWith("#")) return path;
  return `#${path.startsWith("/") ? path : `/${path}`}`;
}

/** 跳转到某个 hash 路径；App 会在路径变化时回到页首。 */
export function navigate(path: string): void {
  const next = toHash(path);
  if (window.location.hash === next) return;
  window.location.hash = next;
}
