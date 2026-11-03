import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useState, type ReactNode } from "react";
import type { LlmProvider } from "../../shared/types";
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
  const [refresh, setRefresh] = useState(0);
  const directory = useAsync(
    () =>
      refresh
        ? api.post<Catalog>("/admin/model-catalog/refresh")
        : api.get<Catalog>("/admin/model-catalog"),
    [refresh],
  );
  const configured = useAsync(
    () => api.get<ModelConfig>("/admin/model-config"),
    [],
  );
  const [baseline, setBaseline] = useState<ModelConfig | null>(null);
  const [draft, setDraft] = useState<DraftModel[]>([]);
  useEffect(() => {
    if (configured.data) {
      setBaseline(configured.data);
      setDraft(configured.data.items);
    }
  }, [configured.data]);
  const dirty =
    !!baseline && JSON.stringify(draft) !== JSON.stringify(baseline.items);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const reduced = useReducedMotion();
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
      if (dirty || key || chosen.length || replacement) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, key, chosen, replacement]);
  const provider = directory.data?.providers.find((p) => p.id === providerId);
  function edit(id: string, patch: Partial<DraftModel>) {
    setDraft((rows) => rows.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }
  function move(id: string, index: number) {
    setDraft((rows) =>
      arrayMove(
        rows,
        rows.findIndex((p) => p.id === id),
        index,
      ),
    );
  }
  async function saveAll() {
    if (!baseline) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api.put<ModelConfig>("/admin/model-config", {
        expectedVersion: baseline.version,
        items: draft,
      });
      setBaseline(saved);
      setDraft(saved.items);
      toast.success("模型配置已保存");
    } catch (e) {
      setError(messageOf(e) + " 你的草稿仍保留，可重试保存。");
    } finally {
      setBusy(false);
    }
  }
  function addModels() {
    if (!provider || !chosen.length) return;
    setDraft((rows) => [
      ...rows,
      ...chosen.map((model) => ({
        id: crypto.randomUUID(),
        name: provider.name,
        kind: provider.kind as LlmProvider["kind"],
        baseUrl: provider.baseUrl || null,
        model,
        enabled: true,
        apiKeySecret: null,
        updatedAt: null,
        ...(key ? { apiKey: key } : {}),
        params: {
          catalogId: provider.id,
          vision: provider.models.find((m) => m.id === model)!.vision,
        },
      })),
    ]);
    setAdding(false);
    setKey("");
    setChosen([]);
  }
  const pendingInput = !!(key || chosen.length || replacement);
  // Keep the draft on this page when a navigation control would unmount it.
  useEffect(() => {
    const guard = (event: MouseEvent) => {
      if (!(dirty || pendingInput) || !(event.target instanceof Element))
        return;
      const target = event.target.closest(
        'button[data-settings-tab]:not([data-settings-tab="models"])',
      );
      if (target && !confirm("有未保存的模型配置，确定离开并放弃更改？")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const hash = window.location.hash;
    const routeGuard = (event: HashChangeEvent) => {
      if (
        (dirty || pendingInput) &&
        window.location.hash !== hash &&
        !confirm("有未保存的模型配置，确定离开并放弃更改？")
      ) {
        history.replaceState(null, "", hash);
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("click", guard, true);
    window.addEventListener("hashchange", routeGuard, true);
    return () => {
      document.removeEventListener("click", guard, true);
      window.removeEventListener("hashchange", routeGuard, true);
    };
  }, [dirty, pendingInput]);
  return (
    <div className="min-w-0 space-y-6 pb-6">
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">模型服务</h2>
            <p className="mt-1 text-sm text-slate-500">
              从目录选择，粘贴密钥，即可接入截图识别。
            </p>
          </div>
          <Button
            disabled={busy || configured.loading || !baseline}
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
            <span role="status">
              {directory.error || directory.data?.error}
            </span>
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
            description="先加入草稿，再统一保存。密钥仅保留在当前页面内存中。"
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
                            {m.id} · {m.vision ? "图片输入" : "文本输入"} ·
                            上下文 {m.context.toLocaleString()}
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
                onClick={addModels}
              >
                加入 {chosen.length || ""} 个模型
              </Button>
            </div>
          </Card>
        )}
        <p className="text-sm text-slate-500">
          拖动抓手调整调用顺序，也可使用上移、下移。所有更改在保存后生效；指定的导入模型仍优先调用。
        </p>
        <ListState
          loading={configured.loading}
          error={configured.error}
          empty={!draft.length}
          onRetry={configured.reload}
          emptyTitle="连接第一个模型"
          emptyDescription="选择供应商并勾选图片模型，课表截图就能进入识别与确认流程。"
          emptyAction={
            <Button onClick={() => setAdding(true)}>添加供应商</Button>
          }
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            accessibility={{
              screenReaderInstructions: {
                draggable:
                  "按空格抓起模型，方向键调整位置，再按空格放下；Escape 取消。",
              },
              announcements: {
                onDragStart: () => "已抓起模型",
                onDragOver: ({ over }) =>
                  over
                    ? `目标位置 ${draft.findIndex((p) => p.id === over.id) + 1}`
                    : "移回列表以放下",
                onDragEnd: () => "排序已更新，请保存配置",
                onDragCancel: () => "已取消排序",
              },
            }}
            onDragStart={({ active }) => setDrag(String(active.id))}
            onDragCancel={() => setDrag(null)}
            onDragEnd={({ active, over }) => {
              if (over && active.id !== over.id)
                move(
                  String(active.id),
                  draft.findIndex((p) => p.id === over.id),
                );
              setDrag(null);
            }}
          >
            <SortableContext
              items={draft.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-3">
                {draft.map((p, i) => (
                  <ModelRow
                    key={p.id}
                    id={p.id}
                    label={`${p.name} / ${p.model}`}
                    entering={p.updatedAt === null}
                    disabled={busy}
                    reduced={reduced}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h3 className="font-semibold">{p.name}</h3>
                        <p className="mt-1 break-all text-sm">{p.model}</p>
                        <p className="mt-2 text-xs text-slate-500">
                          {p.params?.vision === true ? "支持图片 · " : ""}
                          {p.apiKey
                            ? "密钥待保存"
                            : p.params?.hasKey
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
                            edit(p.id, { enabled: e.target.checked })
                          }
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy || dirty || !p.enabled}
                          title={dirty ? "保存配置后测试连接" : undefined}
                          onClick={async () => {
                            setBusy(true);
                            setError("");
                            try {
                              const r = await api.post<{
                                ok: boolean;
                                message: string;
                              }>(`/admin/llm-providers/${p.id}/test`);
                              if (!r.ok) throw new Error(r.message);
                              toast.success("连接测试通过");
                            } catch (e) {
                              setError(messageOf(e));
                            } finally {
                              setBusy(false);
                            }
                          }}
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
                          disabled={busy || i === draft.length - 1}
                          onClick={() => void move(p.id, i + 1)}
                        >
                          下移
                        </Button>
                        {p.kind !== "cloudflare_ai" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
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
                            setDraft((rows) =>
                              rows.filter((row) => row.id !== p.id),
                            );
                            if (editId === p.id) {
                              setEditId(null);
                              setReplacement("");
                            }
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
                          onClick={() => {
                            edit(p.id, { apiKey: replacement });
                            setReplacement("");
                            setEditId(null);
                          }}
                        >
                          应用到草稿
                        </Button>
                      </div>
                    )}
                  </ModelRow>
                ))}
              </div>
            </SortableContext>
            <DragOverlay
              dropAnimation={
                reduced
                  ? null
                  : { duration: 280, easing: "cubic-bezier(.2,1.25,.4,1)" }
              }
            >
              {drag ? (
                <div className="rounded-xl bg-white p-5 shadow-lg dark:bg-slate-900">
                  <strong>{draft.find((p) => p.id === drag)?.name}</strong>
                  <p className="break-all text-sm">
                    {draft.find((p) => p.id === drag)?.model}
                  </p>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </ListState>
      </fieldset>
      {baseline && (
        <div className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-3 border-t border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <div role="status" className="text-sm">
            <strong>{dirty || pendingInput ? "有未保存更改" : "已同步"}</strong>
            <p className="mt-1 text-xs text-slate-500">
              {pendingInput
                ? "请先将填写内容加入草稿，再保存配置。"
                : dirty
                  ? "保存后生效；测试连接需先保存。"
                  : "可直接拖动排序或编辑模型。"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={busy || (!dirty && !pendingInput)}
              onClick={() => {
                if (!confirm("放弃所有未保存的模型更改？")) return;
                setDraft(baseline.items);
                setKey("");
                setChosen([]);
                setReplacement("");
                setEditId(null);
                setAdding(false);
                setError("");
                configured.reload();
              }}
            >
              放弃更改
            </Button>
            <Button
              loading={busy}
              disabled={!dirty || pendingInput || configured.loading}
              onClick={() => void saveAll()}
            >
              保存配置
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type DraftModel = LlmProvider & { apiKey?: string };
interface ModelConfig {
  version: string;
  items: LlmProvider[];
}
function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(mq.matches);
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  return reduced;
}
function ModelRow({
  id,
  label,
  entering,
  disabled,
  reduced,
  children,
}: {
  id: string;
  label: string;
  entering: boolean;
  disabled: boolean;
  reduced: boolean;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled,
    transition: reduced
      ? null
      : { duration: 280, easing: "cubic-bezier(.2,1.25,.4,1)" },
  });
  return (
    <article
      ref={setNodeRef}
      data-model-id={id}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.35 : 1,
        animation: entering
          ? `model-insert ${reduced ? 0 : 220}ms cubic-bezier(.16,1,.3,1)`
          : undefined,
      }}
      className="relative flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900 sm:gap-4 sm:p-5"
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label={`拖动排序 ${label}`}
        className="flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-indigo-500 active:cursor-grabbing dark:hover:bg-slate-800"
        style={{ cursor: disabled ? "default" : "grab", touchAction: "none" }}
      >
        <svg
          aria-hidden="true"
          width="20"
          height="24"
          viewBox="0 0 20 24"
          fill="currentColor"
        >
          {[6, 12, 18].flatMap((y) =>
            [7, 13].map((x) => (
              <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />
            )),
          )}
        </svg>
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </article>
  );
}
