import { describe, expect, it } from "vitest";
import { buildDays, findFreeWindows, parseClock, toLocalIso, type BusyInterval, type TimeInterval } from "../src/shared/free-windows";
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

describe("findFreeWindows", () => {
  it("ranks by headcount, then duration, then time, without overlaps", () => {
    const result = findFreeWindows({
      people: people("A", "B", "C"),
      days: [day("08:00", "12:00")],
      busy: busy({ A: [["09:00", "10:00"]], B: [["10:30", "11:00"]] }),
      unknown: new Map(),
      count: 3,
    });
    expect(result.emptyReason).toBeNull();
    expect(result.windows.map(span)).toEqual(["08:00-09:00", "11:00-12:00", "09:00-10:30"]);
    expect(result.windows.map((w) => w.free.length)).toEqual([3, 3, 2]);
    expect(result.windows[2]!.busy).toEqual([{ personId: "A", reason: "course", label: "课" }]);
  });

  it("extends the same group as long as possible, floored to 30 minutes, at least 1 hour, no cap", () => {
    const one = findFreeWindows({
      people: people("A"),
      days: [day("08:00", "22:00")],
      busy: busy({ A: [["09:45", "10:20"]] }),
      unknown: new Map(),
      count: 2,
    });
    // 08:00–09:45 → 90 分钟；10:30（10:20 所在格之后）–22:00 → 690 分钟，排在更长者优先。
    expect(one.windows.map(span)).toEqual(["10:30-22:00", "08:00-09:30"]);
    expect(one.windows.map((w) => w.minutes)).toEqual([690, 90]);
  });

  it("drops windows shorter than one hour", () => {
    const result = findFreeWindows({
      people: people("A"),
      days: [day("08:00", "10:00")],
      busy: busy({ A: [["08:50", "09:30"]] }),
      unknown: new Map(),
      count: 5,
    });
    expect(result.windows).toEqual([]);
    expect(result.emptyReason).toBe("no_free_time");
  });

  it("requires every required person to be free", () => {
    const team: FreeWindowPerson[] = [
      { id: "lead", fullName: "lead", required: true },
      ...people("A", "B"),
    ];
    const result = findFreeWindows({
      people: team,
      days: [day("08:00", "12:00")],
      busy: busy({ A: [["08:00", "10:00"]], B: [["08:00", "10:00"]], lead: [["10:00", "12:00"]] }),
      unknown: new Map(),
      count: 5,
    });
    expect(result.windows.map(span)).toEqual(["08:00-10:00"]);
    expect(result.windows[0]!.free).toEqual(["lead"]);

    const blocked = findFreeWindows({
      people: team,
      days: [day("08:00", "12:00")],
      busy: busy({ lead: [["08:00", "12:00"]] }),
      unknown: new Map(),
      count: 5,
    });
    expect(blocked.emptyReason).toBe("required_unavailable");
  });

  it("never counts unknown people as free", () => {
    const unknown = new Map<string, TimeInterval[]>([["B", [{ start: at("08:00"), end: at("12:00") }]]]);
    const result = findFreeWindows({
      people: people("A", "B"),
      days: [day("08:00", "12:00")],
      busy: new Map(),
      unknown,
      count: 1,
    });
    expect(result.windows[0]).toMatchObject({ free: ["A"], unknown: ["B"], busy: [], minutes: 240 });
    expect(result.heatmap[0]!.free.slice(0, 2)).toEqual([1, 1]);
    expect(result.heatmap[0]!.unknown.slice(0, 2)).toEqual([1, 1]);
  });

  it("handles more than 32 people across bitset words", () => {
    const ids = Array.from({ length: 70 }, (_, i) => `p${i}`);
    const result = findFreeWindows({
      people: people(...ids),
      days: [day("08:00", "11:00")],
      busy: busy({ p69: [["08:00", "09:00"]] }),
      unknown: new Map(),
      count: 2,
    });
    expect(result.windows.map((w) => [span(w), w.free.length])).toEqual([
      ["09:00-11:00", 70],
      ["08:00-09:00", 69],
    ]);
  });

  it("reports empty inputs", () => {
    expect(findFreeWindows({ people: people("A"), days: [], busy: new Map(), unknown: new Map(), count: 1 }).emptyReason).toBe("no_days");
    expect(
      findFreeWindows({ people: people("A"), days: [day("08:00", "08:45")], busy: new Map(), unknown: new Map(), count: 1 }).emptyReason,
    ).toBe("window_too_short");
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
