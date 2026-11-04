// Compare explicit expected facts (review their provenance before treating them as ground truth) with a real-run result.
// This verifier never reads or interprets source documents and is not imported by the app.
import fs from "node:fs/promises";
const [resultPath, ...expectedPaths] = process.argv.slice(2);
if (!resultPath || !expectedPaths.length)
  throw Error(
    "Usage: node test/live/compare.mjs PRIVATE_RESULT_JSON PRIVATE_EXPECTED_JSON...",
  );
const raw = JSON.parse(await fs.readFile(resultPath, "utf8"));
const job = raw.job ?? raw;
const proposals = Object.values(job.timetables ?? {});
const normalized = (value) =>
  String(value).normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
function facts(entries, includeName = true, aliases = new Map()) {
  const counts = new Map();
  for (const e of entries) {
    if (
      e.weekday == null ||
      e.period_from == null ||
      e.period_to == null ||
      !Array.isArray(e.weeks)
    )
      continue;
    for (const w of new Set(e.weeks))
      for (let p = e.period_from; p <= e.period_to; p++) {
        const key = JSON.stringify([
          ...(includeName
            ? [aliases.get(normalized(e.name)) ?? normalized(e.name)]
            : []),
          e.weekday,
          w,
          p,
        ]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
  }
  return counts;
}
function compare(expected, actual) {
  const missing = [],
    extra = [];
  let matched = 0;
  for (const [key, count] of expected) {
    const n = actual.get(key) ?? 0;
    matched += Math.min(n, count);
    if (n < count) missing.push({ fact: JSON.parse(key), count: count - n });
  }
  for (const [key, count] of actual) {
    const n = expected.get(key) ?? 0;
    if (n < count) extra.push({ fact: JSON.parse(key), count: count - n });
  }
  return {
    expected: [...expected.values()].reduce((a, b) => a + b, 0),
    actual: [...actual.values()].reduce((a, b) => a + b, 0),
    matched,
    missing,
    extra,
  };
}
const cases = [];
for (const file of expectedPaths) {
  const expected = JSON.parse(await fs.readFile(file, "utf8"));
  const matches = proposals.filter((p) =>
    expected.person.student_no
      ? p.person.student_no === expected.person.student_no
      : p.person.full_name === expected.person.full_name,
  );
  const people = new Set(matches.map((p) => p.person.id));
  const entries = matches.flatMap((p) => p.entries);
  const identity =
    people.size === 1 &&
    matches.every((p) =>
      Object.entries(expected.person).every(([k, v]) => p.person[k] === v),
    );
  const aliases = new Map();
  for (const [name, variants] of Object.entries(expected.nameAliases ?? {}))
    for (const variant of variants) {
      const key = normalized(variant),
        value = normalized(name);
      if (aliases.has(key) && aliases.get(key) !== value)
        throw Error("Ambiguous expected name alias");
      aliases.set(key, value);
    }
  const named = compare(
    facts(expected.scheduled, true, aliases),
    facts(entries, true, aliases),
  );
  const occupied = compare(
    facts(expected.scheduled, false),
    facts(entries, false),
  );
  const absentUnscheduled = (expected.unscheduled ?? []).filter(
    (name) =>
      !entries.some(
        (e) =>
          (aliases.get(normalized(e.name)) ?? normalized(e.name)) ===
          normalized(name),
      ),
  );
  const organizations = (expected.organizationIds ?? []).every((id) =>
    matches.some((p) => p.organization_ids.includes(id)),
  );
  // Explicit operator-reviewed field assertions, separate from occupied-period coverage.
  const fieldFailures = (expected.entryFields ?? []).flatMap((check) => {
    const selected = entries.filter((entry) =>
      Object.entries(check.where).every(([key, value]) =>
        key === "name"
          ? (aliases.get(normalized(entry.name)) ?? normalized(entry.name)) ===
            normalized(value)
          : JSON.stringify(entry[key]) === JSON.stringify(value),
      ),
    );
    if (!selected.length)
      return [{ where: check.where, error: "no matching course" }];
    return selected.flatMap((entry) =>
      Object.entries(check.fields).flatMap(([field, value]) =>
        (entry[field] ?? null) === value
          ? []
          : [
              {
                where: check.where,
                field,
                expected: value,
                actual: entry[field] ?? null,
              },
            ],
      ),
    );
  });
  cases.push({
    person: expected.person.full_name,
    identity,
    organizations,
    named,
    occupied,
    absentUnscheduled,
    fieldFailures,
    pass:
      identity &&
      organizations &&
      !named.missing.length &&
      (expected.allowAdditionalScheduled || !named.extra.length) &&
      !absentUnscheduled.length &&
      !fieldFailures.length,
  });
}
console.log(
  JSON.stringify({ cases, pass: cases.every((c) => c.pass) }, null, 2),
);
if (cases.some((c) => !c.pass)) process.exitCode = 1;
