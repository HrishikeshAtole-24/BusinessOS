import { createPrismaClient, type PrismaClient } from '@businessos/database';
import { env } from '../config/env.js';

/**
 * The API's Prisma client.
 *
 * A single instance per process. Each client owns a `pg` connection pool, so
 * constructing one per request would exhaust Neon's connection budget almost
 * immediately (Section 27.3: connection pooling).
 */
export const prisma: PrismaClient = createPrismaClient({
  databaseUrl: env.DATABASE_URL,
  logQueries: !env.isProduction && env.LOG_LEVEL === 'trace',
});

/** Cheap liveness probe for the readiness check (Section 19.3). */
export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
