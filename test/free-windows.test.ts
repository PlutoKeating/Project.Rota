import { describe, expect, it } from "vitest";
import {
  buildDays,
  DEFAULT_MEAL_BLOCKS,
  findFreeWindows,
  normalizeMealBlocks,
  parseClock,
  toLocalIso,
  type BusyInterval,
  type TimeInterval,
} from "../src/shared/free-windows";
import type { FreeWindowPerson } from "../src/shared/types";

const at = (hhmm: string, date = "2026-11-10") => Date.parse(`${date}T${hhmm}:00+08:00`);
const day = (from: string, to: string, date = "2026-11-10") => ({ date, start: at(from, date), end: at(to, date) });
const people = (...ids: string[]): FreeWindowPerson[] => ids.map((id) => ({ id, fullName: id, required: false }));
const busy = (entries: Record<string, [string, string][]>) =>
  new Map<string, BusyInterval[]>(
    Object.entries(entries).map(([id, list]) => [
      id,
      list.map(([from, to]) => ({ start: at(from), end: at(to), reason: "course" as const, label: "课" })),
    ]),
  );
const span = (w: { startsAt: string; endsAt: string }) => `${w.startsAt.slice(11, 16)}-${w.endsAt.slice(11, 16)}`;

const MEALS = DEFAULT_MEAL_BLOCKS;
const base = { unknown: new Map<string, TimeInterval[]>(), durationMinutes: 60, meals: MEALS };

describe("findFreeWindows", () => {
  it("ranks by attendance, keeps at most two per day and reports busy reasons", () => {
    const result = findFreeWindows({
      ...base,
      people: people("A", "B", "C"),
      days: [day("08:00", "12:00")],
      busy: busy({ A: [["09:00", "10:00"]], B: [["10:30", "11:00"]] }),
      count: 5,
    });
    expect(result.emptyReason).toBeNull();
    expect(result.windows.map(span)).toEqual(["08:00-09:00", "11:00-12:00"]);
    expect(result.windows.map((w) => w.free.length)).toEqual([3, 3]);
    // A 09:00 就要上课、B 10:30–11:00 刚下课：都算「紧挨」。
    expect(result.windows[0]!.tight).toEqual(["A"]);
    expect(result.windows[1]!.tight).toEqual(["B"]);
  });

  it("merges consecutive starts with the same people into a movable range and avoids meal times", () => {
    const one = findFreeWindows({
      ...base,
      people: people("A"),
      days: [day("08:00", "22:00")],
      busy: busy({ A: [["09:45", "10:20"]] }),
      count: 5,
    });
    expect(one.windows.map(span)).toEqual(["08:00-09:00", "11:00-12:00"]);
    expect(one.windows.map((w) => [w.flexStart.slice(11, 16), w.flexEnd.slice(11, 16)])).toEqual([
      ["08:00", "09:45"],
      ["10:30", "12:00"],
    ]);
    for (const w of one.windows) {
      expect(w.minutes).toBe(60);
      expect(w.endsAt <= "2026-11-10T12:00:00+08:00" || w.startsAt >= "2026-11-10T13:30:00+08:00").toBe(true);
    }
  });

  it("looks only around meal times for a group meal", () => {
    const result = findFreeWindows({
      ...base,
      people: people("A", "B"),
      days: [day("08:00", "22:00")],
      busy: new Map(),
      durationMinutes: 90,
      mode: "meal",
      count: 5,
    });
    expect(result.windows.map(span)).toEqual(["12:00-13:30", "17:30-19:00"]);
  });

  it("prefers comfortable weekday times once the quorum is met", () => {
    const sat = "2026-11-14";
    const team = people("A", "B", "C");
    const options = {
      ...base,
      people: team,
      days: [day("14:00", "16:00"), day("14:00", "16:00", sat)],
      busy: new Map<string, BusyInterval[]>([
        ["C", [{ start: at("14:00"), end: at("16:00"), reason: "course", label: "课" }]],
      ]),
      count: 1,
    };
    const all = findFreeWindows({ ...options, mode: "all" });
    expect(all.windows[0]!.startsAt.slice(0, 10)).toBe(sat);
    expect(all.windows[0]!.notes).toEqual(["weekend"]);
    const quorum = findFreeWindows({ ...options, mode: "quorum", minAttendees: 2 });
    expect(quorum.windows[0]!.startsAt.slice(0, 16)).toBe("2026-11-10T14:00");
    expect(quorum.windows[0]!.free).toEqual(["A", "B"]);

    const weekdayOnly = findFreeWindows({ ...options, days: [day("14:00", "16:00")], mode: "quorum", minAttendees: 3 });
    expect(weekdayOnly.emptyReason).toBe("quorum_unreachable");
    expect(weekdayOnly.bestAttendees).toBe(2);
  });

  it("requires every required person to be free", () => {
    const team: FreeWindowPerson[] = [{ id: "lead", fullName: "lead", required: true }, ...people("A", "B")];
    const result = findFreeWindows({
      ...base,
      people: team,
      days: [day("08:00", "12:00")],
      busy: busy({ A: [["08:00", "10:00"]], B: [["08:00", "10:00"]], lead: [["10:00", "12:00"]] }),
      count: 5,
    });
    expect(result.windows.map(span)).toEqual(["08:00-09:00"]);
    expect(result.windows[0]!.free).toEqual(["lead"]);
    expect(result.windows[0]!.flexEnd.slice(11, 16)).toBe("10:00");

    const blocked = findFreeWindows({
      ...base,
      people: team,
      days: [day("08:00", "12:00")],
      busy: busy({ lead: [["08:00", "12:00"]] }),
      count: 5,
    });
    expect(blocked.emptyReason).toBe("required_unavailable");
  });

  it("never counts unknown people as free", () => {
    const unknown = new Map<string, TimeInterval[]>([["B", [{ start: at("08:00"), end: at("12:00") }]]]);
    const result = findFreeWindows({
      ...base,
      people: people("A", "B"),
      days: [day("08:00", "12:00")],
      busy: new Map(),
      unknown,
      count: 1,
    });
    expect(result.windows[0]).toMatchObject({ free: ["A"], unknown: ["B"], busy: [], minutes: 60 });
    expect(result.heatmap[0]!.free.slice(0, 2)).toEqual([1, 1]);
    expect(result.heatmap[0]!.unknown.slice(0, 2)).toEqual([1, 1]);
  });

  it("handles many people and avoids starts right after someone's class", () => {
    const ids = Array.from({ length: 70 }, (_, i) => `p${i}`);
    const result = findFreeWindows({
      ...base,
      people: people(...ids),
      days: [day("08:00", "11:00")],
      busy: busy({ p69: [["08:00", "09:00"]] }),
      count: 2,
    });
    expect(result.windows.map((w) => [span(w), w.free.length])).toEqual([
      ["09:30-10:30", 70],
      ["08:00-09:00", 69],
    ]);
  });

  it("reports empty inputs", () => {
    const empty = { ...base, people: people("A"), busy: new Map(), count: 1 };
    expect(findFreeWindows({ ...empty, days: [] }).emptyReason).toBe("no_days");
    expect(findFreeWindows({ ...empty, days: [day("08:00", "08:45")] }).emptyReason).toBe("window_too_short");
    expect(findFreeWindows({ ...empty, days: [day("12:00", "13:30")] }).emptyReason).toBe("meal_conflict");
    expect(findFreeWindows({ ...empty, days: [day("08:00", "11:00")], mode: "meal" }).emptyReason).toBe("meal_conflict");
  });
});

