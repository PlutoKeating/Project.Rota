import { ModelsPage } from "./ModelsPage";
import { TermsPage } from "./TermsPage";
import { AdminUsers } from "../components/AdminUsers";
import { useEffect, useState } from "react";
import type {
  AppSettings,
  AuditEvent,
  ListResponse,
  LlmProvider,
  MealBlock,
  ScoreWeights,
} from "../../shared/types";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Checkbox, Field, Select, TextInput } from "../components/Field";
import { ListState } from "../components/ListState";
import { Spinner } from "../components/Spinner";
import { DataTable, type Column } from "../components/Table";
import { useToast } from "../components/Toast";
import { api, messageOf } from "../lib/api";
import { dateTimeText } from "../lib/format";
import { useAsync } from "../lib/hooks";

const WEIGHT_FIELDS: {
  key: keyof ScoreWeights;
  label: string;
  hint: string;
}[] = [
  {
    key: "fairness",
    label: "公平（fairness）",
    hint: "目标次数与已排次数的缺口，权重越高越平均",
  },
  {
    key: "starvation",
    label: "饥饿（starvation）",
    hint: "从未被排、或超过 21 天没排过的人直接加分",
  },
  {
    key: "preference",
    label: "偏好（preference）",
    hint: "个人偏好加/减分，软约束",
  },
  {
    key: "priority",
    label: "优先级（priority）",
    hint: "人工指定优先级的权重",
  },
  {
    key: "recency",
    label: "连排惩罚（recency）",
    hint: "越靠近冷却期，扣分越多",
  },
];

const DEFAULT_MEALS: MealBlock[] = [
  { label: "午饭", start: "12:00", end: "13:30" },
  { label: "晚饭", start: "17:30", end: "18:30" },
];

const DEFAULT_WEIGHTS: ScoreWeights = {
  fairness: 0.45,
  starvation: 0.3,
  preference: 0.15,
  priority: 0.1,
  recency: 0.2,
};

