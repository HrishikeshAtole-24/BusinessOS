import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController } from 'fastify';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { requestContextPlugin, resolveRequestId } from './plugins/request-context.js';
import { authRoutes } from './modules/identity/auth.routes.js';
import { invitationRoutes } from './modules/organization/invitation.routes.js';
import { organizationRoutes } from './modules/organization/organization.routes.js';
import { departmentRoutes } from './modules/people/department.routes.js';
import { employeeRoutes } from './modules/people/employee.routes.js';
import { projectRoutes } from './modules/work/project.routes.js';
import { taskRoutes } from './modules/work/task.routes.js';
import { approvalRoutes } from './modules/workflow/approval.routes.js';
import { expenseRoutes } from './modules/finance/expense.routes.js';
import { leaveRoutes } from './modules/people/leave.routes.js';
import { attendanceRoutes } from './modules/people/attendance.routes.js';
import { notificationRoutes } from './modules/platform/notification.routes.js';
import { analyticsRoutes } from './modules/analytics/analytics.routes.js';
import { healthRoutes } from './routes/health.js';

/**
 * Application factory.
 *
 * Separated from `index.ts` so tests can build an instance, drive it with
 * `app.inject()` and never bind a port (Section 20.1). `index.ts` owns process
 * concerns — listening, signals, shutdown — and nothing else.
 *
 * `rateLimit` is opt-out for tests. The auth limiter allows 10 attempts per
 * 5 minutes per IP+email, and a suite that logs in dozens of times legitimately
 * trips it. Disabling it in tests is not weakening the tests — the limiter has
 * its own dedicated test that builds an app with it enabled.
 *
 * The return type is inferred rather than annotated as `FastifyInstance`.
 * Passing a custom `loggerInstance` specializes Fastify's logger generic, and a
 * bare `FastifyInstance` annotation would widen it back to `FastifyBaseLogger`
 * — which `exactOptionalPropertyTypes` correctly rejects. `App` below is the
 * name to use elsewhere.
 */
export interface BuildAppOptions {
  /** Defaults to true. Tests disable it; see the note above. */
  rateLimit?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const rateLimitEnabled = options.rateLimit ?? true;
  const app = Fastify({
    loggerInstance: logger,
    genReqId: resolveRequestId,
    // Behind a load balancer, the socket address is the balancer's. Without
    // this, rate limiting would bucket the whole internet into one key.
    trustProxy: true,
    // Reject oversized bodies at the parser rather than after allocation.
    bodyLimit: 1_048_576, // 1 MB
    // The request-context plugin owns access logging, so Fastify's built-in
    // request/response lines are turned off to avoid logging each request twice.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // --- Security (Section 18.4) ---------------------------------------------
  await app.register(helmet, {
    // The API serves JSON, never HTML, so the useful CSP is the one that
    // forbids everything. The web app ships its own policy.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cors, {
    origin: env.corsOrigins,
    // Sessions are cookie-based, so the browser must be allowed to send them.
    // This is precisely why `origin` is an explicit allowlist and never `true`:
    // credentials plus a reflected origin is a cross-site request forgery.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['x-request-id'],
    maxAge: 86_400,
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    parseOptions: {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: 'lax',
      path: '/',
    },
  });

  // --- Rate limiting (Section 18.4) ----------------------------------------
  // Backed by Redis so the limit is global rather than per-instance; two API
  // pods with in-memory counters would grant double the intended budget.
  // Per-route limits for auth endpoints are set where those routes are defined.
  //
  // Skipped entirely when disabled. Registering with `global: false` is NOT
  // enough — the plugin still honours per-route `config.rateLimit`, which is
  // exactly what the auth routes declare.
  if (rateLimitEnabled) {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      redis,
      // Fail open. A Redis outage should not take down authentication; the
      // readiness probe and alerts are the signal for that, not a 429 storm.
      skipOnError: true,
      keyGenerator: (request) => request.ip,
    });
  }

  // --- Cross-cutting -------------------------------------------------------
  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  // --- Routes --------------------------------------------------------------
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(organizationRoutes);
  await app.register(invitationRoutes);
  await app.register(departmentRoutes);
  await app.register(employeeRoutes);
  await app.register(projectRoutes);
  await app.register(taskRoutes);
  await app.register(approvalRoutes);
  await app.register(expenseRoutes);
  await app.register(leaveRoutes);
  await app.register(attendanceRoutes);
  await app.register(notificationRoutes);
  await app.register(analyticsRoutes);

  app.get('/', async () => ({
    name: 'BusinessOS API',
    version: '0.1.0',
    docs: '/docs',
  }));

  return app;
}

/** The concrete Fastify instance type this app produces, logger generic included. */
export type App = Awaited<ReturnType<typeof buildApp>>;
