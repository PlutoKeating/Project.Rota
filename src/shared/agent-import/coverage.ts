/** Half-open coordinates supplied by file readers, never inferred business regions. */
export type Rect = [number, number, number, number];
export interface CoverageRead {
  key: string;
  extent: Rect;
  region: Rect;
}
export type CoverageState = Record<string, { extent: Rect; regions: Rect[] }>;
export function recordCoverage(state: CoverageState, reads: CoverageRead[]) {
  for (const { key, extent, region } of reads) {
    const previous = state[key];
    const item =
      previous && JSON.stringify(previous.extent) === JSON.stringify(extent)
        ? previous
        : { extent, regions: [] };
    const clipped: Rect = [
      Math.max(extent[0], region[0]),
      Math.max(extent[1], region[1]),
      Math.min(extent[2], region[2]),
      Math.min(extent[3], region[3]),
    ];
    const contains = (a: Rect, b: Rect) =>
      a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
    if (
      clipped[0] < clipped[2] &&
      clipped[1] < clipped[3] &&
      !item.regions.some((r) => contains(r, clipped))
    )
      item.regions = [
        ...item.regions.filter((r) => !contains(clipped, r)),
        clipped,
      ];
    state[key] = item;
  }
}
export function isCovered(state: CoverageState, key: string) {
  const item = state[key];
  if (!item) return false;
  const [x0, y0, x1, y1] = item.extent;
  if (x0 >= x1 || y0 >= y1) return true;
  const xs = [
    ...new Set([x0, x1, ...item.regions.flatMap((r) => [r[0], r[2]])]),
  ].sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) {
    let end = y0;
    const ys = item.regions
      .filter((r) => r[0] <= xs[i] && r[2] >= xs[i + 1])
      .map((r) => [r[1], r[3]])
      .sort((a, b) => a[0] - b[0]);
    for (const [start, stop] of ys) {
      if (start > end) break;
      end = Math.max(end, stop);
    }
    if (end < y1) return false;
  }
  return true;
}
export function completePages(state: CoverageState): number[] {
  if (
    Object.keys(state).some(
      (k) => !k.startsWith("page:") && !isCovered(state, k),
    )
  )
    return [];
  return Object.keys(state)
    .filter((k) => k.startsWith("page:") && isCovered(state, k))
    .map((k) => Number(k.slice(5)))
    .sort((a, b) => a - b);
}
