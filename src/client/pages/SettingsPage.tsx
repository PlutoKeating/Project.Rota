import { useEffect, useState } from "react";
import type {
  AppSettings,
  AuditEvent,
  ListResponse,
  LlmProvider,
  LlmProviderInput,
  LlmProviderKind,
  ScoreWeights,
} from "../../shared/types";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Checkbox, Field, Select, TextInput } from "../components/Field";
import { ListState } from "../components/ListState";
import { Modal } from "../components/Modal";
import { Spinner } from "../components/Spinner";
import { DataTable, type Column } from "../components/Table";
import { useToast } from "../components/Toast";
import { api, messageOf } from "../lib/api";
import { dateTimeText } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { PROVIDER_KIND_OPTIONS, providerKindLabel } from "../lib/labels";

const WEIGHT_FIELDS: { key: keyof ScoreWeights; label: string; hint: string }[] = [
  { key: "fairness", label: "公平（fairness）", hint: "目标次数与已排次数的缺口，权重越高越平均" },
  { key: "starvation", label: "饥饿（starvation）", hint: "从未被排、或超过 21 天没排过的人直接加分" },
  { key: "preference", label: "偏好（preference）", hint: "个人偏好加/减分，软约束" },
  { key: "priority", label: "优先级（priority）", hint: "人工指定优先级的权重" },
  { key: "recency", label: "连排惩罚（recency）", hint: "越靠近冷却期，扣分越多" },
];

const DEFAULT_WEIGHTS: ScoreWeights = {
  fairness: 0.45,
  starvation: 0.3,
  preference: 0.15,
  priority: 0.1,
  recency: 0.2,
};

interface ProviderModalProps {
  provider: LlmProvider | null;
  onClose: () => void;
  onSaved: () => void;
}

