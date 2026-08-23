import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { buildApp } from '../../app.js';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';

/**
 * The auth rate limiter, tested with limiting ENABLED.
 *
 * Section 18.4 requires authentication endpoints to be rate limited. The rest
 * of the auth suite disables the limiter so it can log in freely, which would
 * leave this control untested — so it gets its own file.
 */

let app: App;

/**
 * A fresh address per run.
 *
 * The limiter keys on IP + email and its counters live in Redis, so a fixed
 * address would arrive already over budget on the second run. Deleting the keys
 * instead would mean a `KEYS` scan — O(N) over the whole keyspace, and
 * throttled on Upstash. A unique key is simply cheaper than cleaning one up.
 */
const probeEmail = () => `rl-probe-${randomUUID()}@businessos.dev`;

beforeAll(async () => {
  app = await buildApp({ rateLimit: true });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('auth rate limiting', () => {
  it('starts refusing repeated failed logins for the same email', async () => {
    const payload = { email: probeEmail(), password: 'wrong-password-attempt' };

    const statuses: number[] = [];
    // The limit is 10 per 5 minutes; 14 attempts must cross it.
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload,
      });
      statuses.push(response.statusCode);
    }

    // Early attempts get a normal 401; later ones must be refused outright.
    // Without this, an attacker gets unlimited password guesses.
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);

    const limited = statuses.filter((s) => s === 429).length;
    expect(limited).toBeGreaterThan(0);
  });

  it('returns the documented error contract when limited', async () => {
    const payload = { email: probeEmail(), password: 'x'.repeat(20) };
    let body: { error: { code: string; requestId: string } } | null = null;

    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload });
      if (response.statusCode === 429) {
        body = response.json();
        break;
      }
    }

    expect(body, 'never hit the rate limit').not.toBeNull();
    expect(body!.error.code).toBe('RATE_LIMITED');
    expect(body!.error.requestId).toMatch(/^req_/);
  });
});
