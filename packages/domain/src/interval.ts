/**
 * Interval algorithms — report Section 26.1.
 *
 *   "Attendance overlap detection | Interval merging |
 *    Sort intervals then merge; detect conflicting sessions"
 *
 * Attendance is not a single timestamp pair. A day is one work session with
 * breaks punched inside it, and the numbers people actually care about —
 * hours worked, overtime, whether two sessions conflict — all reduce to
 * arithmetic on intervals.
 *
 * The naive version compares every pair, which is O(n²). Sorting by start
 * first makes one linear pass enough, because once intervals are ordered, an
 * interval can only overlap the one immediately before it in the merged run.
 * O(n log n), dominated by the sort.
 *
 * Milliseconds throughout, and half-open [start, end): a break ending at
 * 13:45 and work resuming at 13:45 do not overlap. Treating them as closed
 * would report a one-instant conflict on every legitimate resume.
 */

export interface Interval {
  start: number;
  end: number;
}

/** Ascending by start, then by end. The precondition for every pass below. */
function sorted(intervals: readonly Interval[]): Interval[] {
  return [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** An interval is valid when it has positive length. */
export function isValid(interval: Interval): boolean {
  return interval.end > interval.start;
}

/**
 * Merge overlapping and touching intervals into the smallest equivalent set.
 *
 * Touching intervals are merged — [9,10) and [10,11) become [9,11) — because
 * for duration purposes there is no gap between them. Overlap detection uses a
 * strict test instead, which is why the two are separate functions.
 *
 * O(n log n) time, O(n) space.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const valid = intervals.filter(isValid);
  if (valid.length === 0) return [];

  const order = sorted(valid);
  const merged: Interval[] = [{ ...order[0]! }];

  for (let i = 1; i < order.length; i += 1) {
    const current = order[i]!;
    const last = merged[merged.length - 1]!;

    if (current.start <= last.end) {
      // Overlaps or touches. Extend rather than append — and take the MAX end,
      // because a fully-contained interval must not shrink the run.
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

export interface Overlap {
  a: Interval;
  b: Interval;
  /** The overlapping region itself. */
  region: Interval;
}

/**
 * Find every pair that genuinely overlaps.
 *
 * Strict `<`, so touching intervals are NOT reported: clocking out of a break
 * at 13:45 and resuming work at 13:45 is correct behaviour, not a conflict.
 *
 * Still O(n²) in the worst case, but only because the output can be that large
 * — every pair can genuinely overlap. The scan itself breaks out as soon as a
 * later interval starts after the current one ends, which on real attendance
 * data (a handful of intervals per day, rarely overlapping) is effectively
 * linear.
 */
export function findOverlaps(intervals: readonly Interval[]): Overlap[] {
  const order = sorted(intervals.filter(isValid));
  const overlaps: Overlap[] = [];

  for (let i = 0; i < order.length; i += 1) {
    const a = order[i]!;
    for (let j = i + 1; j < order.length; j += 1) {
      const b = order[j]!;
      // Sorted by start, so nothing after this can overlap `a` either.
      if (b.start >= a.end) break;
      overlaps.push({
        a,
        b,
        region: { start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) },
      });
    }
  }

  return overlaps;
}

/** Does `candidate` overlap anything in `existing`? */
export function overlapsAny(candidate: Interval, existing: readonly Interval[]): boolean {
  return existing.some((other) => candidate.start < other.end && other.start < candidate.end);
}

/**
 * Total covered time, in milliseconds.
 *
 * Merges first, so overlapping intervals are not double-counted. Summing
 * `end - start` directly is the bug this exists to prevent: two overlapping
 * breaks would subtract more time than the employee actually took.
 */
export function totalDuration(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((total, i) => total + (i.end - i.start), 0);
}

/**
 * Remove `holes` from `base` — work minus breaks.
 *
 * Both sides are merged first so the walk only ever compares one base run
 * against one hole run. O(n log n).
 */
export function subtractIntervals(
  base: readonly Interval[],
  holes: readonly Interval[],
): Interval[] {
  const merged = mergeIntervals(base);
  const cuts = mergeIntervals(holes);
  const result: Interval[] = [];

  for (const segment of merged) {
    let cursor = segment.start;

    for (const cut of cuts) {
      if (cut.end <= cursor) continue; // entirely before what is left
      if (cut.start >= segment.end) break; // sorted, so nothing later applies

      if (cut.start > cursor) result.push({ start: cursor, end: cut.start });
      cursor = Math.max(cursor, cut.end);
      if (cursor >= segment.end) break;
    }

    if (cursor < segment.end) result.push({ start: cursor, end: segment.end });
  }

  return result;
}

/** Restrict intervals to a window, dropping anything wholly outside it. */
export function clampToWindow(intervals: readonly Interval[], window: Interval): Interval[] {
  return intervals
    .map((i) => ({
      start: Math.max(i.start, window.start),
      end: Math.min(i.end, window.end),
    }))
    .filter(isValid);
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export interface WorkSummary {
  /** Clock-in to clock-out, breaks included. */
  grossMs: number;
  /** Breaks removed. This is the number that counts as worked. */
  netMs: number;
  breakMs: number;
  /** Beyond the expected day. */
  overtimeMs: number;
  /** Short of the expected day. */
  shortfallMs: number;
  overlaps: Overlap[];
}

/**
 * Reduce one day of punches to the numbers a payroll or timesheet needs.
 *
 * Sessions are merged before subtracting breaks, so a duplicate clock-in — the
 * most common attendance data error — inflates nothing.
 */
export function summariseWork(
  sessions: readonly Interval[],
  breaks: readonly Interval[],
  expectedMs: number,
): WorkSummary {
  const merged = mergeIntervals(sessions);
  const grossMs = totalDuration(merged);

  // Breaks outside a work session are meaningless, so clamp them into it
  // before counting. Otherwise a stray punch could subtract more than was
  // worked and produce negative hours.
  const relevantBreaks = merged.flatMap((session) => clampToWindow(breaks, session));
  const breakMs = totalDuration(relevantBreaks);

  const netMs = totalDuration(subtractIntervals(merged, relevantBreaks));

  return {
    grossMs,
    netMs,
    breakMs,
    overtimeMs: Math.max(0, netMs - expectedMs),
    shortfallMs: Math.max(0, expectedMs - netMs),
    // Reported on the RAW sessions, not the merged ones: merging is exactly
    // what would hide a double clock-in from whoever needs to correct it.
    overlaps: findOverlaps(sessions),
  };
}

/** Milliseconds as `7h 45m`, for display. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0h 0m';
  const totalMinutes = Math.floor(ms / 60_000);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}
