/**
 * Time-series aggregation — report Sections 6.2 and 26.1.
 *
 *   "Prefix Sums | Fast reporting over time buckets |
 *    O(n) preprocess, O(1) range sum"
 *   "Dashboard time windows | Sliding window / prefix sums |
 *    Precompute daily buckets; answer range queries quickly"
 *
 * A dashboard asks the same shape of question repeatedly: how much in the last
 * 7 days, the last 30, this month versus last. Summing the raw slice each time
 * is O(n) per question, so a page with a dozen tiles re-walks the same array a
 * dozen times.
 *
 * A prefix-sum array is built once in O(n) and answers every range in O(1) by
 * subtraction. For a year of daily buckets that is 365 additions once, instead
 * of a few thousand across the page.
 *
 * Pure functions over `{ day, value }` series. No Prisma, no dates beyond the
 * `YYYY-MM-DD` key.
 */

export interface DailyPoint {
  /** `YYYY-MM-DD`. Sorts lexicographically, which is also chronologically. */
  day: string;
  value: number;
  count?: number;
}

/** Add days to a `YYYY-MM-DD` key, staying in UTC. */
export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Every day from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * Fill gaps so the series is contiguous.
 *
 * This is the precondition for prefix sums: index arithmetic only maps to dates
 * if every day is present. A source query returns nothing for days with no
 * activity, and treating those as absent rather than zero would silently shift
 * every later index — the numbers would look plausible and be wrong.
 */
export function densify(points: readonly DailyPoint[], from: string, to: string): DailyPoint[] {
  const byDay = new Map(points.map((p) => [p.day, p]));
  return dateRange(from, to).map((day) => byDay.get(day) ?? { day, value: 0, count: 0 });
}

/**
 * Prefix sums over a dense series.
 *
 * `prefix[i]` is the total of days `0..i-1`, so `prefix` has length n+1 and
 * `prefix[0] === 0`. That leading zero is what removes the boundary special
 * case from every range query below.
 *
 * O(n) once.
 */
export class TimeSeries {
  private readonly days: string[];
  private readonly index: Map<string, number>;
  private readonly prefix: number[];
  private readonly counts: number[];

  constructor(points: readonly DailyPoint[]) {
    this.days = points.map((p) => p.day);
    this.index = new Map(this.days.map((day, i) => [day, i]));

    this.prefix = new Array<number>(points.length + 1);
    this.counts = new Array<number>(points.length + 1);
    this.prefix[0] = 0;
    this.counts[0] = 0;

    for (let i = 0; i < points.length; i += 1) {
      this.prefix[i + 1] = this.prefix[i]! + points[i]!.value;
      this.counts[i + 1] = this.counts[i]! + (points[i]!.count ?? 0);
    }
  }

  get length(): number {
    return this.days.length;
  }

  /** Total across the whole series. O(1). */
  get total(): number {
    return this.prefix[this.prefix.length - 1]!;
  }

  /**
   * Sum over `[from, to]` inclusive. O(1).
   *
   * Bounds are clamped rather than rejected, so a window extending before the
   * series simply returns what exists — a dashboard asking for 30 days on a
   * two-week-old organization should show two weeks, not an error.
   */
  sum(from: string, to: string): number {
    const range = this.resolve(from, to);
    if (!range) return 0;
    return this.prefix[range.end + 1]! - this.prefix[range.start]!;
  }

  /** Source-row count over a range, for averages. O(1). */
  count(from: string, to: string): number {
    const range = this.resolve(from, to);
    if (!range) return 0;
    return this.counts[range.end + 1]! - this.counts[range.start]!;
  }

  /** Mean per day over a range — zero days included, which is usually intended. */
  averagePerDay(from: string, to: string): number {
    const range = this.resolve(from, to);
    if (!range) return 0;
    const days = range.end - range.start + 1;
    return this.sum(from, to) / days;
  }

  /** The last `n` days of the series, ending at its final day. O(1). */
  trailing(days: number): number {
    if (this.days.length === 0) return 0;
    const last = this.days[this.days.length - 1]!;
    return this.sum(addDays(last, -(days - 1)), last);
  }

  /**
   * Compare the trailing window against the one immediately before it.
   *
   * Both halves are O(1), so "up 12% on the previous 30 days" costs two
   * subtractions rather than two scans.
   */
  compareTrailing(days: number): {
    current: number;
    previous: number;
    changePercent: number | null;
  } {
    if (this.days.length === 0) return { current: 0, previous: 0, changePercent: null };

    const last = this.days[this.days.length - 1]!;
    const currentFrom = addDays(last, -(days - 1));
    const current = this.sum(currentFrom, last);
    const previous = this.sum(addDays(currentFrom, -days), addDays(currentFrom, -1));

    return {
      current,
      previous,
      // Null rather than Infinity or 100%: growth from zero has no meaningful
      // percentage, and rendering one invents a number.
      changePercent: previous === 0 ? null : ((current - previous) / previous) * 100,
    };
  }

  /** The raw series, for charting. */
  points(): DailyPoint[] {
    return this.days.map((day, i) => ({
      day,
      value: this.prefix[i + 1]! - this.prefix[i]!,
      count: this.counts[i + 1]! - this.counts[i]!,
    }));
  }

  private resolve(from: string, to: string): { start: number; end: number } | null {
    if (this.days.length === 0) return null;

    const first = this.days[0]!;
    const last = this.days[this.days.length - 1]!;
    // Clamp into the series rather than rejecting.
    const lo = from < first ? first : from;
    const hi = to > last ? last : to;
    if (lo > hi) return null;

    const start = this.index.get(lo);
    const end = this.index.get(hi);
    if (start === undefined || end === undefined) return null;
    return { start, end };
  }
}

/**
 * Rolling average over a fixed window — the sliding-window half of Section 26.1.
 *
 * One pass, adding the entering day and removing the leaving one, rather than
 * re-summing the window at every step. O(n) instead of O(n·k), which is what
 * makes a 7-day average over a year cheap enough to compute on request.
 */
export function rollingAverage(points: readonly DailyPoint[], window: number): DailyPoint[] {
  if (window <= 0) throw new Error('Window must be positive');

  const out: DailyPoint[] = [];
  let runningSum = 0;

  for (let i = 0; i < points.length; i += 1) {
    runningSum += points[i]!.value;
    if (i >= window) runningSum -= points[i - window]!.value;

    const size = Math.min(i + 1, window);
    out.push({ day: points[i]!.day, value: runningSum / size });
  }

  return out;
}
