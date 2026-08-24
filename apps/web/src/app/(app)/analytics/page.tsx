import { apiFetch, apiFetchOrNull } from '../../../lib/api';
import { requireSession } from '../../../lib/session';
import { Sparkline } from '../../../components/Sparkline';
import { RebuildButton } from '../../../components/RebuildButton';

export const metadata = { title: 'Analytics — BusinessOS' };

interface MetricSummary {
  total: number;
  last7: number;
  last7Change: number | null;
  last30: number;
  last30Change: number | null;
  averagePerDay: number;
}

interface OverviewResponse {
  range: { from: string; to: string };
  metrics: Record<string, MetricSummary>;
  current: { headcount: number; openTasks: number; pendingApprovals: number };
}

interface SeriesResponse {
  metric: string;
  total: number;
  points: Array<{ day: string; value: number }>;
  smoothed: Array<{ day: string; value: number }> | null;
}

const METRIC_LABELS: Record<string, { label: string; unit: 'money' | 'count' | 'days' }> = {
  'expenses.submitted.amount': { label: 'Expenses submitted', unit: 'money' },
  'expenses.approved.amount': { label: 'Expenses approved', unit: 'money' },
  'tasks.completed': { label: 'Tasks completed', unit: 'count' },
  'leave.days.approved': { label: 'Leave days approved', unit: 'days' },
  'attendance.sessions': { label: 'Attendance sessions', unit: 'count' },
};

/**
 * Analytics.
 *
 * Reads the `metrics_daily` read model, never the source tables (Section 17.1).
 * Every tile below — total, last 7, last 30, change against the previous
 * window — is an O(1) range query against prefix sums built once per metric,
 * rather than a separate scan per tile.
 */
export default async function AnalyticsPage() {
  const session = await requireSession();

  /**
   * Tolerates a 403 rather than throwing.
   *
   * The sidebar dims this link for roles without `analytics.read`, but that is
   * presentation — a typed URL still reaches the page. Without this the API's
   * 403 became an unhandled throw and rendered a 500, which reads as "the app
   * is broken" when the correct answer is "you may not see this".
   */
  const overview = await apiFetchOrNull<OverviewResponse>('/v1/analytics/overview');

  if (!overview) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1 className="page-title">Analytics</h1>
            <p className="page-subtitle">{session.organization!.name}</p>
          </div>
        </div>
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <div className="empty-title">Not available to your role</div>
              <p>
                Company analytics needs <code>analytics.read</code>. Your role
                {session.roles.length > 0 ? ` (${session.roles.join(', ')})` : ''} does not hold it
                — which is the permission system working, not a fault.
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  // One series per metric for the sparklines. Parallel, because they are
  // independent reads and serialising them would just add latency.
  const series = await Promise.all(
    Object.keys(METRIC_LABELS).map((metric) =>
      apiFetch<SeriesResponse>(
        `/v1/analytics/series?metric=${encodeURIComponent(metric)}&smooth=7`,
      ),
    ),
  );
  const seriesByMetric = new Map(series.map((s) => [s.metric, s]));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-subtitle">
            {session.organization!.name} · {overview.range.from} to {overview.range.to}
          </p>
        </div>
        <RebuildButton />
      </div>

      <div className="stat-grid">
        <Stat
          label="Headcount"
          value={String(overview.current.headcount)}
          meta="active employees"
        />
        <Stat label="Open tasks" value={String(overview.current.openTasks)} meta="not yet done" />
        <Stat
          label="Pending approvals"
          value={String(overview.current.pendingApprovals)}
          meta="awaiting a decision"
        />
      </div>

      <div className="split">
        {Object.entries(METRIC_LABELS).map(([metric, meta]) => {
          const summary = overview.metrics[metric];
          const chart = seriesByMetric.get(metric);
          if (!summary) return null;

          return (
            <section className="card" key={metric}>
              <div className="card-header">
                <h2 className="card-title">{meta.label}</h2>
                <Change percent={summary.last30Change} />
              </div>
              <div className="card-body stack">
                <div className="row-between" style={{ alignItems: 'flex-end' }}>
                  <div>
                    <div className="stat-value nums">{format(summary.last30, meta.unit)}</div>
                    <div className="stat-meta">last 30 days</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="nums" style={{ fontWeight: 'var(--weight-medium)' }}>
                      {format(summary.last7, meta.unit)}
                    </div>
                    <div className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                      last 7 days
                    </div>
                  </div>
                </div>

                {chart ? (
                  <Sparkline
                    points={chart.points}
                    overlay={chart.smoothed}
                    label={meta.label}
                    height={44}
                  />
                ) : null}

                <div className="row-between subtle" style={{ fontSize: 'var(--text-sm)' }}>
                  <span>Total {format(summary.total, meta.unit)}</span>
                  <span>{format(summary.averagePerDay, meta.unit)} / day</span>
                </div>
              </div>
            </section>
          );
        })}
      </div>

      <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
        Figures come from a pre-aggregated daily read model, not from the source tables. Each window
        is answered by subtracting two prefix sums, so adding a tile costs arithmetic rather than
        another scan. The faint line is a 7-day rolling average.
      </p>
    </div>
  );
}

function Stat({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value nums">{value}</div>
      <div className="stat-meta">{meta}</div>
    </div>
  );
}

/** Change against the previous window. Null means the previous window was zero. */
function Change({ percent }: { percent: number | null }) {
  if (percent === null) {
    return <span className="badge">no prior data</span>;
  }
  const rounded = Math.round(percent);
  if (rounded === 0) return <span className="badge">flat</span>;

  return (
    <span className={rounded > 0 ? 'badge badge-success' : 'badge badge-warning'}>
      {/* Sign carried by the text, not only by colour (Section 24.3). */}
      {rounded > 0 ? '▲' : '▼'} {Math.abs(rounded)}%
    </span>
  );
}

function format(value: number, unit: 'money' | 'count' | 'days'): string {
  if (unit === 'money') {
    return `₹${Math.round(value).toLocaleString('en-IN')}`;
  }
  if (unit === 'days') {
    return `${value.toFixed(1)}d`;
  }
  return Math.round(value).toLocaleString('en-IN');
}
