import { describe, expect, it } from "vitest";
import { toolSpecs } from "../src/shared/agent-import/tools";
it("partial timetable corrections do not manufacture defaults for untouched fields", () => {
  const parsed = toolSpecs.amend_timetable.schema.parse({
    key: "main", entries: [{ index: 1, changes: { teacher: "新教师" } }],
  });
  expect(parsed).toEqual({ key: "main", entries: [{ index: 1, changes: { teacher: "新教师" } }] });
});
import {
  emptyAgent,
  emptySession,
  matchPerson,
  personTableSchema,
  revisionAgent,
  mergeRevisionRequests,
  misplacedSourceRevisions,
} from "../src/shared/agent-import/person-workspace";
import {
  emptySnapshot,
  mutate as rawMutate,
  materialize,
  validateTransition,
} from "../src/shared/agent-import/model";
import { projectPeople } from "../src/client/agent-import/projection";
import type { Job } from "../src/client/agent-import/state";
const mutate: typeof rawMutate = (s, e, a, data, id) =>
  rawMutate(s, e, a, data, id ?? String(data.id));
const sources = [
  {
    source: "a.txt",
    locator: "全文",
    explanation: "合成来源",
    inferred: false,
  },
];
function jobFixture(): Job {
  const base = emptySnapshot();
  mutate(base, "person", "create", {
    id: "existing",
    full_name: "甲",
    student_no: "001",
    class_name: "一班",
    email: "kept@example.com",
  });
  mutate(base, "person", "create", { id: "other", full_name: "乙" });
  mutate(base, "term", "create", {
    id: "term",
    name: "秋",
    start_date: "2026-08-31",
    week_count: 3,
  });
  mutate(base, "timetable_profile", "create", {
    id: "old-profile",
    term_id: "term",
    name: "旧作息",
    periods: '[{"index":1,"start":"08:00","end":"08:45"}]',
  });
  for (const id of ["existing", "other"])
    mutate(base, "timetable_entry", "create", {
      id: "old-" + id,
      person_id: id,
      term_id: "term",
      profile_id: "old-profile",
      name: "旧课",
      weekday: 1,
      period_from: 1,
      period_to: 1,
      weeks: "[1,2,3]",
    });
  const session = emptySession();
  const table = personTableSchema.parse({
    key: "fall",
    term_name: "秋",
    calendar_id: "cal",
    entries: [
      { name: "新课", weekday: 2, period_from: 1, period_to: 1, weeks: [1] },
    ],
    sources,
  });
  session.people.a = {
    key: "a",
    label: "甲",
    id: "workspace",
    personId: "new-id",
    sources: ["a.txt"],
    instruction: "",
    organization_ids: [],
    information: { full_name: "甲", student_no: "001", class_name: "一班" },
    timetables: { fall: table },
    calendarEvidence: [],
    unresolved: [],
    status: "done",
    version: 1,
    agent: emptyAgent(),
    checks: {},
  };
  return {
    id: "batch",
    owner: "owner",
    title: "测试",
    createdAt: 1,
    expiresAt: null,
    base,
    draft: structuredClone(base),
    session,
    calendars: {
      cal: {
        id: "cal",
        name: "秋",
        term_id: "term",
        start_date: "2026-08-31",
        week_count: 3,
        minimum_weeks: 1,
        periods: [{ index: 1, start: "08:00", end: "08:45" }],
        timetable_ids: [],
        sources,
        unresolved: [],
      },
    },
    status: "paused",
    notes: {},
    evidence: {},
    log: [],
    summary: "",
    unresolved: [],
    revision: 0,
    validatedRevision: -1,
    turns: 0,
    model: "",
    excluded: [],
  };
}
describe("person object projection", () => {
  it("derives the horizon from course weeks and extends an existing term without dropping other people's data", () => {
    const job = jobFixture();
    job.calendars!.cal.week_count = null;
    job.calendars!.cal.minimum_weeks = null;
    job.session!.people.a.timetables.fall.entries[0].weeks = [18];
    projectPeople(job);
    expect(job.calendars!.cal.week_count).toBe(18);
    expect(job.draft.term[0].week_count).toBe(18);
    expect(job.draft.timetable_entry.find((e) => e.id === "old-other")?.weeks).toBe("[1,2,3]");
    const actual = materialize(job.draft, job.base);
    expect(validateTransition(job.base, actual)).toEqual([]);
    expect(actual.timetable_event.some((e) => e.person_id === "existing"
      && String(e.starts_at).startsWith("2026-12-29"))).toBe(true);
  });
  it("a shorter supplied calendar range never truncates explicit later course weeks", () => {
    const job = jobFixture();
    job.calendars!.cal.term_id = null;
    job.calendars!.cal.week_count = 17;
    job.session!.people.a.timetables.fall.entries[0].weeks = [18];
    projectPeople(job);
    expect(job.draft.term.find((t) => t.id === "cal:term")?.week_count).toBe(18);
    expect(job.draft.timetable_entry.find((e) => e.id === "workspace:fall:0")?.weeks).toBe("[18]");
  });
  it("treats a calendar naming a term that does not exist as a new term", () => {
    const job = jobFixture();
    job.calendars!.cal.term_id = "2026-2027-1";
    projectPeople(job);
    expect(job.draft.term.some((t) => t.id === "cal:term")).toBe(true);
    expect(job.draft.term.some((t) => t.id === "2026-2027-1")).toBe(false);
  });
  it("binds a table without a calendar when the coordinator lists it in timetable_ids", () => {
    const job = jobFixture();
    job.session!.people.a.timetables.fall.calendar_id = null;
    job.calendars!.cal.timetable_ids = ["workspace:fall"];
    projectPeople(job);
    expect(job.session!.people.a.timetables.fall.calendar_id).toBe("cal");
    expect(job.draft.timetable_entry.some((e) => e.id === "workspace:fall:0")).toBe(true);
  });
  it("matches A, preserves existing information, replaces only the person's term B", () => {
    const job = jobFixture();
    projectPeople(job);
    expect(
      [...job.draft.person].sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([...job.base.person].sort((a, b) => a.id.localeCompare(b.id)));
    expect(job.draft.timetable_entry.map((e) => e.id)).toEqual([
      "old-other",
      "workspace:fall:0",
    ]);
    expect(
      validateTransition(job.base, materialize(job.draft, job.base)),
    ).toEqual([]);
  });
  it("partial-week material preserves all other teaching weeks and people", () => {
    const job = jobFixture();
    job.session!.people.a.timetables.fall.replace_weeks = [1];
    projectPeople(job);
    expect(
      job.draft.timetable_entry.find((e) => e.id === "old-existing")?.weeks,
    ).toBe("[2,3]");
    expect(
      job.draft.timetable_entry.find((e) => e.id === "old-other")?.weeks,
    ).toBe("[1,2,3]");
  });
  it("missing timetable never wipes the existing schedule", () => {
    const job = jobFixture();
    job.session!.people.a.timetables.fall.entries = [];
    projectPeople(job);
    expect(job.draft.timetable_entry).toEqual(job.base.timetable_entry);
    expect(job.timetables!["workspace:fall"].bound).toBe(false);
  });
  it("exclusion preserves the original person's schedule", () => {
    const job = jobFixture();
    job.excluded = ["existing"];
    projectPeople(job);
    expect(
      job.draft.timetable_entry.find((e) => e.id === "old-existing"),
    ).toEqual(job.base.timetable_entry.find((e) => e.id === "old-existing"));
  });
  it("rejects out-of-scope weeks atomically", () => {
    const job = jobFixture();
    job.session!.people.a.timetables.fall.replace_weeks = [2];
    expect(() => projectPeople(job)).toThrow("覆盖范围");
    expect(job.draft).toEqual(job.base);
  });
  it("does not silently match a same-name stranger or conflicting student identity", () => {
    const job = jobFixture();
    expect(
      matchPerson({ full_name: "甲" }, job.base.person).id,
    ).toBeUndefined();
    expect(
      matchPerson({ full_name: "另外一人", student_no: "001" }, job.base.person)
        .reason,
    ).toContain("冲突");
    expect(
      matchPerson({ full_name: "甲", student_no: "002" }, job.base.person)
        .candidates,
    ).toEqual([]);
  });
  it("stages new A when no existing identity matches", () => {
    const job = jobFixture();
    job.session!.people.a.information = { full_name: "丙", student_no: "003" };
    projectPeople(job);
    expect(job.draft.person.find((p) => p.id === "new-id")?.full_name).toBe(
      "丙",
    );
    expect(
      job.draft.timetable_entry.find((e) => e.id === "old-existing"),
    ).toBeDefined();
  });
  it("rejects two workspaces for the same person before publishing any draft", () => {
    const job = jobFixture();
    job.session!.people.b = {
      ...structuredClone(job.session!.people.a),
      key: "b",
      id: "second",
    };
    expect(() => projectPeople(job)).toThrow("重复人员");
    expect(job.draft).toEqual(job.base);
  });
  it("complete replacement removes only this person's legacy enrollments, not shared courses", () => {
    const job = jobFixture();
    mutate(job.base, "course", "create", {
      id: "shared",
      term_id: "term",
      name: "共享课",
    });
    for (const p of ["existing", "other"])
      mutate(job.base, "enrollment", "create", {
        id: "e-" + p,
        person_id: p,
        course_id: "shared",
        term_id: "term",
      });
    projectPeople(job);
    expect(job.draft.enrollment.map((e) => e.id)).toEqual(["e-other"]);
    expect(job.draft.course).toEqual(job.base.course);
  });
});

import { validateVerifiedEntries, verifiedEntrySchema } from "../src/shared/agent-import/person-workspace";
describe("source verification facts", () => {
  const table = () => personTableSchema.parse({
    key: "fall", term_name: "秋", sources,
    entries: [{ name: "音乐", weekday: 6, period_from: 11, period_to: 12,
      weeks: [2, 3, 4, 5, 10, 11], teacher: "甲老师" }],
  });
  it("rejects the extra week pattern found in the work log", () => {
    const t = table();
    const reread = verifiedEntrySchema.parse({ ...t.entries[0], index: 0, weeks: [2, 4, 5, 10, 11] });
    expect(() => validateVerifiedEntries(t, [reread])).toThrow("复核值与已存课程不一致");
    t.entries[0].weeks = reread.weeks;
    expect(() => validateVerifiedEntries(t, [reread])).not.toThrow();
  });
  it("treats weeks as sets but does not collapse unknown values into known facts", () => {
    const t = table();
    const reread = verifiedEntrySchema.parse({ ...t.entries[0], index: 0, weeks: [11, 10, 5, 4, 3, 2] });
    expect(() => validateVerifiedEntries(t, [reread])).not.toThrow();
    expect(() => validateVerifiedEntries(t, [{ ...reread, teacher: null }])).toThrow("不一致");
    expect(() => validateVerifiedEntries(t, [{ ...reread, weeks: null }])).toThrow("不一致");
    expect(() => validateVerifiedEntries(t, [])).toThrow("逐条覆盖");
    expect(() => validateVerifiedEntries(t, [reread, reread])).toThrow("逐条覆盖");
    expect(() => validateVerifiedEntries(t, [{ ...reread, index: 1 }])).toThrow("不一致");
  });
  it("reports all differing indices and fields without disclosing saved answers", () => {
    const t = table();
    t.entries.push({ ...t.entries[0] }, { ...t.entries[0] });
    const before = structuredClone(t);
    const reread = t.entries.map((entry, index) => verifiedEntrySchema.parse({
      ...entry, index,
      ...(index === 0 ? { teacher: "乙老师", location: "新地点" } : {}),
      ...(index === 2 ? { weeks: [2] } : {}),
    }));
    let message = "";
    try { validateVerifiedEntries(t, reread); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("fall[0]（teacher、location）");
    expect(message).toContain("fall[2]（weeks）");
    expect(message).not.toContain("fall[1]");
    expect(message).not.toContain("甲老师");
    expect(t).toEqual(before);
  });
});


it("unknown time preserves unrelated existing courses even within declared replacement weeks", () => {
  const job = jobFixture();
  const table = job.session!.people.a.timetables.fall;
  table.replace_weeks = [1, 2];
  table.entries.push({ name: "遮挡课", weekday: 3, period_from: 1, period_to: 2, weeks: null });
  table.unresolved = ["遮挡课周次未知"];
  projectPeople(job);
  expect(job.draft.timetable_entry.find((e) => e.id === "old-existing")?.weeks).toBe("[1,2,3]");
  expect(job.draft.timetable_entry.find((e) => e.id === "old-other")?.weeks).toBe("[1,2,3]");
  expect(job.draft.timetable_entry.filter((e) => e.name === "新课")).toHaveLength(1);
  expect(job.draft.timetable_entry.some((e) => e.name === "遮挡课")).toBe(false);
  expect(Object.values(job.timetables!)[0].entries).toHaveLength(2);
});


it("unused blank timetable layout periods do not block known course clocks", () => {
  const job = jobFixture();
  job.calendars!.cal.periods.push({ index: 13, start: null, end: null });
  projectPeople(job);
  expect(job.timetables!["workspace:fall"].bound).toBe(true);
  expect(job.calendars!.cal.periods.map((p) => p.index)).toEqual([1]);
});
it("a blank clock actually referenced by a course still blocks its binding", () => {
  const job = jobFixture();
  job.calendars!.cal.periods.push({ index: 13, start: null, end: null });
  Object.assign(job.session!.people.a.timetables.fall.entries[0], { period_from: 13, period_to: 13 });
  projectPeople(job);
  expect(job.timetables!["workspace:fall"].bound).toBe(false);
  expect(job.calendars!.cal.periods.map((p) => p.index)).toEqual([1, 13]);
});


describe("scoped revision evidence", () => {
  function completed() {
    const person = jobFixture().session!.people.a;
    const table = person.timetables.fall;
    table.entries.push({ ...table.entries[0], name: "另一门课" });
    person.agent.verifiedEntries = { fall: table.entries.map((entry, index) => verifiedEntrySchema.parse({ ...entry, index })) };
    person.checks.fall = { identity: "核对", courses_and_times: "核对", teachers_and_locations: "核对", calendar: "核对", coverage: "complete", coverage_reason: "全文", checked_entries: [0, 1] };
    return person;
  }
  const scope = [{ key: "fall", indices: [0] }];
  it("invalidates old observations on new sources, unspecific revision or incomplete prior checks", () => {
    const person = completed();
    expect(revisionAgent(person, [...person.sources, "new.txt"], scope).verifiedEntries).toBeUndefined();
    expect(revisionAgent(person, person.sources).verifiedEntries).toBeUndefined();
    person.status = "verifying";
    expect(revisionAgent(person, person.sources, scope).verifiedEntries).toBeUndefined();
    person.status = "done";
    person.checks = {};
    expect(revisionAgent(person, person.sources, scope).verifiedEntries).toBeUndefined();
  });
  it("does not reuse stale observations or mutate the previous evidence", () => {
    const person = completed(), before = structuredClone(person);
    const agent = revisionAgent(person, person.sources, scope);
    expect(agent.verifiedEntries?.fall.map((entry) => entry.index)).toEqual([1]);
    expect(agent.coverage).toEqual({});
    expect(agent.messages).toEqual([]);
    expect(person).toEqual(before);
    person.timetables.fall.entries[1].weeks = [30];
    expect(revisionAgent(person, person.sources, scope).verifiedEntries).toBeUndefined();
  });
  it("rejects invalid revision targets before any state change", () => {
    const person = completed(), before = structuredClone(person);
    for (const target of [[{ key: "missing", indices: [0] }], [{ key: "fall", indices: [9] }], [{ key: "fall", indices: [0, 0] }], [...scope, ...scope]])
      expect(() => revisionAgent(person, person.sources, target)).toThrow("返工范围");
    expect(person).toEqual(before);
  });
});


it("merges parallel findings per person without losing instructions or recheck targets", () => {
  const requests = [
    { key: "a", instruction: "核对数学", sources: ["a.txt"], recheck_entries: [{ key: "fall", indices: [0, 1] }] },
    { key: "a", instruction: "核对物理", sources: ["b.txt"], recheck_entries: [{ key: "fall", indices: [1, 2] }] },
    { key: "b", instruction: "全表核对" },
  ];
  const before = structuredClone(requests), merged = mergeRevisionRequests(requests);
  expect(merged).toEqual([
    { key: "a", instruction: "核对数学\n核对物理", sources: ["a.txt", "b.txt"], recheck_entries: [{ key: "fall", indices: [0, 1, 2] }] },
    { key: "b", instruction: "全表核对" },
  ]);
  expect(mergeRevisionRequests([...requests, { key: "a", instruction: "范围不限" }])[0].recheck_entries).toBeUndefined();
  expect(requests).toEqual(before);
  expect(() => mergeRevisionRequests([{ key: "a", instruction: "a".repeat(3000) }, { key: "a", instruction: "b".repeat(3000) }])).toThrow();
});

it("source handoff requires one explicit printed name and a unique completed target, and never mutates facts", () => {
  const target = jobFixture().session!.people.a;
  const donor = structuredClone(target);
  donor.key = "b";
  donor.information!.full_name = "乙";
  donor.sources = ["b.txt"];
  donor.timetables.fall.entries = [];
  donor.timetables.fall.sources = [{ ...sources[0], source: "b.txt" }];
  donor.checks.fall = { identity: "原件为甲", courses_and_times: "本人缺失", teachers_and_locations: "本人缺失", calendar: "缺失", coverage: "missing", coverage_reason: "错放", checked_entries: [], source_person_names: ["甲"] };
  const people = [target, donor], before = structuredClone(people);
  expect(misplacedSourceRevisions(people)).toMatchObject([{ key: target.key, sources: ["b.txt"] }]);
  expect(people).toEqual(before);
  expect(misplacedSourceRevisions(people, new Set([target.key]))).toEqual([]);
  expect(misplacedSourceRevisions(people, new Set([donor.key]))).toEqual([]);
  const ambiguous = structuredClone(target); ambiguous.key = "third";
  expect(misplacedSourceRevisions([...people, ambiguous])).toEqual([]);
  expect(misplacedSourceRevisions([...people, ambiguous], new Set([ambiguous.key]))).toEqual([]);
  target.sources.push("b.txt");
  expect(misplacedSourceRevisions(people)).toEqual([]);
  target.sources.pop();
  donor.checks.fall.source_person_names = [];
  expect(misplacedSourceRevisions(people)).toEqual([]);
  donor.checks.fall.source_person_names = ["甲", "丙"];
  expect(misplacedSourceRevisions(people)).toEqual([]);
  donor.checks.fall.source_person_names = ["甲"];
  donor.status = "verifying";
  expect(misplacedSourceRevisions(people)).toEqual([]);
  donor.status = "done";
  donor.timetables.fall.entries = structuredClone(target.timetables.fall.entries);
  expect(misplacedSourceRevisions(people)).toEqual([]);
});
