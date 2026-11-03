import { TextInput } from "../components/Field";
import { Button } from "../components/Button";

export function WeeksField({
  value,
  count,
  onChange,
}: {
  value: string;
  count: number;
  onChange: (value: string) => void;
}) {
  const selected = JSON.parse(value || "[]") as number[];
  return (
    <div className="flex flex-wrap gap-2">
      {Array.from({ length: count }, (_, i) => i + 1).map((week) => (
        <label
          key={week}
          className="inline-flex min-h-9 items-center gap-1 rounded border border-slate-200 px-2 text-sm dark:border-slate-700"
        >
          <input
            type="checkbox"
            checked={selected.includes(week)}
            onChange={(e) =>
              onChange(
                JSON.stringify(
                  e.target.checked
                    ? [...selected, week].sort((a, b) => a - b)
                    : selected.filter((w) => w !== week),
                ),
              )
            }
          />
          第 {week} 周
        </label>
      ))}
    </div>
  );
}
export function PeriodsField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const periods = JSON.parse(value || "[]") as {
    index: number;
    start: string;
    end: string;
  }[];
  const change = (i: number, patch: Partial<(typeof periods)[number]>) =>
    onChange(
      JSON.stringify(periods.map((p, n) => (n === i ? { ...p, ...patch } : p))),
    );
  return (
    <div className="space-y-3">
      {periods.map((p, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <TextInput
            aria-label={`第 ${i + 1} 行节次`}
            type="number"
            min={1}
            className="!w-16"
            value={p.index}
            onChange={(e) => change(i, { index: Number(e.target.value) })}
          />
          <TextInput
            aria-label={`第 ${p.index} 节开始时间`}
            type="time"
            className="!w-32"
            value={p.start}
            onChange={(e) => change(i, { start: e.target.value })}
          />
          <span>至</span>
          <TextInput
            aria-label={`第 ${p.index} 节结束时间`}
            type="time"
            className="!w-32"
            value={p.end}
            onChange={(e) => change(i, { end: e.target.value })}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange(JSON.stringify(periods.filter((_, n) => n !== i)))
            }
          >
            移除此节
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          onChange(
            JSON.stringify([
              ...periods,
              {
                index: Math.max(0, ...periods.map((p) => p.index)) + 1,
                start: "",
                end: "",
              },
            ]),
          )
        }
      >
        添加节次
      </Button>
    </div>
  );
}
