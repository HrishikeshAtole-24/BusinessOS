import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the datasource URL out of `schema.prisma` and into this file.
 * That is an improvement: the URL is now ordinary TypeScript, so it can be
 * validated at load time instead of failing later with an opaque driver error.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'Copy .env.example to .env and fill it in.',
    );
  }
  return value;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Runtime queries go through Neon's pooler.
    url: required('DATABASE_URL'),
    // Migrations must bypass it: DDL and advisory locks do not survive a
    // transaction-mode pooler. See .env.example for the full explanation.
    directUrl: required('DIRECT_URL'),
  },
});
