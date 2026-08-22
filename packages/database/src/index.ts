import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export * from './generated/client.js';
export * from './generated/enums.js';

export interface CreatePrismaClientOptions {
  /**
   * The **pooled** connection string. Migrations use the direct endpoint and
   * never go through this client — see ADR-015.
   */
  databaseUrl: string;
  /** Emit every query at debug level. Development only: queries carry data. */
  logQueries?: boolean;
  /** Max connections in the local pool. */
  poolSize?: number;
}

/**
 * Build the Prisma client.
 *
 * Prisma 7 requires a **driver adapter** — the old `datasourceUrl` option is
 * gone, and the Rust query engine along with it. Queries are now compiled to
 * SQL and executed through a normal Node driver (`pg` here). Two consequences
 * worth knowing:
 *
 *   - Connection pooling is the driver's job, not Prisma's, so `poolSize` is a
 *     `pg` setting.
 *   - No engine binary ships with the deployed app, which makes container
 *     images smaller and removes a class of platform-mismatch failure.
 *
 * One place constructs the client so pooling, logging and error mapping stay
 * consistent between the API and the worker.
 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.databaseUrl,
    // Neon's pooler already fronts the database; a large local pool on top of
    // it just holds server-side connections idle. Keep this modest and let the
    // pooler do the multiplexing.
    max: options.poolSize ?? 10,
  });

  return new PrismaClient({
    adapter,
    log: options.logQueries
      ? [
          { emit: 'stdout', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  });
}

/**
 * Prisma error codes worth handling by name rather than by string matching.
 * The full list is large; these are the ones with a defined API response.
 */
export const PRISMA_ERRORS = {
  /** Unique constraint violation -> 409 DUPLICATE_RESOURCE. */
  UNIQUE_CONSTRAINT: 'P2002',
  /** Foreign key constraint violation -> 422. */
  FOREIGN_KEY_CONSTRAINT: 'P2003',
  /** Record required by the operation was not found -> 404. */
  RECORD_NOT_FOUND: 'P2025',
  /** Cannot reach the database server -> 503 DEPENDENCY_UNAVAILABLE. */
  UNREACHABLE: 'P1001',
} as const;

export function isPrismaErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
