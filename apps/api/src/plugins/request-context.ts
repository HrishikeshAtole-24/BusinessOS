import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Request correlation and access logging (report Section 19.1).
 *
 * Every log line, error response and audit record produced while handling a
 * request carries the same `requestId`. That identifier is what turns "a user
 * reports a 500" into a single grep, and it is what will later join an
 * OpenTelemetry trace to the log lines emitted inside it (Section 19.1: OTel JS
 * has traces and metrics stable, logs not yet).
 *
 * The tenant fields — `organizationId`, `userId` — are filled in by the auth
 * plugin once the session is resolved, so log lines after that point carry
 * tenant context automatically rather than by hand.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth plugin once a session is resolved. */
    organizationId?: string;
    userId?: string;
  }
}

/**
 * Accept an inbound `x-request-id` so a trace survives across the web app and
 * the API, but only when it looks like an ID we issued. Echoing arbitrary
 * client input into every log line is a log-injection vector.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

function resolveRequestId(request: { headers: Record<string, unknown> }): string {
  const inbound = request.headers['x-request-id'];
  if (typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound)) return inbound;
  return `req_${randomUUID()}`;
}

/** Paths that should not produce an access log line on every call. */
const QUIET_PATHS = new Set(['/health/live', '/health/ready']);

export const requestContextPlugin = fp(
  function requestContext(app: FastifyInstance, _opts: unknown, done: () => void) {
    app.addHook('onRequest', (request, reply, next) => {
      reply.header('x-request-id', request.id);
      next();
    });

    app.addHook('onResponse', (request: FastifyRequest, reply, next) => {
      if (QUIET_PATHS.has(request.url.split('?')[0] ?? '')) return next();

      request.log.info(
        {
          method: request.method,
          path: request.url,
          statusCode: reply.statusCode,
          // Section 19.2 golden signals: latency per endpoint.
          durationMs: Math.round(reply.elapsedTime),
          organizationId: request.organizationId,
          userId: request.userId,
        },
        'request completed',
      );
      next();
    });

    done();
  },
  { name: 'request-context' },
);

export { resolveRequestId };
