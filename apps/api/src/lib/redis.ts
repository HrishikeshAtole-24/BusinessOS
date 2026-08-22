import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Redis connection (Section 15).
 *
 * Cache, rate-limit counters, ephemeral state and queue transport. Never a
 * source of truth — anything here must be reconstructible from PostgreSQL.
 */
export const redis = new Redis(env.REDIS_URL, {
  // Fail a command rather than queue it forever when Redis is down. Section 29
  // wants graceful degradation: a cache miss should fall through to the
  // database, not hang the request.
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  connectTimeout: 10_000,
  // Exponential-ish backoff with a ceiling, so a long outage does not turn into
  // a reconnect storm when the service returns.
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  lazyConnect: true,
});

redis.on('error', (error: Error) => {
  // Logged at warn, not error: Redis being briefly unavailable is survivable by
  // design. Sustained failure is caught by the readiness probe instead.
  logger.warn({ err: error }, 'redis connection error');
});

redis.on('ready', () => logger.info('redis ready'));

export async function pingRedis(): Promise<void> {
  await redis.ping();
}
