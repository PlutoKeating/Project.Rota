import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "./api";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 重新拉取当前资源。 */
  reload: () => void;
}

/**
 * 列表/详情通用的数据加载 hook。
 *
 * `loader` 不放进依赖数组（否则每次渲染都会重新请求），
 * 调用方需要把所有入参放进 `deps`，例如 `useAsync(load, [termId, week])`。
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((err: unknown) => {
        if (alive) {
          setData(null);
          setError(messageOf(err));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // deps 由调用方声明，这里额外加 tick 用于手动重载。
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  return { data, loading, error, reload };
}

/** 输入防抖，搜索框用。 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