describe("normalizeMealBlocks", () => {
  it("validates, sorts and rejects overlaps", () => {
    expect(normalizeMealBlocks([{ label: "晚饭", start: "17:30", end: "18:30" }, { label: "午饭", start: "12:00", end: "13:30" }])).toEqual([
      { label: "午饭", start: "12:00", end: "13:30" },
      { label: "晚饭", start: "17:30", end: "18:30" },
    ]);
    expect(normalizeMealBlocks([])).toEqual([]);
    expect(typeof normalizeMealBlocks([{ label: "午饭", start: "12:10", end: "13:00" }])).toBe("string");
    expect(typeof normalizeMealBlocks([{ label: "", start: "12:00", end: "13:00" }])).toBe("string");
    expect(
      typeof normalizeMealBlocks([
        { label: "a", start: "12:00", end: "13:00" },
        { label: "b", start: "12:30", end: "13:30" },
      ]),
    ).toBe("string");
    expect(typeof normalizeMealBlocks("x")).toBe("string");
  });
});

describe("buildDays", () => {
  it("starts now rounded up to 15 minutes and filters weekdays", () => {
    const days = buildDays({
      now: Date.parse("2026-11-09T10:07:00+08:00"), // 周一
      days: 7,
      dayStartMinutes: 8 * 60,
      dayEndMinutes: 22 * 60,
      weekdays: [1, 2, 6],
    });
    expect(days.map((d) => d.date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-14"]);
    expect(toLocalIso(days[0]!.start)).toBe("2026-11-09T10:15:00+08:00");
    expect(toLocalIso(days[1]!.start)).toBe("2026-11-10T08:00:00+08:00");
    expect(toLocalIso(days[1]!.end)).toBe("2026-11-10T22:00:00+08:00");
  });

  it("starts from a later date when asked, never before today", () => {
    const now = Date.parse("2026-11-10T10:07:00+08:00");
    const options = { now, days: 2, dayStartMinutes: 8 * 60, dayEndMinutes: 22 * 60, weekdays: [1, 2, 3, 4, 5, 6, 7] };
    expect(buildDays({ ...options, fromDate: "2026-11-16" }).map((d) => d.date)).toEqual(["2026-11-16", "2026-11-17"]);
    const past = buildDays({ ...options, fromDate: "2026-11-01" });
    expect(past.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-11"]);
    expect(toLocalIso(past[0]!.start)).toBe("2026-11-10T10:15:00+08:00");
  });

  it("skips today when the window has passed and supports 24:00", () => {
    const days = buildDays({
      now: Date.parse("2026-11-09T23:30:00+08:00"),
      days: 2,
      dayStartMinutes: 0,
      dayEndMinutes: parseClock("24:00")!,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(days.map((d) => [d.date, toLocalIso(d.start), toLocalIso(d.end)])).toEqual([
      ["2026-11-09", "2026-11-09T23:30:00+08:00", "2026-11-10T00:00:00+08:00"],
      ["2026-11-10", "2026-11-10T00:00:00+08:00", "2026-11-11T00:00:00+08:00"],
    ]);
    expect(parseClock("24:30")).toBeNull();
    expect(parseClock("9:00")).toBeNull();
  });
});
