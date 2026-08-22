import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';

/**
 * Process entry point.
 *
 * Owns exactly three things the application factory should not: binding a port,
 * responding to signals, and shutting down cleanly (Section 27.3).
 */

/**
 * Graceful shutdown.
 *
 * On SIGTERM the orchestrator has already stopped routing new traffic to this
 * instance. Killing it immediately would abort in-flight requests — including,
 * potentially, a half-finished transaction. So: stop accepting connections,
 * let running handlers finish, then close the datastore connections.
 *
 * The timeout is the safety net. If a handler is wedged, we exit anyway rather
 * than hang until the orchestrator sends SIGKILL, because SIGKILL skips the
 * connection cleanup entirely and leaves server-side connections to time out.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const app = await buildApp();

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutdown started');

    const timer = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      await app.close();
      logger.info('http server closed');

      await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
      logger.info('datastore connections closed');

      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  // An unhandled rejection leaves the process in an unknown state. Log it and
  // go down; a supervisor restarting a clean process is safer than serving
  // traffic from one whose invariants may no longer hold.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });

  // Connect Redis eagerly (the client is created with `lazyConnect`) so a bad
  // URL fails at boot rather than on the first cache read. Non-fatal: the API
  // degrades without Redis but still serves.
  redis.connect().catch((error: unknown) => {
    logger.warn({ err: error }, 'redis unavailable at startup; continuing degraded');
  });

  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  logger.info(
    { port: env.API_PORT, host: env.API_HOST, env: env.NODE_ENV, node: process.version },
    'businessos api listening',
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start api');
  process.exit(1);
});