export function SettingsPage() {
  const toast = useToast();
  const [tab, setTab] = useState("rules");

  const [settingsVersion, setSettingsVersion] = useState(0);
  const [providerVersion] = useState(0);
  const [auditVersion, setAuditVersion] = useState(0);

  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const settings = useAsync(
    async () => api.get<AppSettings>("/admin/settings"),
    [settingsVersion],
  );
  const providers = useAsync(
    async () => api.get<ListResponse<LlmProvider>>("/admin/llm-providers"),
    [providerVersion],
  );
  const audit = useAsync(
    async () => api.get<ListResponse<AuditEvent>>("/admin/audit?limit=20"),
    [auditVersion],
  );

  useEffect(() => {
    const data = settings.data;
    if (!data) return;
    setDraft({
      defaultCooldownDays: data.defaultCooldownDays ?? 3,
      exportIncludePhone: data.exportIncludePhone ?? false,
      importProviderId: data.importProviderId ?? null,
      mealBlocks: data.mealBlocks ?? DEFAULT_MEALS,
      weights: {
        fairness: data.weights?.fairness ?? DEFAULT_WEIGHTS.fairness,
        starvation: data.weights?.starvation ?? DEFAULT_WEIGHTS.starvation,
        preference: data.weights?.preference ?? DEFAULT_WEIGHTS.preference,
        priority: data.weights?.priority ?? DEFAULT_WEIGHTS.priority,
        recency: data.weights?.recency ?? DEFAULT_WEIGHTS.recency,
      },
    });
  }, [settings.data]);

  function updateMeal(index: number, patch: Partial<MealBlock> | null): void {
    setDraft((previous) => {
      if (!previous) return previous;
      const mealBlocks = [...previous.mealBlocks];
      if (patch) mealBlocks[index] = { ...mealBlocks[index]!, ...patch };
      else mealBlocks.splice(index, 1);
      return { ...previous, mealBlocks };
    });
  }

  function updateWeight(key: keyof ScoreWeights, value: number): void {
    setDraft((previous) =>
      previous
        ? { ...previous, weights: { ...previous.weights, [key]: value } }
        : previous,
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

  const providerList = providers.data?.items ?? [];
  const auditColumns: Column<AuditEvent>[] = [
    {
      key: "time",
      header: "时间",
      render: (event) => (
        <span className="text-xs tabular-nums">
          {dateTimeText(event.createdAt)}
        </span>
      ),
    },
    {
      key: "action",
      header: "动作",
      render: (event) => (
        <span className="font-mono text-xs">{event.action}</span>
      ),
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
      render: (event) => (
        <span className="text-xs">{event.actorId ?? "系统"}</span>
      ),
    },
    {
      key: "payload",
      header: "详情",
      render: (event) => {
        const text = event.payload ? JSON.stringify(event.payload) : "";
        return (
          <span
            className="block max-w-[260px] truncate font-mono text-[10px] text-slate-400"
            title={text}
          >
            {text || "—"}
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-4 sm:space-y-5">
      <nav
        aria-label="管理分类"
        className="flex gap-2 overflow-x-auto border-b border-slate-200 pb-3 dark:border-slate-800"
      >
        {[
          ["rules", "排班规则"],
          ["terms", "学期与节次"],
          ["models", "模型服务"],
          ["users", "账号授权"],
          ["audit", "审计记录"],
        ].map(([id, label]) => (
          <Button
            key={id}
            variant={tab === id ? "primary" : "ghost"}
            data-settings-tab={id}
            onClick={() => setTab(id)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {tab === "terms" && <TermsPage />}
      {tab === "models" && <ModelsPage />}
      {tab === "rules" && (
        <Card
          title="排班参数"
          description="调整人员推荐的评分依据；已有分配不会随参数变化。"
          actions={
            <Button
              size="sm"
              loading={saving}
              disabled={!draft}
              onClick={() => void saveSettings()}
            >
              保存设置
            </Button>
          }
        >
          {settings.loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
              <Spinner size="sm" />
              加载设置…
            </div>
          ) : settings.error ? (
            <ListState
              loading={false}
              error={settings.error}
              empty={false}
              onRetry={settings.reload}
            >
              <div />
            </ListState>
          ) : draft ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {WEIGHT_FIELDS.map((field) => (
                  <div
                    key={field.key}
                    className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
                        {field.label}
                      </span>
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
                      onChange={(event) =>
                        updateWeight(field.key, Number(event.target.value))
                      }
                      className="mt-2 w-full accent-indigo-600"
                      aria-label={field.label}
                    />
                    <p className="mt-1 text-[10px] text-slate-400">
                      {field.hint}
                    </p>
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
                          ? {
                              ...previous,
                              defaultCooldownDays: Math.max(
                                0,
                                Number(event.target.value) || 0,
                              ),
                            }
                          : previous,
                      )
                    }
                  />
                </Field>
                <Field label="截图识别模型">
                  <Select
                    value={draft.importProviderId ?? ""}
                    onChange={(event) =>
                      setDraft((previous) =>
                        previous
                          ? {
                              ...previous,
                              importProviderId: event.target.value || null,
                            }
                          : previous,
                      )
                    }
                  >
                    <option value="">按模型顺序自动选择</option>
                    {providerList
                      .filter(
                        (provider) =>
                          provider.enabled && provider.params?.vision !== false,
                      )
                      .map((provider) => (
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
                        previous
                          ? {
                              ...previous,
                              exportIncludePhone: event.target.checked,
                            }
                          : previous,
                      )
                    }
                  />
                </div>
              </div>

              <section className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <div>
                  <h3 className="text-xs font-medium text-slate-700 dark:text-slate-200">饭点</h3>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    全组织统一。「找时间」安排普通活动时不占用这些时段，选「聚餐」时只在这附近找；课表视图中以斜纹标出。
                  </p>
                </div>
                {draft.mealBlocks.map((meal, index) => (
                  <div key={index} className="grid grid-cols-[1fr_auto_auto_auto] items-end gap-2">
                    <Field label="名称">
                      <TextInput value={meal.label} maxLength={20} onChange={(e) => updateMeal(index, { label: e.target.value })} />
                    </Field>
                    <Field label="开始">
                      <TextInput type="time" step={900} value={meal.start} onChange={(e) => updateMeal(index, { start: e.target.value })} />
                    </Field>
                    <Field label="结束">
                      <TextInput type="time" step={900} value={meal.end} onChange={(e) => updateMeal(index, { end: e.target.value })} />
                    </Field>
                    <Button variant="ghost" size="sm" onClick={() => updateMeal(index, null)} aria-label={`删除${meal.label || "饭点"}`}>
                      删除
                    </Button>
                  </div>
                ))}
                {draft.mealBlocks.length < 6 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setDraft((previous) =>
                        previous
                          ? { ...previous, mealBlocks: [...previous.mealBlocks, { label: "饭点", start: "11:30", end: "12:00" }] }
                          : previous,
                      )
                    }
                  >
                    添加饭点
                  </Button>
                )}
              </section>
            </div>
          ) : (
            <EmptyState
              title="暂时读不到设置"
              description="后端可能尚未实现 /admin/settings。"
            />
          )}
        </Card>
      )}

      {tab === "users" && <AdminUsers />}

      {tab === "audit" && (
        <Card
          title="最近审计"
          description="最近 20 条写操作记录"
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAuditVersion((value) => value + 1)}
            >
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
      )}
    </div>
  );
}
