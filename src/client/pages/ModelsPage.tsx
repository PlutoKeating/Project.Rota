import { useEffect, useState } from "react";
import type {
  LlmProvider,
  ListResponse,
} from "../../shared/types";
import { api, messageOf } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { Button } from "../components/Button";
import { Field, TextInput, Select, Checkbox } from "../components/Field";
import { Card } from "../components/Card";
import { ListState } from "../components/ListState";
import { useToast } from "../components/Toast";
interface Catalog {
  fetchedAt: string;
  stale: boolean;
  error?: string;
  providers: {
    id: string;
    name: string;
    kind: string | null;
    baseUrl: string;
    models: { id: string; name: string; vision: boolean; context: number }[];
  }[];
}
export function ModelsPage() {
  const toast = useToast();
  const [version, setVersion] = useState(0),
    [refresh, setRefresh] = useState(0);
  const directory = useAsync(
    () =>
      refresh
        ? api.post<Catalog>("/admin/model-catalog/refresh")
        : api.get<Catalog>("/admin/model-catalog"),
    [refresh],
  );
  const configured = useAsync(async () => {
    const [p, o] = await Promise.all([
      api.get<ListResponse<LlmProvider>>("/admin/llm-providers"),
      api.get<{ ids: string[] }>("/admin/model-order"),
    ]);
    return p.items.sort(
      (a, b) =>
        (o.ids.indexOf(a.id) < 0 ? 999 : o.ids.indexOf(a.id)) -
        (o.ids.indexOf(b.id) < 0 ? 999 : o.ids.indexOf(b.id)),
    );
  }, [version]);
  const [adding, setAdding] = useState(false),
    [providerId, setProviderId] = useState(""),
    [query, setQuery] = useState(""),
    [key, setKey] = useState(""),
    [chosen, setChosen] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [vision, setVision] = useState(true),
    [drag, setDrag] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null),
    [replacement, setReplacement] = useState("");
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (adding && (key || chosen.length)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [adding, key, chosen]);
  const provider = directory.data?.providers.find((p) => p.id === providerId);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
    }
  }
  async function move(id: string, index: number) {
    const ids = (configured.data ?? []).map((p) => p.id);
    ids.splice(ids.indexOf(id), 1);
    ids.splice(index, 0, id);
    await action(() => api.put("/admin/model-order", { ids }));
  }
  async function save() {
    if (!provider || !chosen.length) return;
    await action(async () => {
      const remaining = [...chosen];
      for (const model of chosen) {
        const m = provider.models.find((m) => m.id === model)!;
        await api.post("/admin/llm-providers", {
          name: provider.name,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          model,
          enabled: true,
          ...(key ? { apiKey: key } : {}),
          params: { catalogId: provider.id, vision: m.vision },
        });
        remaining.splice(remaining.indexOf(model), 1);
        setChosen([...remaining]);
      }
      setAdding(false);
      setKey("");
      toast.success("模型已保存，可测试连接后开始使用");
    });
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">模型服务</h2>
          <p className="mt-1 text-sm text-slate-500">
            从目录选择，粘贴密钥，即可接入截图识别。
          </p>
        </div>
        <Button
          onClick={() => {
            if (
              !adding ||
              (!key && !chosen.length) ||
              confirm("放弃尚未保存的模型配置？")
            ) {
              setAdding(!adding);
              setKey("");
              setChosen([]);
            }
          }}
        >
          {adding ? "收起添加" : "添加供应商"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-y border-slate-200 py-3 text-xs dark:border-slate-800">
        <a
          href="https://models.dev"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          models.dev
        </a>
        <span>
          {directory.loading
            ? "正在同步目录…"
            : directory.data
              ? `更新于 ${new Date(directory.data.fetchedAt).toLocaleString()} · ${directory.data.providers.length} 家供应商`
              : "目录暂不可用"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={directory.loading}
          onClick={() => setRefresh((v) => v + 1)}
        >
          刷新目录
        </Button>
        {(directory.error || directory.data?.error) && (
          <span role="status">{directory.error || directory.data?.error}</span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-rose-600">
          {error}
        </p>
      )}
      {adding && (
        <Card
          title="连接模型服务"
          description="保存后立即生效。密钥加密存储，不会再次显示。"
        >
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-4">
              <Field label="供应商">
                <Select
                  value={providerId}
                  onChange={(e) => {
                    setProviderId(e.target.value);
                    setChosen([]);
                    setKey("");
                    setQuery("");
                  }}
                >
                  <option value="">选择供应商</option>
                  {directory.data?.providers
                    .filter(
                      (p) =>
                        p.kind && (p.baseUrl || p.kind === "cloudflare_ai"),
                    )
                    .map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                </Select>
              </Field>
              {provider && (
                <>
                  <Field
                    label="API 密钥"
                    hint={
                      provider.kind === "cloudflare_ai"
                        ? "Workers AI 使用已绑定服务，无需密钥"
                        : "直接粘贴密钥；不会写入浏览器存储"
                    }
                  >
                    <TextInput
                      type="password"
                      autoComplete="new-password"
                      value={key}
                      disabled={provider.kind === "cloudflare_ai"}
                      onChange={(e) => setKey(e.target.value)}
                    />
                  </Field>
                  <p className="break-all text-xs text-slate-500">
                    服务地址：{provider.baseUrl || "Workers AI 绑定"}
                  </p>
                </>
              )}
            </div>
            <div className="space-y-3">
              <TextInput
                placeholder="搜索模型名称"
                aria-label="搜索模型"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Checkbox
                label="只显示支持图片输入的模型"
                checked={vision}
                onChange={(e) => setVision(e.target.checked)}
              />
              <div className="max-h-80 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
                {provider?.models
                  .filter(
                    (m) =>
                      (!vision || m.vision) &&
                      (m.name + " " + m.id)
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  )
                  .map((m) => (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-start gap-3 py-3"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={chosen.includes(m.id)}
                        onChange={(e) =>
                          setChosen(
                            e.target.checked
                              ? [...chosen, m.id]
                              : chosen.filter((id) => id !== m.id),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="block break-words font-medium">
                          {m.name}
                        </span>
                        <span className="block break-all text-xs text-slate-500">
                          {m.id} · {m.vision ? "图片输入" : "文本输入"} · 上下文{" "}
                          {m.context.toLocaleString()}
                        </span>
                      </span>
                    </label>
                  ))}
                {provider &&
                  !provider.models.some(
                    (m) =>
                      (!vision || m.vision) &&
                      (m.name + " " + m.id)
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  ) && (
                    <p className="py-6 text-sm text-slate-500">
                      没有匹配模型，试试关闭图片筛选或更换搜索词。
                    </p>
                  )}
              </div>
            </div>
          </div>
          <div className="mt-5 flex justify-end">
            <Button
              loading={busy}
              disabled={
                !chosen.length || (!key && provider?.kind !== "cloudflare_ai")
              }
              onClick={() => void save()}
            >
              保存 {chosen.length || ""} 个模型
            </Button>
          </div>
        </Card>
      )}
      <p className="text-sm text-slate-500">
        拖拽或使用上移、下移调整默认调用顺序。指定了导入模型时，优先使用指定模型；停用模型不参与调用。
      </p>
      <ListState
        loading={configured.loading}
        error={configured.error}
        empty={!configured.data?.length}
        onRetry={configured.reload}
        emptyTitle="连接第一个模型"
        emptyDescription="选择供应商并勾选图片模型，课表截图就能进入识别与确认流程。"
        emptyAction={
          <Button onClick={() => setAdding(true)}>添加供应商</Button>
        }
      >
        <div className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {configured.data?.map((p, i) => (
            <article
              key={p.id}
              draggable={!busy}
              onDragStart={() => setDrag(p.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (drag && drag !== p.id) void move(drag, i);
                setDrag(null);
              }}
              className="py-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="font-semibold">{p.name}</h3>
                  <p className="mt-1 break-all text-sm">{p.model}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    {p.params?.vision === true ? "支持图片 · " : ""}
                    {p.params?.hasKey
                      ? "密钥已加密"
                      : p.kind === "cloudflare_ai"
                        ? "使用 Workers AI 绑定"
                        : "使用已有 Secret"}{" "}
                    · {p.enabled ? "已启用" : "已停用"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Checkbox
                    label="启用"
                    checked={p.enabled}
                    disabled={busy}
                    onChange={(e) =>
                      void action(() =>
                        api.patch(`/admin/llm-providers/${p.id}`, {
                          enabled: e.target.checked,
                        }),
                      )
                    }
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || !p.enabled}
                    onClick={() =>
                      void action(async () => {
                        const r = await api.post<{
                          ok: boolean;
                          message: string;
                        }>(`/admin/llm-providers/${p.id}/test`);
                        if (!r.ok) throw new Error(r.message);
                        toast.success("连接测试通过");
                      })
                    }
                  >
                    测试连接
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || i === 0}
                    onClick={() => void move(p.id, i - 1)}
                  >
                    上移
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || i === (configured.data?.length ?? 0) - 1}
                    onClick={() => void move(p.id, i + 1)}
                  >
                    下移
                  </Button>
                  {p.kind !== "cloudflare_ai" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditId(editId === p.id ? null : p.id);
                        setReplacement("");
                      }}
                    >
                      更换密钥
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`删除 ${p.name} / ${p.model}？`))
                        void action(() =>
                          api.del(`/admin/llm-providers/${p.id}`),
                        );
                    }}
                  >
                    删除
                  </Button>
                </div>
              </div>
              {editId === p.id && (
                <div className="mt-4 flex gap-2">
                  <TextInput
                    aria-label="新密钥"
                    type="password"
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                    autoComplete="new-password"
                  />
                  <Button
                    disabled={!replacement || busy}
                    onClick={() =>
                      void action(async () => {
                        await api.patch(`/admin/llm-providers/${p.id}`, {
                          apiKey: replacement,
                        });
                        setReplacement("");
                        setEditId(null);
                      })
                    }
                  >
                    保存密钥
                  </Button>
                </div>
              )}
            </article>
          ))}
        </div>
      </ListState>
    </div>
  );
}
