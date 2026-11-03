import type { ErrorBody } from "../../shared/types";

/**
 * 同源 API 客户端。
 *
 * 约定（见 docs/API.md）：
 * - 所有接口挂在 `/api` 下；
 * - 请求/响应都是 JSON（导入上传除外，用 FormData）；
 * - 失败统一 `{ error: { code, message } }`。
 *
 * 后端仍在并行开发，404/500 可能随时出现；这里把任何异常都收敛成
 * ApiError（带 status 与 code），页面只负责展示 message，不会白屏。
 */

const API_BASE = "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string";
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return "请求参数有误（400）";
    case 401:
      return "未登录或会话已过期（401）";
    case 403:
      return "没有权限执行该操作（403）";
    case 404:
      return "接口尚不存在或该资源已被删除（404）";
    case 409:
      return "操作与现有数据冲突（409）";
    case 500:
      return "服务器内部错误（500），请稍后重试";
    case 503:
      return "服务尚未就绪（503），请确认数据库已迁移";
    default:
      return `请求失败（HTTP ${status}）`;
  }
}

function toApiError(status: number, payload: unknown): ApiError {
  if (isErrorBody(payload)) {
    return new ApiError(status, payload.error.code, payload.error.message || fallbackMessage(status));
  }
  return new ApiError(status, status === 404 ? "not_found" : "http_error", fallbackMessage(status));
}

function apiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let payload: BodyInit | undefined;

  if (body instanceof FormData) {
    // 浏览器会自动补 multipart boundary，不能手写 Content-Type。
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers,
      body: payload,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "network", "网络不可达，请检查连接后重试");
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // SPA fallback 返回的 HTML / 网关错误页，说明路由压根没挂上。
      if (response.ok) {
        throw new ApiError(response.status, "bad_response", "接口返回了非 JSON 内容，可能尚未实现，请稍后重试");
      }
      data = null;
    }
  }

  if (response.status === 401) window.dispatchEvent(new Event("rota:unauthorized"));
  if (!response.ok) throw toApiError(response.status, data);
  return data as T;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>("GET", path);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("POST", path, body);
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("PATCH", path, body);
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("PUT", path, body);
  },
  del<T = void>(path: string, body?: unknown): Promise<T> {
    return request<T>("DELETE", path, body);
  },
};

/** 把任意异常转成可直接展示的中文文案。 */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "未知错误";
}
