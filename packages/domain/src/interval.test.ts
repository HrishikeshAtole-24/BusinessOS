import { describe, expect, it } from 'vitest';
import {
  clampToWindow,
  findOverlaps,
  formatDuration,
  mergeIntervals,
  overlapsAny,
  subtractIntervals,
  summariseWork,
  totalDuration,
  type Interval,
} from './interval.js';

/** Minutes past midnight, in ms — readable test fixtures. */
const at = (hours: number, minutes = 0) => (hours * 60 + minutes) * 60_000;
const span = (fromH: number, fromM: number, toH: number, toM: number): Interval => ({
  start: at(fromH, fromM),
  end: at(toH, toM),
});
const HOUR = 3_600_000;

describe('mergeIntervals', () => {
  it('leaves disjoint intervals alone', () => {
    const result = mergeIntervals([span(9, 0, 11, 0), span(13, 0, 15, 0)]);
    expect(result).toHaveLength(2);
  });

  it('merges overlapping intervals', () => {
    const result = mergeIntervals([span(9, 0, 12, 0), span(11, 0, 14, 0)]);
    expect(result).toEqual([span(9, 0, 14, 0)]);
  });

  it('merges touching intervals', () => {
    // For duration purposes there is no gap between 10:00 and 10:00.
    expect(mergeIntervals([span(9, 0, 10, 0), span(10, 0, 11, 0)])).toEqual([span(9, 0, 11, 0)]);
  });

  it('does not let a contained interval shrink the run', () => {
    // Taking `current.end` instead of the max here is the classic merge bug.
    expect(mergeIntervals([span(9, 0, 18, 0), span(12, 0, 13, 0)])).toEqual([span(9, 0, 18, 0)]);
  });

  it('sorts before merging, so input order does not matter', () => {
    const forwards = mergeIntervals([span(9, 0, 11, 0), span(10, 0, 12, 0)]);
    const backwards = mergeIntervals([span(10, 0, 12, 0), span(9, 0, 11, 0)]);
    expect(backwards).toEqual(forwards);
  });

  it('drops zero-length and inverted intervals', () => {
    expect(mergeIntervals([span(9, 0, 9, 0)])).toEqual([]);
    expect(mergeIntervals([{ start: at(11), end: at(9) }])).toEqual([]);
  });

  it('collapses a long chain into one', () => {
    const chain = Array.from({ length: 50 }, (_, i) => ({
      start: at(0, i * 10),
      end: at(0, i * 10 + 15),
    }));
    expect(mergeIntervals(chain)).toHaveLength(1);
  });

  it('handles an empty input', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('findOverlaps', () => {
  it('finds nothing in a clean day', () => {
    expect(findOverlaps([span(9, 0, 13, 0), span(14, 0, 18, 0)])).toEqual([]);
  });

  it('does not report touching intervals as a conflict', () => {
    // Clocking out of a break at 13:45 and resuming at 13:45 is correct, not a
    // conflict. A closed-interval test would flag every legitimate resume.
    expect(findOverlaps([span(13, 0, 13, 45), span(13, 45, 18, 0)])).toEqual([]);
  });

  it('reports a genuine double clock-in with the overlapping region', () => {
    const overlaps = findOverlaps([span(9, 0, 13, 0), span(12, 0, 17, 0)]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.region).toEqual(span(12, 0, 13, 0));
  });

  it('finds every pair when three sessions overlap', () => {
    expect(findOverlaps([span(9, 0, 12, 0), span(10, 0, 13, 0), span(11, 0, 14, 0)])).toHaveLength(
      3,
    );
  });
});

describe('overlapsAny', () => {
  it('rejects a session that collides with an existing one', () => {
    expect(overlapsAny(span(12, 0, 14, 0), [span(9, 0, 13, 0)])).toBe(true);
  });

  it('allows a session that starts exactly when another ends', () => {
    expect(overlapsAny(span(13, 0, 18, 0), [span(9, 0, 13, 0)])).toBe(false);
  });

  it('is true against an empty set only when nothing exists', () => {
    expect(overlapsAny(span(9, 0, 18, 0), [])).toBe(false);
  });
});

describe('totalDuration', () => {
  it('sums disjoint intervals', () => {
    expect(totalDuration([span(9, 0, 11, 0), span(13, 0, 14, 0)])).toBe(3 * HOUR);
  });

  it('does not double-count overlapping intervals', () => {
    // The reason this merges first. Summing end - start directly gives 6h and
    // would subtract more break time than was actually taken.
    expect(totalDuration([span(9, 0, 13, 0), span(11, 0, 13, 0)])).toBe(4 * HOUR);
  });
});

describe('subtractIntervals', () => {
  it('cuts a hole in the middle', () => {
    expect(subtractIntervals([span(9, 0, 18, 0)], [span(13, 0, 14, 0)])).toEqual([
      span(9, 0, 13, 0),
      span(14, 0, 18, 0),
    ]);
  });

  it('trims from the start', () => {
    expect(subtractIntervals([span(9, 0, 18, 0)], [span(8, 0, 10, 0)])).toEqual([
      span(10, 0, 18, 0),
    ]);
  });

  it('returns nothing when the hole covers everything', () => {
    expect(subtractIntervals([span(9, 0, 18, 0)], [span(8, 0, 19, 0)])).toEqual([]);
  });

  it('applies several holes', () => {
    const result = subtractIntervals(
      [span(9, 0, 18, 0)],
      [span(11, 0, 11, 15), span(13, 0, 14, 0), span(16, 0, 16, 15)],
    );
    expect(result).toHaveLength(4);
    expect(totalDuration(result)).toBe(9 * HOUR - 90 * 60_000);
  });

  it('ignores holes outside the base', () => {
    expect(subtractIntervals([span(9, 0, 13, 0)], [span(15, 0, 16, 0)])).toEqual([
      span(9, 0, 13, 0),
    ]);
  });

  it('handles overlapping holes without over-subtracting', () => {
    const result = subtractIntervals([span(9, 0, 18, 0)], [span(12, 0, 14, 0), span(13, 0, 15, 0)]);
    expect(result).toEqual([span(9, 0, 12, 0), span(15, 0, 18, 0)]);
  });
});

describe('clampToWindow', () => {
  it('trims to the window and drops what falls outside', () => {
    const result = clampToWindow(
      [span(8, 0, 10, 0), span(12, 0, 13, 0), span(19, 0, 20, 0)],
      span(9, 0, 18, 0),
    );
    expect(result).toEqual([span(9, 0, 10, 0), span(12, 0, 13, 0)]);
  });
});

describe('summariseWork — the report example (Section 5)', () => {
  it('reproduces the 09:42 to 18:58 day with a 40 minute break', () => {
    // The report's own worked example:
    //   09:42 in, 13:05 break, 13:45 resume, 18:58 out  ->  8h 36m
    const summary = summariseWork([span(9, 42, 18, 58)], [span(13, 5, 13, 45)], 8 * HOUR);

    expect(formatDuration(summary.grossMs)).toBe('9h 16m');
    expect(formatDuration(summary.breakMs)).toBe('0h 40m');
    expect(formatDuration(summary.netMs)).toBe('8h 36m');
    expect(formatDuration(summary.overtimeMs)).toBe('0h 36m');
    expect(summary.shortfallMs).toBe(0);
  });

  it('reports a shortfall on a short day', () => {
    const summary = summariseWork([span(10, 0, 15, 0)], [], 8 * HOUR);
    expect(formatDuration(summary.netMs)).toBe('5h 0m');
    expect(formatDuration(summary.shortfallMs)).toBe('3h 0m');
    expect(summary.overtimeMs).toBe(0);
  });

  it('never reports both overtime and shortfall', () => {
    for (const [from, to] of [
      [9, 12],
      [9, 17],
      [9, 21],
    ] as const) {
      const summary = summariseWork([span(from, 0, to, 0)], [], 8 * HOUR);
      expect(summary.overtimeMs === 0 || summary.shortfallMs === 0).toBe(true);
    }
  });

  it('does not inflate hours from a duplicate clock-in', () => {
    // The most common attendance data error. Merging first is what stops it
    // reading as sixteen hours.
    const summary = summariseWork([span(9, 0, 17, 0), span(9, 0, 17, 0)], [], 8 * HOUR);
    expect(formatDuration(summary.netMs)).toBe('8h 0m');
  });

  it('still surfaces the duplicate as an overlap to correct', () => {
    // Merging fixes the number; it must not hide the underlying bad data from
    // whoever has to fix the punch record.
    const summary = summariseWork([span(9, 0, 17, 0), span(16, 0, 20, 0)], [], 8 * HOUR);
    expect(summary.overlaps).toHaveLength(1);
  });

  it('ignores a break punched outside the work session', () => {
    // Without clamping, this would subtract more than was worked and produce
    // negative hours.
    const summary = summariseWork([span(9, 0, 17, 0)], [span(20, 0, 22, 0)], 8 * HOUR);
    expect(formatDuration(summary.netMs)).toBe('8h 0m');
    expect(summary.netMs).toBeGreaterThanOrEqual(0);
  });

  it('never produces negative net hours', () => {
    const summary = summariseWork([span(9, 0, 17, 0)], [span(0, 0, 23, 59)], 8 * HOUR);
    expect(summary.netMs).toBeGreaterThanOrEqual(0);
  });

  it('handles a split shift', () => {
    const summary = summariseWork([span(6, 0, 10, 0), span(16, 0, 20, 0)], [], 8 * HOUR);
    expect(formatDuration(summary.netMs)).toBe('8h 0m');
    expect(summary.overlaps).toEqual([]);
  });
});

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(0)).toBe('0h 0m');
    expect(formatDuration(-500)).toBe('0h 0m');
    expect(formatDuration(90 * 60_000)).toBe('1h 30m');
    expect(formatDuration(8 * HOUR)).toBe('8h 0m');
  });
});