function ProviderModal({ provider, onClose, onSaved }: ProviderModalProps) {
  const toast = useToast();
  const [name, setName] = useState(provider?.name ?? "");
  const [kind, setKind] = useState<LlmProviderKind>(provider?.kind ?? "openai_compatible");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [model, setModel] = useState(provider?.model ?? "");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!name.trim()) {
      setError("请填写供应商名称");
      return;
    }
    if (!model.trim()) {
      setError("请填写模型名");
      return;
    }
    setError(null);

    const input: LlmProviderInput = {
      name: name.trim(),
      kind,
      model: model.trim(),
      baseUrl: baseUrl.trim() || undefined,
      enabled,
      ...(secret.trim() ? { apiKeySecret: secret.trim() } : {}),
    };

    setBusy(true);
    try {
      if (provider) {
        await api.patch(`/admin/llm-providers/${encodeURIComponent(provider.id)}`, input);
        toast.success("供应商已更新");
      } else {
        await api.post("/admin/llm-providers", input);
        toast.success("供应商已创建");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={provider ? "编辑 LLM 供应商" : "新增 LLM 供应商"}
      description="密钥只存 Worker Secret 的名字，不把明文写进数据库。"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            {provider ? "保存" : "创建"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名称" required error={error ?? undefined}>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="主模型" autoFocus />
        </Field>
        <Field label="类型">
          <Select value={kind} onChange={(event) => setKind(event.target.value as LlmProviderKind)}>
            {PROVIDER_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Base URL" hint="OpenAI 兼容服务填到 /v1 为止">
          <TextInput value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
        </Field>
        <Field label="模型" required>
          <TextInput value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" />
        </Field>
        <Field label="密钥名" hint={provider ? "留空表示不修改" : "例如 LLM_API_KEY"}>
          <TextInput value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="LLM_API_KEY" />
        </Field>
        <div className="flex items-end pb-1">
          <Checkbox label="启用" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        </div>
      </div>
    </Modal>
  );
}

function testResultText(result: unknown): { ok: boolean; message: string } {
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    const ok = record.ok !== false;
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : ok
            ? "连接测试通过"
            : "连接测试失败";
    return { ok, message };
  }
  return { ok: true, message: "连接测试通过" };
}

export function SettingsPage() {
  const toast = useToast();

  const [settingsVersion, setSettingsVersion] = useState(0);
  const [providerVersion, setProviderVersion] = useState(0);
  const [auditVersion, setAuditVersion] = useState(0);

  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<LlmProvider | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LlmProvider | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const settings = useAsync(async () => api.get<AppSettings>("/admin/settings"), [settingsVersion]);
  const providers = useAsync(async () => api.get<ListResponse<LlmProvider>>("/admin/llm-providers"), [providerVersion]);
  const audit = useAsync(async () => api.get<ListResponse<AuditEvent>>("/admin/audit?limit=20"), [auditVersion]);

  useEffect(() => {
    const data = settings.data;
    if (!data) return;
    setDraft({
      defaultCooldownDays: data.defaultCooldownDays ?? 3,
      exportIncludePhone: data.exportIncludePhone ?? false,
      importProviderId: data.importProviderId ?? null,
      weights: {
        fairness: data.weights?.fairness ?? DEFAULT_WEIGHTS.fairness,
        starvation: data.weights?.starvation ?? DEFAULT_WEIGHTS.starvation,
        preference: data.weights?.preference ?? DEFAULT_WEIGHTS.preference,
        priority: data.weights?.priority ?? DEFAULT_WEIGHTS.priority,
        recency: data.weights?.recency ?? DEFAULT_WEIGHTS.recency,
      },
    });
  }, [settings.data]);

  function updateWeight(key: keyof ScoreWeights, value: number): void {
    setDraft((previous) =>
      previous ? { ...previous, weights: { ...previous.weights, [key]: value } } : previous,
    );
  }

  async function saveSettings(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    try {
      await api.put("/admin/settings", draft);
      toast.success("排班参数已保存");
      setSettingsVersion((value) => value + 1);
      setAuditVersion((value) => value + 1);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  async function testProvider(provider: LlmProvider): Promise<void> {
    setTestingId(provider.id);
    try {
      const result = await api.post<unknown>(`/admin/llm-providers/${encodeURIComponent(provider.id)}/test`, {});
      const parsed = testResultText(result);
      if (parsed.ok) toast.success(parsed.message);
      else toast.error(parsed.message);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setTestingId(null);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/admin/llm-providers/${encodeURIComponent(deleteTarget.id)}`);
      toast.success("供应商已删除");
      setDeleteTarget(null);
      setProviderVersion((value) => value + 1);
      setAuditVersion((value) => value + 1);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setDeleting(false);
    }
  }

  const providerList = providers.data?.items ?? [];
  const providerColumns: Column<LlmProvider>[] = [
    {
      key: "name",
      header: "名称",
      render: (provider) => (
        <div className="min-w-0">
          <p className="font-medium">{provider.name}</p>
          <p className="text-[11px] text-slate-400">{providerKindLabel(provider.kind)}</p>
        </div>
      ),
    },
    {
      key: "model",
      header: "模型",
      render: (provider) => <span className="font-mono text-xs">{provider.model}</span>,
    },
    {
      key: "baseUrl",
      header: "Base URL",
      render: (provider) => (
        <span className="block max-w-[220px] truncate text-xs" title={provider.baseUrl ?? undefined}>
          {provider.baseUrl ?? "默认"}
        </span>
      ),
    },
    {
      key: "secret",
      header: "密钥名",
      render: (provider) => <span className="font-mono text-[11px]">{provider.apiKeySecret ?? "—"}</span>,
    },
    {
      key: "enabled",
      header: "启用",
      render: (provider) => (
        <Badge tone={provider.enabled ? "success" : "neutral"}>{provider.enabled ? "已启用" : "已停用"}</Badge>
      ),
    },
    {
      key: "action",
      header: "",
      className: "text-right whitespace-nowrap",
      render: (provider) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" loading={testingId === provider.id} onClick={() => void testProvider(provider)}>
            测试连接
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditingProvider(provider);
              setProviderModalOpen(true);
            }}
          >
            编辑
          </Button>
          <Button variant="ghost" size="sm" className="text-rose-600 hover:text-rose-700 dark:text-rose-400" onClick={() => setDeleteTarget(provider)}>
            删除
          </Button>
        </div>
      ),
    },
  ];

  const auditColumns: Column<AuditEvent>[] = [
    {
      key: "time",
      header: "时间",
      render: (event) => <span className="text-xs tabular-nums">{dateTimeText(event.createdAt)}</span>,
    },
    {
      key: "action",
      header: "动作",
      render: (event) => <span className="font-mono text-xs">{event.action}</span>,
    },
    {
      key: "target",
      header: "对象",
      render: (event) => (
        <span className="text-xs" title={event.targetId ?? undefined}>
          {event.targetType ?? "—"}
          {event.targetId ? ` · ${event.targetId.slice(0, 8)}` : ""}
        </span>
      ),
    },
    {
      key: "actor",
      header: "操作者",
      render: (event) => <span className="text-xs">{event.actorId ?? "系统"}</span>,
    },
    {
      key: "payload",
      header: "详情",
      render: (event) => {
        const text = event.payload ? JSON.stringify(event.payload) : "";
        return (
          <span className="block max-w-[260px] truncate font-mono text-[10px] text-slate-400" title={text}>
            {text || "—"}
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card title="排班参数" description="权重是拍出来的，先跑起来再调；每次修改都会落审计。" actions={<Button size="sm" loading={saving} disabled={!draft} onClick={() => void saveSettings()}>保存设置</Button>}>
        {settings.loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Spinner size="sm" />
            加载设置…
          </div>
        ) : settings.error ? (
          <ListState loading={false} error={settings.error} empty={false} onRetry={settings.reload}>
            <div />
          </ListState>
        ) : draft ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {WEIGHT_FIELDS.map((field) => (
                <div key={field.key} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{field.label}</span>
                    <span className="font-mono text-xs tabular-nums text-indigo-600 dark:text-indigo-400">
                      {draft.weights[field.key].toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.weights[field.key]}
                    onChange={(event) => updateWeight(field.key, Number(event.target.value))}
                    className="mt-2 w-full accent-indigo-600"
                    aria-label={field.label}
                  />
                  <p className="mt-1 text-[10px] text-slate-400">{field.hint}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="默认冷却天数" hint="0 表示不启用冷却">
                <TextInput
                  type="number"
                  min={0}
                  max={60}
                  value={draft.defaultCooldownDays}
                  onChange={(event) =>
                    setDraft((previous) =>
                      previous
                        ? { ...previous, defaultCooldownDays: Math.max(0, Number(event.target.value) || 0) }
                        : previous,
                    )
                  }
                />
              </Field>
              <Field label="导入默认 provider">
                <Select
                  value={draft.importProviderId ?? ""}
                  onChange={(event) =>
                    setDraft((previous) => (previous ? { ...previous, importProviderId: event.target.value || null } : previous))
                  }
                >
                  <option value="">不使用模型</option>
                  {providerList.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                      {provider.enabled ? "" : "（停用）"}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end pb-1">
                <Checkbox
                  label="导出包含手机号"
                  checked={draft.exportIncludePhone}
                  onChange={(event) =>
                    setDraft((previous) =>
                      previous ? { ...previous, exportIncludePhone: event.target.checked } : previous,
                    )
                  }
                />
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="暂时读不到设置" description="后端可能尚未实现 /admin/settings。" />
        )}
      </Card>

      <Card
        title="LLM 供应商"
        description="OpenAI 兼容 / Anthropic / Google / Workers AI；改完立刻写 KV 版本号。"
        actions={
          <Button
            size="sm"
            onClick={() => {
              setEditingProvider(null);
              setProviderModalOpen(true);
            }}
          >
            新增供应商
          </Button>
        }
      >
        <ListState
          loading={providers.loading}
          error={providers.error}
          empty={providerList.length === 0}
          onRetry={providers.reload}
          emptyTitle="还没有供应商"
          emptyDescription="截图解析需要至少一个可用的视觉模型 provider。"
          emptyAction={
            <Button
              size="sm"
              onClick={() => {
                setEditingProvider(null);
                setProviderModalOpen(true);
              }}
            >
              新增供应商
            </Button>
          }
        >
          <DataTable
            columns={providerColumns}
            rows={providerList}
            rowKey={(provider) => provider.id}
            minWidth="min-w-[860px]"
          />
        </ListState>
      </Card>

      <Card
        title="最近审计"
        description="最近 20 条写操作记录"
        actions={
          <Button variant="secondary" size="sm" onClick={() => setAuditVersion((value) => value + 1)}>
            刷新
          </Button>
        }
      >
        <ListState
          loading={audit.loading}
          error={audit.error}
          empty={(audit.data?.items.length ?? 0) === 0}
          onRetry={audit.reload}
          emptyTitle="还没有审计记录"
          emptyDescription="对学期、人员、任务等执行写操作后会出现在这里。"
        >
          <DataTable
            columns={auditColumns}
            rows={audit.data?.items ?? []}
            rowKey={(event) => event.id}
            minWidth="min-w-[820px]"
          />
        </ListState>
      </Card>

      {providerModalOpen ? (
        <ProviderModal
          provider={editingProvider}
          onClose={() => {
            setProviderModalOpen(false);
            setEditingProvider(null);
          }}
          onSaved={() => {
            setProviderVersion((value) => value + 1);
            setAuditVersion((value) => value + 1);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <Modal
          title="删除供应商"
          onClose={() => setDeleteTarget(null)}
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
                取消
              </Button>
              <Button variant="danger" loading={deleting} onClick={() => void confirmDelete()}>
                确认删除
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            确定删除「{deleteTarget.name}」？如果它被设为导入默认 provider，需要重新指定。
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
