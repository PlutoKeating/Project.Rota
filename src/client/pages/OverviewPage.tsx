import { useMemo } from "react";
import type { Course, ListResponse, PersonView, ShiftView } from "../../shared/types";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { ListState } from "../components/ListState";
import { Spinner } from "../components/Spinner";
import { api, messageOf } from "../lib/api";
import { dateFull, dateShort, isoDate, termEndDate, timeRange } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { shiftStatusLabel, shiftStatusTone, termStatusLabel, termStatusTone } from "../lib/labels";
import { useTermsState } from "../lib/resources";

interface OverviewData {
  personCount: number;
  courseCount: number;
  pendingCount: number;
  recent: ShiftView[];
  errors: string[];
}

const EMPTY: OverviewData = { personCount: 0, courseCount: 0, pendingCount: 0, recent: [], errors: [] };

const QUICK_LINKS = [
  { href: "#/people", title: "管理成员", detail: "搜索、编辑、部门与角色" },
  { href: "#/timetable", title: "录入课表", detail: "课表网格里直接加课" },
  { href: "#/schedule", title: "去排班", detail: "试排、分配、整任务自动排" },
  { href: "#/imports", title: "导入课表", detail: "Excel / CSV / ICS / 截图" },
];

/** 判断今天落在学期第几周；不在学期内返回 null。 */
function currentWeek(startDate: string, weekCount: number): number | null {
  const start = Date.parse(`${startDate}T00:00:00+08:00`);
  const today = Date.parse(`${isoDate()}T00:00:00+08:00`);
  if (Number.isNaN(start) || Number.isNaN(today)) return null;
  const week = Math.floor((today - start) / (7 * 86_400_000)) + 1;
  return week >= 1 && week <= weekCount ? week : null;
}

export function OverviewPage() {
  const terms = useTermsState();
  const term = terms.current;
  const termId = term?.id ?? null;

  const summary = useAsync<OverviewData>(async () => {
    if (!termId || !term) return EMPTY;

    const errors: string[] = [];
    const safe = async <T,>(label: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (error) {
        errors.push(`${label}：${messageOf(error)}`);
        return null;
      }
    };

    const range = `?from=${encodeURIComponent(term.startDate)}&to=${encodeURIComponent(termEndDate(term.startDate, term.weekCount))}`;
    const [persons, courses, shifts] = await Promise.all([
      safe("人员", () => api.get<ListResponse<PersonView>>(`/persons?termId=${encodeURIComponent(termId)}`)),
      safe("课程", () => api.get<ListResponse<Course>>(`/courses?termId=${encodeURIComponent(termId)}`)),
      safe("班次", () => api.get<ListResponse<ShiftView>>(`/shifts${range}`)),
    ]);

    const shiftItems = (shifts?.items ?? []).filter((shift) => shift.status !== "cancelled");
    const pending = shiftItems.filter((shift) => (shift.assignments?.length ?? 0) < shift.requiredHeadcount);
    const recent = [...shiftItems].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt)).slice(0, 5);

    return {
      personCount: persons?.items.length ?? 0,
      courseCount: courses?.items.length ?? 0,
      pendingCount: pending.length,
      recent,
      errors,
    };
  }, [termId, term?.startDate, term?.weekCount]);

  const data = summary.data ?? EMPTY;
  const week = useMemo(
    () => (term ? currentWeek(term.startDate, term.weekCount) : null),
    [term],
  );

  if (terms.loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Spinner size="sm" />
        加载概览…
      </div>
    );
  }

  if (terms.error) {
    return (
      <Card title="概览">
        <ListState loading={false} error={terms.error} empty={false} onRetry={terms.reload}>
          <div />
        </ListState>
      </Card>
    );
  }

  if (!term) {
    return (
      <EmptyState
        title="还没有学期"
        description="先创建学期与节次，才能导入课表、生成班次。"
        action={
          <a
            href="#/terms"
            className="inline-flex items-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
          >
            去创建学期
          </a>
        }
      />
    );
  }

  const stats = [
    {
      label: "当前学期",
      value: term.name,
      hint: `${dateFull(term.startDate)} 起 · ${term.weekCount} 周${week ? ` · 第 ${week} 周` : ""}`,
    },
    {
      label: "在册人员",
      value: summary.loading ? "…" : String(data.personCount),
      hint: "按人员表统计",
    },
    {
      label: "本学期课程",
      value: summary.loading ? "…" : String(data.courseCount),
      hint: "课表里已录入的课程",
    },
    {
      label: "待排班次",
      value: summary.loading ? "…" : String(data.pendingCount),
      hint: "已排人数少于需求",
    },
  ];

  return (
    <div className="space-y-4 sm:space-y-5">
      {data.errors.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-medium">部分数据未加载成功（后端接口可能仍在开发）</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {data.errors.map((item) => (
              <li key={item} className="break-words">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label} bodyClassName="p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">{stat.label}</p>
            <p className="mt-1 truncate text-2xl font-semibold tracking-tight tabular-nums">{stat.value}</p>
            <p className="mt-1 truncate text-[11px] text-slate-400 dark:text-slate-500">{stat.hint}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="最近班次"
          description="按开始时间倒序，取最近 5 条"
          actions={
            <a href="#/schedule" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              查看排班 →
            </a>
          }
          bodyClassName="p-0 sm:p-0"
        >
          {summary.loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
              <Spinner size="sm" />
              加载中…
            </div>
          ) : summary.error ? (
            <div className="p-4">
              <ListState loading={false} error={summary.error} empty={false} onRetry={summary.reload}>
                <div />
              </ListState>
            </div>
          ) : data.recent.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="还没有班次"
                description="在任务页为任务添加班次，或按周批量生成。"
                action={
                  <a href="#/tasks" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    去任务页 →
                  </a>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.recent.map((shift) => (
                <li key={shift.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{shift.taskTitle ?? "未命名任务"}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      {dateShort(shift.startsAt)} {timeRange(shift.startsAt, shift.endsAt)}
                      {shift.location ? ` · ${shift.location}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">
                      {(shift.assignments?.length ?? 0)}/{shift.requiredHeadcount} 人
                    </span>
                    <Badge tone={shiftStatusTone(shift.status)}>{shiftStatusLabel(shift.status)}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="学期状态" description="当前学期是否正在使用">
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500 dark:text-slate-400">状态</span>
              <Badge tone={termStatusTone(term.status)}>{termStatusLabel(term.status)}</Badge>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500 dark:text-slate-400">时间范围</span>
              <span className="text-right text-xs">
                {dateShort(term.startDate)} → {dateShort(termEndDate(term.startDate, term.weekCount))}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500 dark:text-slate-400">节次 / 格子</span>
              <span className="text-xs">
                {summary.loading ? "…" : "见学期页"} · {term.weekCount * 7} 天
              </span>
            </div>
            <a
              href="#/terms"
              className="mt-1 inline-flex w-full items-center justify-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              管理学期与节次
            </a>
          </div>
        </Card>
      </div>

      <Card title="快捷入口" description="常用动作一步直达">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {QUICK_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-xl border border-slate-200 p-3 transition hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-slate-800 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/10"
            >
              <p className="text-sm font-medium">{link.title}</p>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{link.detail}</p>
            </a>
          ))}
        </div>
      </Card>
    </div>
  );
}
