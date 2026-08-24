import { describe, expect, it } from 'vitest';
import {
  TimeSeries,
  addDays,
  dateRange,
  densify,
  rollingAverage,
  type DailyPoint,
} from './timeseries';

const series = (values: number[], from = '2026-01-01'): DailyPoint[] =>
  values.map((value, i) => ({ day: addDays(from, i), value, count: value > 0 ? 1 : 0 }));

describe('addDays and dateRange', () => {
  it('moves forward and backward', () => {
    expect(addDays('2026-01-01', 1)).toBe('2026-01-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('crosses a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('handles a leap day', () => {
    // 2028 is a leap year; getting this wrong shifts a whole quarter of data.
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('builds an inclusive range', () => {
    expect(dateRange('2026-01-01', '2026-01-03')).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ]);
  });

  it('returns a single day when from equals to', () => {
    expect(dateRange('2026-01-01', '2026-01-01')).toEqual(['2026-01-01']);
  });
});

describe('densify', () => {
  it('fills missing days with zero', () => {
    // The precondition for prefix sums. Source queries return nothing for quiet
    // days, and treating those as absent would shift every later index.
    const sparse = [
      { day: '2026-01-01', value: 5 },
      { day: '2026-01-04', value: 3 },
    ];
    const dense = densify(sparse, '2026-01-01', '2026-01-05');

    expect(dense).toHaveLength(5);
    expect(dense.map((d) => d.value)).toEqual([5, 0, 0, 3, 0]);
  });

  it('produces a contiguous series', () => {
    const dense = densify([], '2026-03-01', '2026-03-10');
    expect(dense).toHaveLength(10);
    for (let i = 1; i < dense.length; i += 1) {
      expect(dense[i]!.day).toBe(addDays(dense[i - 1]!.day, 1));
    }
  });
});

describe('TimeSeries prefix sums', () => {
  const points = series([10, 20, 30, 40, 50]); // Jan 1-5

  it('totals the whole series', () => {
    expect(new TimeSeries(points).total).toBe(150);
  });

  it('sums an inclusive range', () => {
    // Jan 2 to Jan 4 = 20 + 30 + 40
    expect(new TimeSeries(points).sum('2026-01-02', '2026-01-04')).toBe(90);
  });

  it('sums a single day', () => {
    expect(new TimeSeries(points).sum('2026-01-03', '2026-01-03')).toBe(30);
  });

  it('matches a naive scan for every possible range', () => {
    // Property-style: prefix sums that disagree with the obvious loop are
    // broken, and an off-by-one here is exactly the bug that hides.
    const ts = new TimeSeries(points);
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i; j < points.length; j += 1) {
        const naive = points.slice(i, j + 1).reduce((sum, p) => sum + p.value, 0);
        expect(ts.sum(points[i]!.day, points[j]!.day), `${i}..${j}`).toBe(naive);
      }
    }
  });

  it('clamps a window that starts before the series', () => {
    // A dashboard asking for 30 days on a five-day-old organization should show
    // five days, not an error.
    expect(new TimeSeries(points).sum('2025-01-01', '2026-01-02')).toBe(30);
  });

  it('clamps a window that ends after the series', () => {
    expect(new TimeSeries(points).sum('2026-01-04', '2027-01-01')).toBe(90);
  });

  it('returns zero for a range entirely outside the series', () => {
    expect(new TimeSeries(points).sum('2027-01-01', '2027-01-05')).toBe(0);
  });

  it('handles an empty series', () => {
    const empty = new TimeSeries([]);
    expect(empty.total).toBe(0);
    expect(empty.sum('2026-01-01', '2026-12-31')).toBe(0);
    expect(empty.trailing(7)).toBe(0);
  });

  it('sums the trailing window', () => {
    // Last 3 days of Jan 1-5 = 30 + 40 + 50
    expect(new TimeSeries(points).trailing(3)).toBe(120);
  });

  it('averages per day including zero days', () => {
    const withGaps = new TimeSeries(series([10, 0, 0, 0, 10]));
    expect(withGaps.averagePerDay('2026-01-01', '2026-01-05')).toBe(4);
  });

  it('counts source rows separately from the value', () => {
    const ts = new TimeSeries(series([10, 0, 30]));
    expect(ts.sum('2026-01-01', '2026-01-03')).toBe(40);
    // Two non-zero days contributed.
    expect(ts.count('2026-01-01', '2026-01-03')).toBe(2);
  });

  it('round-trips back to the original points', () => {
    expect(new TimeSeries(points).points().map((p) => p.value)).toEqual([10, 20, 30, 40, 50]);
  });
});

describe('TimeSeries.compareTrailing', () => {
  it('compares against the preceding window', () => {
    // Ten days: first five total 100, second five total 200.
    const ts = new TimeSeries(series([10, 20, 30, 20, 20, 40, 40, 40, 40, 40]));
    const result = ts.compareTrailing(5);

    expect(result.current).toBe(200);
    expect(result.previous).toBe(100);
    expect(result.changePercent).toBe(100);
  });

  it('reports a decline as negative', () => {
    const ts = new TimeSeries(series([100, 100, 50, 50]));
    const result = ts.compareTrailing(2);
    expect(result.changePercent).toBe(-50);
  });

  it('returns null rather than inventing a percentage from zero', () => {
    // Growth from nothing has no meaningful percentage; Infinity or 100% would
    // both be fabrications.
    const ts = new TimeSeries(series([0, 0, 50, 50]));
    const result = ts.compareTrailing(2);
    expect(result.previous).toBe(0);
    expect(result.changePercent).toBeNull();
  });

  it('handles a series shorter than the window', () => {
    const ts = new TimeSeries(series([10, 20]));
    expect(() => ts.compareTrailing(30)).not.toThrow();
  });
});

describe('rollingAverage', () => {
  it('averages over the window once it is full', () => {
    const result = rollingAverage(series([10, 20, 30, 40]), 2);
    // [10], [10,20], [20,30], [30,40]
    expect(result.map((p) => p.value)).toEqual([10, 15, 25, 35]);
  });

  it('uses a partial window at the start rather than emitting nothing', () => {
    const result = rollingAverage(series([10, 20, 30]), 7);
    expect(result).toHaveLength(3);
    expect(result[0]!.value).toBe(10);
  });

  it('matches a naive recomputation', () => {
    const points = series([5, 3, 8, 1, 9, 2, 7, 4]);
    const window = 3;
    const fast = rollingAverage(points, window);

    for (let i = 0; i < points.length; i += 1) {
      const slice = points.slice(Math.max(0, i - window + 1), i + 1);
      const naive = slice.reduce((sum, p) => sum + p.value, 0) / slice.length;
      expect(fast[i]!.value, `index ${i}`).toBeCloseTo(naive, 10);
    }
  });

  it('rejects a non-positive window', () => {
    expect(() => rollingAverage(series([1]), 0)).toThrow(/positive/);
  });

  it('handles an empty series', () => {
    expect(rollingAverage([], 7)).toEqual([]);
  });
});
