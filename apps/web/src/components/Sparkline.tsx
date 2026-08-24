/**
 * A sparkline, drawn as inline SVG.
 *
 * ADR-016 rules out component libraries, and that includes chart libraries. A
 * charting package for a line and a fill would be ~50KB of JavaScript to
 * compute what is arithmetic over an array — and it would arrive as a Client
 * Component, so a static chart would ship a hydration cost for nothing.
 *
 * This is a Server Component: the SVG is generated once on the server and sent
 * as markup. No client JavaScript at all.
 */

interface Point {
  day: string;
  value: number;
}

interface SparklineProps {
  points: readonly Point[];
  /** Overlay, e.g. a rolling average. */
  overlay?: readonly Point[] | null;
  height?: number;
  label: string;
}

const WIDTH = 100;

export function Sparkline({ points, overlay, height = 40, label }: SparklineProps) {
  if (points.length < 2) {
    return (
      <div className="sparkline-empty subtle" style={{ height }}>
        Not enough data
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values, ...(overlay?.map((p) => p.value) ?? []));
  // Baseline at zero rather than at the minimum. Starting the axis at the min
  // exaggerates small variation into a dramatic slope — the classic misleading
  // chart, and not something to ship in a business dashboard.
  const min = 0;
  const range = max - min || 1;

  const toPath = (series: readonly Point[]): string =>
    series
      .map((point, i) => {
        const x = (i / (series.length - 1)) * WIDTH;
        const y = height - ((point.value - min) / range) * height;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');

  const line = toPath(points);
  const area = `${line} L${WIDTH},${height} L0,${height} Z`;

  const last = points[points.length - 1]!;
  const lastX = WIDTH;
  const lastY = height - ((last.value - min) / range) * height;

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${WIDTH} ${height}`}
      // Non-uniform scaling: the chart should fill its container horizontally
      // while keeping the given height.
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: ${points.length} days, peaking at ${max.toLocaleString('en-IN')}`}
    >
      <path className="sparkline-area" d={area} />
      <path className="sparkline-line" d={line} vectorEffect="non-scaling-stroke" />
      {overlay && overlay.length > 1 ? (
        <path className="sparkline-overlay" d={toPath(overlay)} vectorEffect="non-scaling-stroke" />
      ) : null}
      {/* The most recent point, which is the one people look for. */}
      <circle
        className="sparkline-dot"
        cx={lastX}
        cy={lastY}
        r="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
