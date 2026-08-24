import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../lib/prisma.js';
import { pingRedis } from '../lib/redis.js';

/**
 * Health checks (report Section 19.3).
 *
 * The liveness/readiness split is what makes rolling deploys safe, and the
 * distinction is easy to get wrong:
 *
 *   /health/live   Is the process running? Checks nothing external. A failure
 *                  means "restart me". If this checked the database, a brief
 *                  database blip would cause the orchestrator to kill every
 *                  healthy instance — turning a partial outage into a total one.
 *
 *   /health/ready  Can this instance serve traffic right now? Checks the
 *                  dependencies a request actually needs. A failure means
 *                  "route around me", not "restart me".
 *
 * Redis is deliberately NOT fatal to readiness. Section 29 wants graceful
 * degradation: without Redis the API loses caching and rate limiting but can
 * still serve correct responses from PostgreSQL. PostgreSQL is the source of
 * truth, so losing it does mean unready.
 */

interface DependencyResult {
  status: 'ok' | 'degraded' | 'down';
  latencyMs: number;
}

async function probe(check: () => Promise<unknown>): Promise<DependencyResult> {
  const started = performance.now();
  try {
    await check();
    return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { status: 'down', latencyMs: Math.round(performance.now() - started) };
  }
}

export function healthRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  // Deliberately synchronous: liveness must not depend on anything that can
  // block, which is the whole distinction from readiness.
  app.get('/health/live', () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/health/ready', async (_request, reply) => {
    const [database, cache] = await Promise.all([probe(pingDatabase), probe(pingRedis)]);

    const ready = database.status === 'ok';

    return reply.status(ready ? 200 : 503).send({
      status: ready ? (cache.status === 'ok' ? 'ok' : 'degraded') : 'unavailable',
      checks: { database, cache },
    });
  });

  /**
   * Diagnostic only. Section 19.3 is explicit that this must not expose
   * secrets, so it reports versions and status — never connection strings,
   * hostnames or credentials.
   */
  app.get('/health/dependencies', async () => {
    const [database, cache] = await Promise.all([probe(pingDatabase), probe(pingRedis)]);
    const memory = process.memoryUsage();

    return {
      service: 'businessos-api',
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memory: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      },
      dependencies: { database, cache },
    };
  });

  done();
}
