import type { Row } from "../../shared/agent-import/model";
import { WeekTimetable, clockToMinutes, type TimetableBlock, type TimetablePeriod } from "../components/WeekTimetable";

interface ProfilePeriod {
  index: number;
  start: string;
  end: string;
}

function parsePeriods(profile: Row | undefined): ProfilePeriod[] {
  try {
    const value = JSON.parse(String(profile?.periods ?? "[]")) as ProfilePeriod[];
    return Array.isArray(value) ? value.filter((p) => typeof p.start === "string" && typeof p.end === "string" && p.start && p.end) : [];
  } catch {
    return [];
  }
}

/**
 * 导入复核中某人某周的课表：与人员课表同一课表样式，按此人作息方案的节次时间落格。
 * 点色块打开该课程的修改；缺少节次时间的条目在下方列出，不猜测位置。
 */
export function ReviewWeek({
  entries,
  profiles,
  week,
  title,
  onEdit,
}: {
  entries: Row[];
  profiles: Row[];
  week: number;
  title: (entry: Row) => string;
  onEdit: (entry: Row) => (() => void) | null;
}) {
  const periodsOf = new Map(profiles.map((p) => [p.id, parsePeriods(p)]));
  // 纵轴用本周条目最常用的作息方案。
  const usage = new Map<string, number>();
  for (const e of entries) usage.set(String(e.profile_id), (usage.get(String(e.profile_id)) ?? 0) + 1);
  const main = [...usage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const axis: TimetablePeriod[] = (periodsOf.get(main ?? "") ?? []).map((p) => ({
    index: p.index,
    start: clockToMinutes(p.start),
    end: clockToMinutes(p.end),
  }));
  const blocks: TimetableBlock[] = [];
  const unplaced: Row[] = [];
  for (const e of entries) {
    const periods = periodsOf.get(String(e.profile_id)) ?? [];
    const from = periods.find((p) => p.index === Number(e.period_from));
    const to = periods.find((p) => p.index === Number(e.period_to));
    const weekday = Number(e.weekday);
    if (!from || !to || !(weekday >= 1 && weekday <= 7)) {
      unplaced.push(e);
      continue;
    }
    const name = title(e);
    const where = [e.location, e.teacher].filter(Boolean).join(" ");
    blocks.push({
      id: e.id,
      day: weekday - 1,
      start: clockToMinutes(from.start),
      end: clockToMinutes(to.end),
      title: name,
      detail: e.location ? `@${String(e.location)}` : undefined,
      colorKey: name,
      label: `修改课程：${name} 第 ${e.period_from}–${e.period_to} 节${where ? ` ${where}` : ""}`,
      onClick: onEdit(e) ?? undefined,
    });
  }
  return (
    <WeekTimetable
      caption={`第 ${week} 周课表`}
      days={[1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday }))}
      periods={axis}
      blocks={blocks}
      footer={
        unplaced.length > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {unplaced.map((e) => `${title(e)}（第 ${e.period_from ?? "?"}–${e.period_to ?? "?"} 节）`).join("、")}
            缺少作息时间，未画在课表上。
          </p>
        ) : null
      }
    />
  );
}
