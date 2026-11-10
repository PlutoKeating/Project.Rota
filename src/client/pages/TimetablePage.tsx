import { PersonalTimetable } from "../components/PersonalTimetable";
import { CourseAdjustments } from "../components/CourseAdjustments";
import { UnavailabilityEditor } from "../components/UnavailabilityEditor";
import { useEffect, useMemo, useState } from "react";
import type {
  CreateCourseInput,
  ListResponse,
  PersonView,
  TimetableCell,
  TimetableWeek,
  WeekPatternKind,
} from "../../shared/types";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Checkbox, Field, Select, TextInput } from "../components/Field";
import { EmptyState } from "../components/EmptyState";
import { ListState } from "../components/ListState";
import { Spinner } from "../components/Spinner";
import { useToast } from "../components/Toast";
import { api, messageOf } from "../lib/api";
import { addDays, isoDate, timeRange, WEEKDAYS, weekdayName } from "../lib/format";
import {
  clockToMinutes,
  isoToMinutes,
  mondayOf,
  WeekNav,
  WeekTimetable,
  weekDays,
  type TimetableBlock,
  type TimetablePeriod,
} from "../components/WeekTimetable";
import { useAsync } from "../lib/hooks";
import { WEEK_PATTERN_OPTIONS } from "../lib/labels";
import { usePeriodsState, useTermsState } from "../lib/resources";

const UNAVAILABLE_TEXT = { leave: "请假", blacklist: "不可排" } as const;

/** 按节次的格子合并成课表色块：同一门课连续节次合成一块，请假同理。 */
function timetableBlocks(cells: TimetableCell[]): TimetableBlock[] {
  interface Draft {
    block: TimetableBlock;
    lastPeriod: number;
    startsAt: string;
    endsAt: string;
  }
  const sorted = [...cells].sort((a, b) => a.weekday - b.weekday || a.periodIndex - b.periodIndex);
  const open = new Map<string, Draft>();
  const done: Draft[] = [];
  const add = (key: string, cell: TimetableCell, make: () => Omit<TimetableBlock, "start" | "end" | "day">) => {
    const end = isoToMinutes(cell.endsAt, cell.startsAt.slice(0, 10));
    const current = open.get(key);
    if (current && current.lastPeriod === cell.periodIndex - 1 && current.block.day === cell.weekday - 1) {
      current.lastPeriod = cell.periodIndex;
      current.block.end = end;
      current.endsAt = cell.endsAt;
      return;
    }
    if (current) done.push(current);
    open.set(key, {
      block: { ...make(), day: cell.weekday - 1, start: isoToMinutes(cell.startsAt), end },
      lastPeriod: cell.periodIndex,
      startsAt: cell.startsAt,
      endsAt: cell.endsAt,
    });
  };
  for (const cell of sorted) {
    for (const course of cell.courses) {
      add(`c:${course.courseId}`, cell, () => ({
        id: `${course.courseId}-${cell.slotId}`,
        title: course.courseName,
        detail: course.location ? `@${course.location}` : undefined,
        colorKey: course.courseName,
      }));
    }
    if (cell.unavailable) {
      const kind = cell.unavailable.kind;
      add(`u:${kind}`, cell, () => ({
        id: `u-${cell.slotId}`,
        title: kind === "leave" || kind === "blacklist" ? UNAVAILABLE_TEXT[kind] : "不可用",
        detail: cell.unavailable?.reason ?? undefined,
        color: kind === "blacklist" ? "#b4233c" : "#946200",
        variant: "outline",
      }));
    }
  }
  done.push(...open.values());
  return done.map(({ block, startsAt, endsAt }) => ({
    ...block,
    label: `${block.title} ${timeRange(startsAt, endsAt)}${block.detail ? ` ${block.detail}` : ""}`,
  }));
}

