import type { ListResponse, Org, Period, Term } from "../../shared/types";
import { api } from "./api";
import { useAsync, type AsyncState } from "./hooks";

/**
 * 多个页面都要用的基础资源。
 * 只封装「取列表 + 默认选当前学期」这一层，具体筛选仍由页面自己拼 query。
 */

export interface TermsState {
  terms: Term[];
  /** 优先 status=active，其次列表第一个。 */
  current: Term | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useTermsState(): TermsState {
  const state = useAsync(async () => api.get<ListResponse<Term>>("/terms"), []);
  const terms = state.data?.items ?? [];
  const current = terms.find((term) => term.status === "active") ?? terms[0] ?? null;
  return { terms, current, loading: state.loading, error: state.error, reload: state.reload };
}

export function usePeriodsState(termId: string | null): AsyncState<ListResponse<Period>> {
  return useAsync(
    async () => (termId ? api.get<ListResponse<Period>>(`/terms/${encodeURIComponent(termId)}/periods`) : { items: [] }),
    [termId],
  );
}

export function useOrgsState(): AsyncState<ListResponse<Org>> {
  return useAsync(async () => api.get<ListResponse<Org>>("/orgs"), []);
}
