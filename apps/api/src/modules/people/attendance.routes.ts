import { BusinessRuleError, ERROR_CODES, NotFoundError } from '@businessos/contracts';
import { formatDuration, overlapsAny, summariseWork, type Interval } from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { record } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Attendance — report Section 3.1 and the origin transcript's "don't make it
 * just click Present".
 *
 * A day is a set of intervals: work sessions with breaks punched inside them.
 * Every number below comes from `summariseWork`, which merges before
 * subtracting — so a duplicate clock-in, the most common punch error, inflates
 * nothing while still being reported as an overlap to correct.
 */

/** Expected working day. A per-organization shift policy belongs here later. */
const EXPECTED_DAY_MS = 8 * 60 * 60 * 1000;

const checkInSchema = z.object({
  notes: z.string().trim().max(500).optional(),
  source: z.enum(['WEB', 'MOBILE', 'BIOMETRIC', 'MANUAL']).default('WEB'),
});

const dayQuerySchema = z.object({
  /** YYYY-MM-DD. Defaults to today. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  employeeId: z.string().uuid().optional(),
});

/** UTC midnight for a date string, so `@db.Date` round-trips unshifted. */
function toWorkDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function requireOwnEmployee(organizationId: string, userId: string) {
  const employee = await prisma.employee.findFirst({
    where: { organizationId, userId },
    select: { id: true },
  });
  if (!employee) {
    throw new BusinessRuleError(
      'Your account is not linked to an employee record, so attendance cannot be recorded.',
    );
  }
  return employee;
}

export function attendanceRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /**
   * POST /v1/attendance/check-in
   *
   * Refuses while a session is already open. Without that guard a double tap
   * creates two overlapping sessions, which merging would hide in the totals
   * while quietly corrupting the record.
   */
  app.post(
    '/v1/attendance/check-in',
    { preHandler: app.requirePermission('attendance.record') },
    async (request, reply) => {
      const input = checkInSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const me = await requireOwnEmployee(organizationId, request.auth!.userId);

      const open = await prisma.attendanceSession.findFirst({
        where: { organizationId, employeeId: me.id, checkOutAt: null },
        select: { id: true, checkInAt: true },
      });
      if (open) {
        throw new BusinessRuleError(
          `You are already checked in since ${open.checkInAt.toISOString().slice(11, 16)} UTC.`,
          ERROR_CODES.BUSINESS_RULE_VIOLATION,
          { openSessionId: open.id },
        );
      }

      const now = new Date();
      const workDate = toWorkDate(today());

      // A new session must not overlap one already recorded for the same day —
      // the interval check that a UNIQUE constraint cannot express.
      const existing = await prisma.attendanceSession.findMany({
        where: { organizationId, employeeId: me.id, workDate, checkOutAt: { not: null } },
        select: { checkInAt: true, checkOutAt: true },
      });
      const asIntervals: Interval[] = existing.map((s) => ({
        start: s.checkInAt.getTime(),
        end: s.checkOutAt!.getTime(),
      }));
      if (overlapsAny({ start: now.getTime(), end: now.getTime() + 1 }, asIntervals)) {
        throw new BusinessRuleError('That time is already covered by a recorded session.');
      }

      const session = await prisma.attendanceSession.create({
        data: {
          organizationId,
          employeeId: me.id,
          workDate,
          checkInAt: now,
          source: input.source,
          ...(input.notes ? { notes: input.notes } : {}),
        },
        select: { id: true, checkInAt: true, workDate: true },
      });

      return reply.status(201).send({
        sessionId: session.id,
        checkInAt: session.checkInAt.toISOString(),
        workDate: session.workDate.toISOString().slice(0, 10),
      });
    },
  );

  /** POST /v1/attendance/check-out */
  app.post(
    '/v1/attendance/check-out',
    { preHandler: app.requirePermission('attendance.record') },
    async (request) => {
      const { organizationId } = request.membership!;
      const me = await requireOwnEmployee(organizationId, request.auth!.userId);

      const open = await prisma.attendanceSession.findFirst({
        where: { organizationId, employeeId: me.id, checkOutAt: null },
        select: {
          id: true,
          checkInAt: true,
          workDate: true,
          breaks: { select: { id: true, endAt: true } },
        },
      });
      if (!open) throw new BusinessRuleError('You are not currently checked in.');

      const now = new Date();

      return prisma.$transaction(async (tx) => {
        // Close any running break first. Clocking out mid-break otherwise
        // leaves an open interval that every later calculation has to guess at.
        const runningBreak = open.breaks.find((b) => b.endAt === null);
        if (runningBreak) {
          await tx.attendanceBreak.update({
            where: { id: runningBreak.id },
            data: { endAt: now },
          });
        }

        await tx.attendanceSession.update({
          where: { id: open.id },
          data: { checkOutAt: now, version: { increment: 1 } },
        });

        const summary = await summariseDay(tx, organizationId, me.id, open.workDate);

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'attendance.checked_out',
          entityType: 'attendance_session',
          entityId: open.id,
          metadata: {
            netHours: formatDuration(summary.netMs),
            breaks: formatDuration(summary.breakMs),
          },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return {
          sessionId: open.id,
          checkOutAt: now.toISOString(),
          closedRunningBreak: Boolean(runningBreak),
          summary: present(summary),
        };
      });
    },
  );

  /** POST /v1/attendance/break/start */
  app.post(
    '/v1/attendance/break/start',
    { preHandler: app.requirePermission('attendance.record') },
    async (request, reply) => {
      const { organizationId } = request.membership!;
      const me = await requireOwnEmployee(organizationId, request.auth!.userId);
      const { reason } = z
        .object({ reason: z.string().trim().max(120).optional() })
        .parse(request.body ?? {});

      const open = await prisma.attendanceSession.findFirst({
        where: { organizationId, employeeId: me.id, checkOutAt: null },
        select: { id: true, breaks: { where: { endAt: null }, select: { id: true } } },
      });
      if (!open) throw new BusinessRuleError('Check in before starting a break.');
      if (open.breaks.length > 0) throw new BusinessRuleError('A break is already running.');

      const created = await prisma.attendanceBreak.create({
        data: { sessionId: open.id, startAt: new Date(), ...(reason ? { reason } : {}) },
        select: { id: true, startAt: true },
      });

      return reply.status(201).send({
        breakId: created.id,
        startAt: created.startAt.toISOString(),
      });
    },
  );

  /** POST /v1/attendance/break/end */
  app.post(
    '/v1/attendance/break/end',
    { preHandler: app.requirePermission('attendance.record') },
    async (request) => {
      const { organizationId } = request.membership!;
      const me = await requireOwnEmployee(organizationId, request.auth!.userId);

      const open = await prisma.attendanceSession.findFirst({
        where: { organizationId, employeeId: me.id, checkOutAt: null },
        select: {
          id: true,
          breaks: { where: { endAt: null }, select: { id: true, startAt: true } },
        },
      });
      const running = open?.breaks[0];
      if (!running) throw new BusinessRuleError('No break is running.');

      const now = new Date();
      await prisma.attendanceBreak.update({ where: { id: running.id }, data: { endAt: now } });

      return {
        breakId: running.id,
        endAt: now.toISOString(),
        durationMs: now.getTime() - running.startAt.getTime(),
      };
    },
  );

  /**
   * GET /v1/attendance/today
   *
   * The live state for the person signed in — what the clock widget renders.
   */
  app.get(
    '/v1/attendance/today',
    { preHandler: app.requirePermission('attendance.read_self') },
    async (request) => {
      const { organizationId } = request.membership!;
      const me = await prisma.employee.findFirst({
        where: { organizationId, userId: request.auth!.userId },
        select: { id: true },
      });
      if (!me) return { linked: false, sessions: [], summary: null };

      const workDate = toWorkDate(today());
      const sessions = await loadDay(prisma, organizationId, me.id, workDate);
      const summary = await summariseDay(prisma, organizationId, me.id, workDate);

      const openSession = sessions.find((s) => s.checkOutAt === null) ?? null;
      const runningBreak = openSession?.breaks.find((b) => b.endAt === null) ?? null;

      return {
        linked: true,
        workDate: today(),
        state: openSession ? (runningBreak ? 'ON_BREAK' : 'WORKING') : 'OUT',
        openSince: openSession?.checkInAt.toISOString() ?? null,
        breakSince: runningBreak?.startAt.toISOString() ?? null,
        sessions: sessions.map(presentSession),
        summary: present(summary),
      };
    },
  );

  /**
   * GET /v1/attendance/day
   *
   * A day for anyone. `attendance.read` is required to look at someone else;
   * without it the query is forced back to the caller.
   */
  app.get(
    '/v1/attendance/day',
    { preHandler: app.requirePermission('attendance.read_self') },
    async (request) => {
      const query = dayQuerySchema.parse(request.query);
      const { organizationId, permissions } = request.membership!;

      const me = await prisma.employee.findFirst({
        where: { organizationId, userId: request.auth!.userId },
        select: { id: true },
      });

      const targetId =
        query.employeeId && permissions.has('attendance.read') ? query.employeeId : me?.id;
      if (!targetId) throw new NotFoundError('Employee');

      const workDate = toWorkDate(query.date ?? today());
      const sessions = await loadDay(prisma, organizationId, targetId, workDate);
      const summary = await summariseDay(prisma, organizationId, targetId, workDate);

      return {
        employeeId: targetId,
        workDate: query.date ?? today(),
        sessions: sessions.map(presentSession),
        summary: present(summary),
      };
    },
  );

  /**
   * POST /v1/attendance/sessions/:sessionId/correct
   *
   * Section 8.4: "A completed attendance session cannot be silently modified;
   * corrections create an auditable adjustment." The correction is stamped on
   * the row AND written to the audit log with the before/after times.
   */
  app.post(
    '/v1/attendance/sessions/:sessionId/correct',
    { preHandler: app.requirePermission('attendance.correct') },
    async (request) => {
      const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const input = z
        .object({
          checkInAt: z.string().datetime(),
          checkOutAt: z.string().datetime(),
          reason: z.string().trim().min(3, 'Say why').max(500),
        })
        .parse(request.body);

      const { organizationId } = request.membership!;

      const session = await prisma.attendanceSession.findFirst({
        where: { id: sessionId, organizationId },
        select: {
          id: true,
          employeeId: true,
          workDate: true,
          checkInAt: true,
          checkOutAt: true,
          version: true,
        },
      });
      if (!session) throw new NotFoundError('Attendance session');

      const start = new Date(input.checkInAt);
      const end = new Date(input.checkOutAt);
      if (end <= start) throw new BusinessRuleError('Check-out must be after check-in.');

      // The corrected interval must not collide with the employee's other
      // recorded sessions that day.
      const others = await prisma.attendanceSession.findMany({
        where: {
          organizationId,
          employeeId: session.employeeId,
          workDate: session.workDate,
          id: { not: sessionId },
          checkOutAt: { not: null },
        },
        select: { checkInAt: true, checkOutAt: true },
      });
      const otherIntervals: Interval[] = others.map((s) => ({
        start: s.checkInAt.getTime(),
        end: s.checkOutAt!.getTime(),
      }));
      if (overlapsAny({ start: start.getTime(), end: end.getTime() }, otherIntervals)) {
        throw new BusinessRuleError('That would overlap another session on the same day.');
      }

      return prisma.$transaction(async (tx) => {
        await tx.attendanceSession.update({
          where: { id: sessionId },
          data: {
            checkInAt: start,
            checkOutAt: end,
            correctedAt: new Date(),
            correctedById: request.auth!.userId,
            notes: input.reason,
            version: { increment: 1 },
          },
        });

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'attendance.corrected',
          entityType: 'attendance_session',
          entityId: sessionId,
          metadata: {
            reason: input.reason,
            from: {
              checkInAt: session.checkInAt.toISOString(),
              checkOutAt: session.checkOutAt?.toISOString() ?? null,
            },
            to: { checkInAt: start.toISOString(), checkOutAt: end.toISOString() },
          },
          ipAddress: request.ip,
          requestId: request.id,
        });

        const summary = await summariseDay(
          tx,
          organizationId,
          session.employeeId,
          session.workDate,
        );
        return { sessionId, corrected: true, summary: present(summary) };
      });
    },
  );

  done();
}

