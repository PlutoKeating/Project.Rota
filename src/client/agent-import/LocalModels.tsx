import { useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { Field, Select, TextInput, Checkbox } from "../components/Field";
import { Icon } from "../components/Icon";
import { cx } from "../lib/cx";
import {
  PRESETS,
  loadLocalModels,
  saveLocalModels,
  testLocalModel,
  type LocalModel,
  type LocalModelSettings,
} from "./local-models";

/** Live view of the local model settings, refreshed when any tab saves them. */
export function useLocalModels(): LocalModelSettings {
  const [settings, setSettings] = useState(loadLocalModels);
  useEffect(() => {
    const refresh = () => setSettings(loadLocalModels());
    window.addEventListener("rota:local-models", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("rota:local-models", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return settings;
}

/** Compact entry point showing which path model calls take. */
export function ModelModeButton() {
  const settings = useLocalModels();
  const [open, setOpen] = useState(false);
  const active = settings.direct
    ? settings.models.filter((m) => m.enabled && m.apiKey && m.model)
    : [];
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx(
          "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm transition",
          active.length
            ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200"
            : "border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800",
        )}
      >
        <Icon name="settings" className="size-4" />
        {active.length ? `本机直连 · ${active[0].model}` : "模型：服务器"}
      </button>
      {open && <LocalModelsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

type Draft = Omit<LocalModel, "id" | "enabled">;
const blank = (): Draft => ({ ...PRESETS[0], name: PRESETS[0].label, apiKey: "", reasoningEffort: "" });

function LocalModelsDialog({ onClose }: { onClose: () => void }) {
  const settings = useLocalModels();
  const [draft, setDraft] = useState<Draft>(blank);
  const [tests, setTests] = useState<Record<string, { busy?: boolean; ok?: boolean; text?: string }>>({});
  const [error, setError] = useState("");
  const save = (next: LocalModelSettings) => {
    try {
      saveLocalModels(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const update = (id: string, patch: Partial<LocalModel>) =>
    save({ ...settings, models: settings.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const move = (index: number, delta: number) => {
    const models = [...settings.models];
    const [item] = models.splice(index, 1);
    models.splice(Math.max(0, Math.min(models.length, index + delta)), 0, item);
    save({ ...settings, models });
  };
  const test = async (m: LocalModel) => {
    setTests((t) => ({ ...t, [m.id]: { busy: true } }));
    const result = await testLocalModel(m);
    setTests((t) => ({
      ...t,
      [m.id]: { ok: result.ok, text: result.ok ? `${(result.ms / 1000).toFixed(1)}s` : result.message },
    }));
  };
  const add = () => {
    const model: LocalModel = {
      ...draft,
      id: crypto.randomUUID().slice(0, 8),
      name: draft.name.trim() || draft.model,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
      reasoningEffort: draft.reasoningEffort || undefined,
      enabled: true,
    };
    save({ direct: true, models: [...settings.models, model] });
    setDraft(blank());
    void test(model);
  };
  const valid = /^https:\/\//.test(draft.baseUrl.trim()) && draft.model.trim() && draft.apiKey.trim();
  return (
    <Modal
      title="模型"
      description="本机直连：浏览器直接调用你填写的模型，密钥只保存在本浏览器，不经过服务器。"
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <span>
            <span className="block text-sm font-medium">本机直连模型</span>
            <span className="block text-xs text-slate-500">
              关闭时使用管理页配置的服务器模型
            </span>
          </span>
          <Checkbox
            label=""
            aria-label="本机直连模型"
            checked={settings.direct}
            onChange={(e) => save({ ...settings, direct: e.target.checked })}
          />
        </div>

        {settings.models.length > 0 && (
          <ol className="space-y-2" aria-label="本机模型（按顺序尝试）">
            {settings.models.map((m, i) => {
              const t = tests[m.id];
              return (
                <li
                  key={m.id}
                  className={cx(
                    "flex flex-wrap items-center gap-3 rounded-xl border p-3",
                    m.enabled ? "border-slate-200 dark:border-slate-800" : "border-dashed border-slate-200 opacity-60 dark:border-slate-800",
                  )}
                >
                  <Checkbox
                    label=""
                    aria-label={"启用 " + m.name}
                    checked={m.enabled}
                    onChange={(e) => update(m.id, { enabled: e.target.checked })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {m.model}
                      <span className="ml-1.5 font-normal text-slate-500">{m.name}</span>
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {m.baseUrl.replace(/^https:\/\//, "")} · 密钥 ••••{m.apiKey.slice(-4)}
                    </span>
                  </span>
                  {t && !t.busy && (
                    <span
                      className={cx(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
                        t.ok
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                          : "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
                      )}
                    >
                      <Icon name={t.ok ? "check" : "x"} className="size-3" />
                      {t.text}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" loading={t?.busy} onClick={() => void test(m)}>
                      测试
                    </Button>
                    <button
                      type="button"
                      aria-label="上移"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                      className="grid size-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                    >
                      <Icon name="chevron-down" className="size-4 rotate-180" />
                    </button>
                    <button
                      type="button"
                      aria-label={"删除 " + m.name}
                      onClick={() => save({ ...settings, models: settings.models.filter((x) => x.id !== m.id) })}
                      className="grid size-8 place-items-center rounded-md text-slate-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/10"
                    >
                      <Icon name="trash" className="size-4" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        <form
          className="grid gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-2 dark:bg-slate-900"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) add();
          }}
        >
          <Field label="供应商">
            <Select
              value={PRESETS.findIndex((p) => p.baseUrl === draft.baseUrl && p.kind === draft.kind)}
              onChange={(e) => {
                const p = PRESETS[Number(e.target.value)];
                if (p) setDraft({ ...draft, kind: p.kind, baseUrl: p.baseUrl, model: p.model || draft.model, name: p.label });
              }}
            >
              {PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
              <option value={-1} hidden>
                自定义
              </option>
            </Select>
          </Field>
          <Field label="模型" required>
            <TextInput
              value={draft.model}
              placeholder="例如 deepseek-flash"
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />
          </Field>
          <Field label="接口地址" required hint="需支持浏览器跨域访问">
            <TextInput
              value={draft.baseUrl}
              placeholder="https://…"
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
          </Field>
          <Field label="API Key" required hint="只保存在本浏览器">
            <TextInput
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            />
          </Field>
          <Field label="推理强度" hint="留空用供应商默认">
            <Select
              value={draft.reasoningEffort ?? ""}
              onChange={(e) => setDraft({ ...draft, reasoningEffort: e.target.value })}
            >
              <option value="">默认</option>
              <option value="none">关闭</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={!valid} className="w-full">
              <Icon name="plus" className="size-4" />
              添加并测试
            </Button>
          </div>
        </form>
        {error && (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
