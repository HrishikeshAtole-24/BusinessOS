import {
  AppError,
  ConflictError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
  isAppError,
  toErrorResponse,
} from '@businessos/contracts';
import { PRISMA_ERRORS, isPrismaErrorWithCode } from '@businessos/database';
import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

/**
 * The single exit point for every error (report Section 12.3).
 *
 * The design is deliberately closed by default. Only an `AppError` — something
 * we anticipated and whose message we wrote — is serialized as-is. Everything
 * else becomes an opaque 500 with the original logged server-side. That way a
 * new failure mode cannot leak a driver message or a stack trace just because
 * nobody thought to handle it.
 */

/** Translate known infrastructure errors into our own vocabulary. */
function normalize(error: unknown): AppError | null {
  if (isAppError(error)) return error;

  // Zod validation failures reaching here mean a schema ran outside a route
  // validator. Surface the field paths — they are about the caller's own
  // request, so there is nothing to disclose.
  if (error instanceof ZodError) {
    return new ValidationError('The request failed validation.', {
      issues: error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }

  if (isPrismaErrorWithCode(error, PRISMA_ERRORS.UNIQUE_CONSTRAINT)) {
    // Note what is NOT included: the constraint name. It would name the columns
    // and turn a duplicate-signup response into an account-enumeration oracle.
    return new ConflictError(
      'A record with these details already exists.',
      ERROR_CODES.DUPLICATE_RESOURCE,
    );
  }

  if (isPrismaErrorWithCode(error, PRISMA_ERRORS.RECORD_NOT_FOUND)) {
    return new NotFoundError();
  }

  if (isPrismaErrorWithCode(error, PRISMA_ERRORS.FOREIGN_KEY_CONSTRAINT)) {
    return new ConflictError(
      'This action references a record that does not exist or is still in use.',
      ERROR_CODES.CONFLICT,
    );
  }

  if (isPrismaErrorWithCode(error, PRISMA_ERRORS.UNREACHABLE)) {
    return new AppError(
      ERROR_CODES.DEPENDENCY_UNAVAILABLE,
      503,
      'A required service is temporarily unavailable.',
    );
  }

  return null;
}

export const errorHandlerPlugin = fp(
  function errorHandler(app: FastifyInstance, _opts: unknown, done: () => void) {
    app.setErrorHandler((error: FastifyError, request, reply) => {
      // Fastify's own schema validation runs before our handlers.
      if (error.validation) {
        const appError = new ValidationError('The request failed validation.', {
          issues: error.validation.map((v) => ({
            path: v.instancePath || v.schemaPath,
            message: v.message ?? 'invalid',
          })),
        });
        request.log.info({ code: appError.code }, 'request validation failed');
        return reply.status(appError.statusCode).send(appError.toResponse(request.id));
      }

      if (error.statusCode === 429) {
        request.log.warn({ path: request.url }, 'rate limit exceeded');
        return reply.status(429).send({
          error: {
            code: ERROR_CODES.RATE_LIMITED,
            message: 'Too many requests. Please slow down.',
            requestId: request.id,
          },
        });
      }

      const normalized = normalize(error);

      if (normalized) {
        // 4xx is the caller's problem and is expected traffic; 5xx is ours.
        // Logging them at the same level makes the error rate meaningless.
        const level = normalized.statusCode >= 500 ? 'error' : 'info';
        request.log[level](
          {
            code: normalized.code,
            statusCode: normalized.statusCode,
            // Cross-tenant attempts are worth alerting on (Section 32).
            ...(normalized.code === ERROR_CODES.TENANT_MISMATCH
              ? { securityEvent: 'tenant_isolation_violation' }
              : {}),
            err: normalized.statusCode >= 500 ? error : undefined,
          },
          normalized.message,
        );
        return reply.status(normalized.statusCode).send(normalized.toResponse(request.id));
      }

      // Unrecognised: log everything, return nothing.
      request.log.error({ err: error, path: request.url }, 'unhandled error');
      return reply.status(500).send(toErrorResponse(error, request.id));
    });

    app.setNotFoundHandler((request, reply) => {
      reply.status(404).send({
        error: {
          code: ERROR_CODES.NOT_FOUND,
          message: `Route ${request.method} ${request.url} not found.`,
          requestId: request.id,
        },
      });
    });

    done();
  },
  { name: 'error-handler' },
);
