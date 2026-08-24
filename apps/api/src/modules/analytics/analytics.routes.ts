import { TimeSeries, addDays, densify, rollingAverage } from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';

/**
 * Analytics — report Section 17.
 *
 * Section 17.1: "Operational queries and analytical queries have different
 * workloads." A dashboard scanning months of expenses on every page load
 * competes with the transactional path for the same rows and indexes.
 *
 * So metrics are aggregated into `metrics_daily` — one row per organization,
 * day, metric and dimension — and the dashboard reads that. Daily grain is what
 * makes prefix sums usable: any date range becomes O(1) after one O(n) pass,
 * rather than a fresh scan per tile.
 */

const rangeSchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const seriesSchema = rangeSchema.extend({
  metric: z.string().min(1).max(80),
  /** Rolling average window, in days. */
  smooth: z.coerce.number().int().min(2).max(90).optional(),
});

const METRICS = [
  'expenses.submitted.amount',
  'expenses.approved.amount',
  'tasks.completed',
  'leave.days.approved',
  'attendance.sessions',
] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultRange(query: z.infer<typeof rangeSchema>): { from: string; to: string } {
  const to = query.to ?? today();
  return { from: query.from ?? addDays(to, -29), to };
}

export function analyticsRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /**
   * POST /v1/analytics/rebuild
   *
   * Recompute the read model from source tables.
   *
   * Idempotent by construction: every write upserts on
   * (organizationId, day, metric, dimension), so re-running a range overwrites
   * rather than doubling. That is what lets a scheduled job retry safely, and
   * Section 14.3 assumes exactly that.
   *
   * Runs synchronously here because the demo dataset is small. At real volume
   * this belongs on the `reports` queue — it is a long scan whose latency has
   * nothing to do with the request that triggered it.
   */
  app.post(
    '/v1/analytics/rebuild',
    { preHandler: app.requirePermission('analytics.read') },
    async (request) => {
      const query = rangeSchema.parse(request.query);
      const { from, to } = defaultRange(query);
      const { organizationId } = request.membership!;

      const start = new Date(`${from}T00:00:00.000Z`);
      const end = new Date(`${to}T23:59:59.999Z`);

      /**
       * One grouped query per metric rather than one per day.
       *
       * Looping days and querying inside the loop is the N+1 that Section 22.3
       * warns about: thirty days would be thirty round trips to compute what
       * `GROUP BY` answers in one.
       */
      const [expensesSubmitted, expensesApproved, tasksDone, leaveDays, sessions] =
        await Promise.all([
          prisma.$queryRaw<Array<{ day: Date; total: number; n: bigint }>>`
            SELECT DATE(submitted_at) AS day, COALESCE(SUM(amount), 0)::float8 AS total, COUNT(*) AS n
            FROM expenses
            WHERE organization_id = ${organizationId}::uuid
              AND submitted_at BETWEEN ${start} AND ${end}
            GROUP BY DATE(submitted_at)`,
          prisma.$queryRaw<Array<{ day: Date; total: number; n: bigint }>>`
            SELECT DATE(resolved_at) AS day, COALESCE(SUM(amount), 0)::float8 AS total, COUNT(*) AS n
            FROM expenses
            WHERE organization_id = ${organizationId}::uuid
              AND status IN ('APPROVED', 'REIMBURSED')
              AND resolved_at BETWEEN ${start} AND ${end}
            GROUP BY DATE(resolved_at)`,
          prisma.$queryRaw<Array<{ day: Date; total: number; n: bigint }>>`
            SELECT DATE(completed_at) AS day, COUNT(*)::float8 AS total, COUNT(*) AS n
            FROM tasks
            WHERE organization_id = ${organizationId}::uuid
              AND completed_at BETWEEN ${start} AND ${end}
            GROUP BY DATE(completed_at)`,
          prisma.$queryRaw<Array<{ day: Date; total: number; n: bigint }>>`
            SELECT start_date AS day, COALESCE(SUM(days), 0)::float8 AS total, COUNT(*) AS n
            FROM leave_requests
            WHERE organization_id = ${organizationId}::uuid
              AND status = 'APPROVED'
              AND start_date BETWEEN ${start}::date AND ${end}::date
            GROUP BY start_date`,
          prisma.$queryRaw<Array<{ day: Date; total: number; n: bigint }>>`
            SELECT work_date AS day, COUNT(*)::float8 AS total, COUNT(*) AS n
            FROM attendance_sessions
            WHERE organization_id = ${organizationId}::uuid
              AND work_date BETWEEN ${start}::date AND ${end}::date
            GROUP BY work_date`,
        ]);

      const buckets: Array<[string, Array<{ day: Date; total: number; n: bigint }>]> = [
        ['expenses.submitted.amount', expensesSubmitted],
        ['expenses.approved.amount', expensesApproved],
        ['tasks.completed', tasksDone],
        ['leave.days.approved', leaveDays],
        ['attendance.sessions', sessions],
      ];

      let written = 0;
      for (const [metric, rows] of buckets) {
        for (const row of rows) {
          if (!row.day) continue;
          const day = new Date(row.day.toISOString().slice(0, 10) + 'T00:00:00.000Z');
          await prisma.metricDaily.upsert({
            where: {
              organizationId_day_metric_dimension: {
                organizationId,
                day,
                metric,
                dimension: '',
              },
            },
            update: { value: row.total.toFixed(2), count: Number(row.n), computedAt: new Date() },
            create: {
              organizationId,
              day,
              metric,
              dimension: '',
              value: row.total.toFixed(2),
              count: Number(row.n),
            },
          });
          written += 1;
        }
      }

      return { from, to, metrics: METRICS.length, rowsWritten: written };
    },
  );

  /**
   * GET /v1/analytics/overview
   *
   * Every tile answered from ONE read of the daily series per metric, then
   * O(1) range queries against the prefix sums. The alternative — a query per
   * tile per window — is the same data scanned a dozen times.
   */
  app.get(
    '/v1/analytics/overview',
    { preHandler: app.requirePermission('analytics.read') },
    async (request) => {
      const query = rangeSchema.parse(request.query);
      const { from, to } = defaultRange(query);
      const { organizationId } = request.membership!;

      const rows = await prisma.metricDaily.findMany({
        where: {
          organizationId,
          dimension: '',
          day: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
        },
        select: { day: true, metric: true, value: true, count: true },
        orderBy: { day: 'asc' },
      });

      const byMetric = new Map<string, Array<{ day: string; value: number; count: number }>>();
      for (const row of rows) {
        const day = row.day.toISOString().slice(0, 10);
        const bucket = byMetric.get(row.metric) ?? [];
        bucket.push({ day, value: Number(row.value), count: row.count });
        byMetric.set(row.metric, bucket);
      }

      const summary: Record<string, unknown> = {};
      for (const metric of METRICS) {
        // Densify first: prefix-sum indices only map to dates when every day is
        // present, and quiet days are simply absent from the query.
        const series = new TimeSeries(densify(byMetric.get(metric) ?? [], from, to));
        const week = series.compareTrailing(7);
        const month = series.compareTrailing(30);

        summary[metric] = {
          total: series.total,
          last7: week.current,
          last7Change: week.changePercent,
          last30: month.current,
          last30Change: month.changePercent,
          averagePerDay: Number(series.averagePerDay(from, to).toFixed(2)),
        };
      }

      // Live counts that are not time-bucketed.
      const [headcount, openTasks, pendingApprovals] = await Promise.all([
        prisma.employee.count({ where: { organizationId, status: 'ACTIVE' } }),
        prisma.task.count({ where: { organizationId, status: { notIn: ['DONE'] } } }),
        prisma.approvalRequest.count({ where: { organizationId, status: 'PENDING' } }),
      ]);

      return {
        range: { from, to },
        metrics: summary,
        current: { headcount, openTasks, pendingApprovals },
      };
    },
  );

  /** GET /v1/analytics/series — one metric as a chartable series. */
  app.get(
    '/v1/analytics/series',
    { preHandler: app.requirePermission('analytics.read') },
    async (request) => {
      const query = seriesSchema.parse(request.query);
      const { from, to } = defaultRange(query);
      const { organizationId } = request.membership!;

      const rows = await prisma.metricDaily.findMany({
        where: {
          organizationId,
          metric: query.metric,
          dimension: '',
          day: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
        },
        select: { day: true, value: true, count: true },
        orderBy: { day: 'asc' },
      });

      const dense = densify(
        rows.map((r) => ({
          day: r.day.toISOString().slice(0, 10),
          value: Number(r.value),
          count: r.count,
        })),
        from,
        to,
      );

      const series = new TimeSeries(dense);

      return {
        metric: query.metric,
        range: { from, to },
        total: series.total,
        points: dense,
        // Rolling average in one pass, not a re-sum per point.
        smoothed: query.smooth ? rollingAverage(dense, query.smooth) : null,
      };
    },
  );

  /**
   * GET /v1/analytics/outbox — operational health of the event pipeline.
   *
   * Section 15.3 asks for queue depth and job age to be monitored. A growing
   * PENDING count or any FAILED rows means events are not reaching consumers,
   * which is invisible from the business tables.
   */
  app.get(
    '/v1/analytics/outbox',
    { preHandler: app.requirePermission('audit.read') },
    async (request) => {
      const { organizationId } = request.membership!;

      const grouped = await prisma.outboxEvent.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: { _all: true },
      });

      const oldestPending = await prisma.outboxEvent.findFirst({
        where: { organizationId, status: 'PENDING' },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      const failed = await prisma.outboxEvent.findMany({
        where: { organizationId, status: 'FAILED' },
        select: { id: true, type: true, attempts: true, lastError: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      return {
        counts: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
        oldestPendingAgeMs: oldestPending ? Date.now() - oldestPending.createdAt.getTime() : null,
        failed,
      };
    },
  );

  done();
}
