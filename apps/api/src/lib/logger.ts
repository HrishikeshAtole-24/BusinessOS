import { pino, type LoggerOptions } from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logging — report Section 19.1.
 *
 * The report specifies JSON logs carrying `requestId`, `organizationId`,
 * `userId`, `module` and `duration`. Those are attached per-request by the
 * request-context plugin rather than passed by hand at each call site; a field
 * that has to be remembered is a field that will be missing from the one log
 * line you needed.
 *
 * OpenTelemetry JS has traces and metrics stable but logs still in development
 * (Section 19.1), so logs go through pino while trace context is correlated by
 * `requestId`.
 */

/**
 * Redaction (Section 18.4: "redact secrets and personal data from logs").
 *
 * Paths are matched structurally, so this only catches fields at these exact
 * positions — it is a safety net, not permission to log a whole request body.
 * Anything genuinely sensitive should never reach the logger to begin with.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.tokenHash',
  '*.sessionToken',
  '*.secret',
  '*.accessToken',
  '*.refreshToken',
  '*.creditCard',
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },

  // ISO timestamps. Slightly more expensive than epoch millis, but log lines
  // are read by humans far more often than they are parsed by machines.
  timestamp: pino.stdTimeFunctions.isoTime,

  base: {
    service: env.OTEL_SERVICE_NAME,
    env: env.NODE_ENV,
  },

  formatters: {
    // Emit `"level":"info"` rather than `"level":30` so log search is readable
    // without a lookup table.
    level: (label) => ({ level: label }),
  },

  // Pretty output while developing; raw JSON everywhere else, because log
  // shippers parse JSON and cannot parse ANSI colour codes.
  ...(env.isProduction || env.isTest
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service,env',
            messageFormat: '{if requestId}[{requestId}] {end}{msg}',
          },
        },
      }),
};

export const logger = pino(options);

export type Logger = typeof logger;