export function TimetablePage({
  initialPersonId = "",
}: { initialPersonId?: string } = {}) {
  const toast = useToast();
  const terms = useTermsState();

  const [termId, setTermId] = useState("");
  const [personId, setPersonId] = useState(initialPersonId);
  const [week, setWeek] = useState(1);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!termId && terms.current) setTermId(terms.current.id);
  }, [terms.current, termId]);

  const selectedTerm =
    terms.terms.find((term) => term.id === termId) ?? terms.current;

  // 切学期时定位到今天所在的周（不在学期内则第 1 周），打开即看到本周课表。
  useEffect(() => {
    const start = selectedTerm?.startDate;
    if (!start) return setWeek(1);
    const days = Math.floor((Date.parse(isoDate()) - Date.parse(start)) / 86_400_000);
    const current = Math.floor(days / 7) + 1;
    setWeek(current >= 1 && current <= (selectedTerm?.weekCount ?? 20) ? current : 1);
  }, [termId, selectedTerm?.startDate, selectedTerm?.weekCount]);
  const weekCount = selectedTerm?.weekCount ?? 20;

  const persons = useAsync(
    async () => api.get<ListResponse<PersonView>>("/persons"),
    [],
  );
  const periods = usePeriodsState(termId || null);

  useEffect(() => {
    if (personId) return;
    const first = persons.data?.items[0];
    if (first) setPersonId(first.id);
  }, [persons.data, personId]);

  const timetable = useAsync(async () => {
    if (!termId || !personId) return null;
    return api.get<TimetableWeek>(
      `/persons/${encodeURIComponent(personId)}/timetable?termId=${encodeURIComponent(termId)}&week=${week}`,
    );
  }, [termId, personId, week, version]);

  const cellMap = useMemo(() => {
    const map = new Map<string, TimetableCell>();
    for (const cell of timetable.data?.cells ?? []) {
      map.set(`${cell.weekday}-${cell.periodIndex}`, cell);
    }
    return map;
  }, [timetable.data]);

  const personList = persons.data?.items ?? [];
  const periodList = useMemo(
    () =>
      [...(periods.data?.items ?? [])].sort(
        (a, b) => a.periodIndex - b.periodIndex,
      ),
    [periods.data],
  );
  const periodCount = periodList.length > 0 ? periodList.length : 12;
  const axisPeriods = useMemo<TimetablePeriod[]>(
    () =>
      periodList.map((p) => ({
        index: p.periodIndex,
        start: clockToMinutes(p.startTime),
        end: clockToMinutes(p.endTime),
      })),
    [periodList],
  );
  const days = useMemo(() => {
    if (!selectedTerm?.startDate) return WEEKDAYS.map((weekday) => ({ weekday }));
    return weekDays(mondayOf(addDays(selectedTerm.startDate, (week - 1) * 7)), isoDate());
  }, [selectedTerm?.startDate, week]);
  const blocks = useMemo(() => timetableBlocks(timetable.data?.cells ?? []), [timetable.data]);

  // 添加课程表单
  const [courseName, setCourseName] = useState("");
  const [teacher, setTeacher] = useState("");
  const [weekday, setWeekday] = useState(1);
  const [periodFrom, setPeriodFrom] = useState(1);
  const [periodTo, setPeriodTo] = useState(1);
  const [patternKind, setPatternKind] = useState<WeekPatternKind>("all");
  const [weekRanges, setWeekRanges] = useState("");
  const [location, setLocation] = useState("");
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (personId) setSelectedPersonIds([personId]);
  }, [personId]);

  function togglePerson(id: string, checked: boolean): void {
    setSelectedPersonIds((previous) =>
      checked
        ? [...new Set([...previous, id])]
        : previous.filter((value) => value !== id),
    );
  }

  async function addCourse(): Promise<void> {
    if (!termId) {
      toast.error("请先选择学期");
      return;
    }
    if (!courseName.trim()) {
      toast.error("请填写课程名");
      return;
    }
    if (selectedPersonIds.length === 0) {
      toast.error("至少选择一位上课人");
      return;
    }
    if (periodFrom > periodTo) {
      toast.error("开始节次不能晚于结束节次");
      return;
    }
    if (patternKind === "ranges" && !weekRanges.trim()) {
      toast.error("周次模式为「指定周次」时，请填写周次范围");
      return;
    }

    const input: CreateCourseInput = {
      termId,
      name: courseName.trim(),
      teacher: teacher.trim() || undefined,
      personIds: selectedPersonIds,
      meetings: [
        {
          weekday,
          periodFrom,
          periodTo,
          patternKind,
          weekRanges: patternKind === "ranges" ? weekRanges.trim() : undefined,
          location: location.trim() || undefined,
        },
      ],
    };

    setCreating(true);
    try {
      await api.post("/courses", input);
      toast.success(`课程「${input.name}」已添加`);
      setCourseName("");
      setTeacher("");
      setLocation("");
      setVersion((value) => value + 1);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setCreating(false);
    }
  }

  const gridContent = (() => {
    if (persons.error) {
      return (
        <ListState
          loading={false}
          error={persons.error}
          empty={false}
          onRetry={persons.reload}
        >
          <div />
        </ListState>
      );
    }
    if (!personId) {
      return (
        <EmptyState
          title="先选择一位人员"
          description="课表按人展示，选择后可以看到每周的课程与请假。"
          action={
            <a
              href="#/people"
              className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              去人员页 →
            </a>
          }
        />
      );
    }
    if (periods.error) {
      return (
        <ListState
          loading={false}
          error={periods.error}
          empty={false}
          onRetry={periods.reload}
        >
          <div />
        </ListState>
      );
    }
    if (!periods.loading && periodList.length === 0) {
      return (
        <EmptyState
          title="这个学期还没有节次"
          description="课表网格依赖节次定义，请先在学期页创建学期（会同时生成节次）。"
          action={
            <a
              href="#/terms"
              className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              去学期页 →
            </a>
          }
        />
      );
    }
    if (timetable.loading || periods.loading) {
      return (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
          <Spinner size="sm" />
          加载课表…
        </div>
      );
    }
    if (timetable.error) {
      return (
        <ListState
          loading={false}
          error={timetable.error}
          empty={false}
          onRetry={timetable.reload}
        >
          <div />
        </ListState>
      );
    }

    return (
      <WeekTimetable
        caption={`第 ${week} 周课表`}
        days={days}
        periods={axisPeriods}
        blocks={blocks}
        toolbar={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              {selectedTerm?.name ?? ""} · 课程与请假会直接进入可用性计算
            </p>
            <WeekNav
              label={`第 ${week} 周`}
              prevDisabled={week <= 1}
              nextDisabled={week >= weekCount}
              onPrev={() => setWeek((w) => Math.max(1, w - 1))}
              onNext={() => setWeek((w) => Math.min(weekCount, w + 1))}
            />
          </div>
        }
        footer={
          blocks.length === 0 ? (
            <p className="text-center text-xs text-slate-500">这一周没有课程或请假，整周空闲。</p>
          ) : null
        }
      />
    );
  })();

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card
        title="周课表"
        description="按人、按周查看；课程与请假会直接进入可用性计算。"
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="学期">
            <Select
              value={termId}
              onChange={(event) => setTermId(event.target.value)}
            >
              <option value="">选择学期</option>
              {terms.terms.map((term) => (
                <option key={term.id} value={term.id}>
                  {term.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="人员">
            <Select
              value={personId}
              onChange={(event) => setPersonId(event.target.value)}
            >
              <option value="">选择人员</option>
              {personList.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName}
                  {person.studentNo ? `（${person.studentNo}）` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="周次">
            <Select
              value={week}
              onChange={(event) => setWeek(Number(event.target.value))}
            >
              {Array.from(
                { length: Math.max(1, weekCount) },
                (_, index) => index + 1,
              ).map((value) => (
                <option key={value} value={value}>
                  第 {value} 周
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                persons.reload();
                terms.reload();
                setVersion((value) => value + 1);
              }}
            >
              刷新数据
            </Button>
          </div>
        </div>

        {persons.error ? (
          <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-400">
            人员加载失败：{persons.error}
          </p>
        ) : null}
        {terms.error ? (
          <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-400">
            学期加载失败：{terms.error}
          </p>
        ) : null}

        <div className="mt-4">{gridContent}</div>
      </Card>
      {termId && personId && <PersonalTimetable key={`${personId}-${termId}-${version}`} personId={personId} termId={termId} week={week} onChanged={()=>setVersion(v=>v+1)}/>}
      {termId && personId && (
        <CourseAdjustments
          key={`${termId}-${personId}-${version}`}
          termId={termId}
          personId={personId}
          week={week}
          onChanged={() => setVersion((v) => v + 1)}
        />
      )}
      {personId && (
        <UnavailabilityEditor
          key={personId}
          personId={personId}
          onChanged={() => setVersion((v) => v + 1)}
        />
      )}

      <Card
        title="添加课程"
        description="一门课可以同时选给多个人；规则只存一份。"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="课程名" required>
            <TextInput
              value={courseName}
              onChange={(event) => setCourseName(event.target.value)}
              placeholder="高等数学"
            />
          </Field>
          <Field label="教师">
            <TextInput
              value={teacher}
              onChange={(event) => setTeacher(event.target.value)}
              placeholder="可选"
            />
          </Field>
          <Field label="地点">
            <TextInput
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="教三-201"
            />
          </Field>
          <Field label="星期">
            <Select
              value={weekday}
              onChange={(event) => setWeekday(Number(event.target.value))}
            >
              {WEEKDAYS.map((day) => (
                <option key={day} value={day}>
                  {weekdayName(day)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="起止节次">
            <div className="flex items-center gap-2">
              <Select
                value={periodFrom}
                onChange={(event) => setPeriodFrom(Number(event.target.value))}
              >
                {Array.from(
                  { length: periodCount },
                  (_, index) => index + 1,
                ).map((value) => (
                  <option key={value} value={value}>
                    第 {value} 节
                  </option>
                ))}
              </Select>
              <span className="text-xs text-slate-400">至</span>
              <Select
                value={periodTo}
                onChange={(event) => setPeriodTo(Number(event.target.value))}
              >
                {Array.from(
                  { length: periodCount },
                  (_, index) => index + 1,
                ).map((value) => (
                  <option key={value} value={value}>
                    第 {value} 节
                  </option>
                ))}
              </Select>
            </div>
          </Field>
          <Field label="周次模式">
            <Select
              value={patternKind}
              onChange={(event) =>
                setPatternKind(event.target.value as WeekPatternKind)
              }
            >
              {WEEK_PATTERN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          {patternKind === "ranges" ? (
            <Field label="周次范围" hint="例如 1-8,10-16,18">
              <TextInput
                value={weekRanges}
                onChange={(event) => setWeekRanges(event.target.value)}
                placeholder="1-8"
              />
            </Field>
          ) : null}
        </div>

        <div className="mt-3">
          <p className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
            上课人（{selectedPersonIds.length}）
          </p>
          {personList.length === 0 ? (
            <p className="text-[11px] text-slate-400">
              还没有人员，先到「人员」页新建。
            </p>
          ) : (
            <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2 lg:grid-cols-3 dark:border-slate-800">
              {personList.map((person) => (
                <Checkbox
                  key={person.id}
                  label={`${person.fullName}${person.studentNo ? `（${person.studentNo}）` : ""}`}
                  checked={selectedPersonIds.includes(person.id)}
                  onChange={(event) =>
                    togglePerson(person.id, event.target.checked)
                  }
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 flex justify-end">
          <Button
            loading={creating}
            disabled={!termId || !personId}
            onClick={() => void addCourse()}
          >
            添加课程
          </Button>
        </div>
      </Card>
    </div>
  );
}