type Client = Parameters<typeof record>[0];

async function loadDay(client: Client, organizationId: string, employeeId: string, workDate: Date) {
  return client.attendanceSession.findMany({
    where: { organizationId, employeeId, workDate },
    select: {
      id: true,
      checkInAt: true,
      checkOutAt: true,
      source: true,
      notes: true,
      correctedAt: true,
      breaks: {
        select: { id: true, startAt: true, endAt: true, reason: true },
        orderBy: { startAt: 'asc' },
      },
    },
    orderBy: { checkInAt: 'asc' },
  });
}

/**
 * Reduce a day to hours worked.
 *
 * An open session is measured up to now, so the live counter ticks. A running
 * break is treated the same way.
 */
async function summariseDay(
  client: Client,
  organizationId: string,
  employeeId: string,
  workDate: Date,
) {
  const sessions = await loadDay(client, organizationId, employeeId, workDate);
  const now = Date.now();

  const work: Interval[] = sessions.map((s) => ({
    start: s.checkInAt.getTime(),
    end: s.checkOutAt?.getTime() ?? now,
  }));

  const breaks: Interval[] = sessions.flatMap((s) =>
    s.breaks.map((b) => ({ start: b.startAt.getTime(), end: b.endAt?.getTime() ?? now })),
  );

  return summariseWork(work, breaks, EXPECTED_DAY_MS);
}

function present(summary: ReturnType<typeof summariseWork>) {
  return {
    gross: formatDuration(summary.grossMs),
    net: formatDuration(summary.netMs),
    breaks: formatDuration(summary.breakMs),
    overtime: formatDuration(summary.overtimeMs),
    shortfall: formatDuration(summary.shortfallMs),
    netMs: summary.netMs,
    // Surfaced rather than silently merged away, so bad punches can be fixed.
    overlapCount: summary.overlaps.length,
  };
}

function presentSession(session: Awaited<ReturnType<typeof loadDay>>[number]) {
  return {
    id: session.id,
    checkInAt: session.checkInAt.toISOString(),
    checkOutAt: session.checkOutAt?.toISOString() ?? null,
    source: session.source,
    notes: session.notes,
    corrected: session.correctedAt !== null,
    breaks: session.breaks.map((b) => ({
      id: b.id,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt?.toISOString() ?? null,
      reason: b.reason,
    })),
  };
}
