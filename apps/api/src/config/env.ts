import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// The monorepo keeps a single .env at the repository root, but this process is
// started from apps/api, so the default cwd-relative lookup misses it. Resolve
// explicitly rather than depending on where the command was run from.
// `override: false` means a real environment variable always wins over the
// file, which is what makes the same build work in CI and production.
loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env'),
  override: false,
  quiet: true,
});

/**
 * Environment validation.
 *
 * Section 27.2: "Schema validation at runtime because TypeScript types
 * disappear at runtime." `process.env` is the clearest case — it is
 * `Record<string, string | undefined>` and every value arrives as a string.
 *
 * This module is imported for its side effect: an invalid environment throws
 * during module initialisation, so the process dies at startup with a readable
 * list of problems rather than at 3am with `undefined is not a function`.
 */

const nonEmpty = z.string().trim().min(1);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- Datastores ---------------------------------------------------------
  DATABASE_URL: nonEmpty.startsWith('postgres', 'Must be a PostgreSQL connection string'),
  DIRECT_URL: nonEmpty.startsWith('postgres', 'Must be a PostgreSQL connection string'),
  REDIS_URL: nonEmpty.refine(
    (v) => v.startsWith('redis://') || v.startsWith('rediss://'),
    'Must start with redis:// or rediss://',
  ),

  // --- HTTP ---------------------------------------------------------------
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  /** Comma-separated. Parsed into an array below. */
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  // --- Sessions -----------------------------------------------------------
  // 32 bytes minimum. Short secrets are the reason session forgery is ever
  // practical, so this is enforced rather than documented.
  SESSION_SECRET: nonEmpty.min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(168),
  SESSION_COOKIE_NAME: z.string().default('businessos.sid'),

  // --- Observability ------------------------------------------------------
  // 'silent' exists so the test reporter is readable; structured logs are the
  // point in production and pure noise in a test run.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  OTEL_SERVICE_NAME: z.string().default('businessos-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Thrown, not logged: the logger itself depends on this config.
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the missing values.',
    );
  }

  const raw = parsed.data;

  return {
    ...raw,
    corsOrigins: raw.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    sessionTtlMs: raw.SESSION_TTL_HOURS * 60 * 60 * 1000,
    isProduction: raw.NODE_ENV === 'production',
    isTest: raw.NODE_ENV === 'test',
  } as const;
}

export const env = loadEnv();
export type Env = typeof env;
