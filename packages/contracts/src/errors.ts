/**
 * The API error contract (report Section 12.3).
 *
 * Every failure leaving the API has the same shape:
 *
 * ```json
 * {
 *   "error": {
 *     "code": "TASK_DEPENDENCY_CYCLE",
 *     "message": "The dependency would create a cycle.",
 *     "requestId": "req_01J...",
 *     "details": { "taskId": "..." }
 *   }
 * }
 * ```
 *
 * `code` is the contract; `message` is for humans and may be reworded without
 * a breaking change. Clients branch on `code`, never on `message`.
 *
 * Section 12.3 is emphatic about what must NOT cross this boundary: stack
 * traces, database error text, and internal identifiers. The design here makes
 * that structural rather than a matter of discipline — see `isOperational`.
 */

export const ERROR_CODES = {
  // 400 — the request itself is malformed
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_CURSOR: 'MALFORMED_CURSOR',

  // 401 — we do not know who you are
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',

  // 403 — we know who you are, and the answer is no
  FORBIDDEN: 'FORBIDDEN',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /**
   * A resource was addressed that belongs to a different organization.
   *
   * Deliberately never returned to a client — the handler maps it to a plain
   * 404. Confirming "this ID exists but is not yours" is itself a disclosure
   * (Section 32, IDOR). The distinct code exists so the audit log and alerting
   * can tell an isolation breach attempt apart from an ordinary miss.
   */
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  ORGANIZATION_SUSPENDED: 'ORGANIZATION_SUSPENDED',

  // 404
  NOT_FOUND: 'NOT_FOUND',

  // 409 — the request is well-formed but conflicts with current state
  CONFLICT: 'CONFLICT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // 422 — well-formed, understood, but violates a business invariant
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INSUFFICIENT_LEAVE_BALANCE: 'INSUFFICIENT_LEAVE_BALANCE',
  TASK_DEPENDENCY_CYCLE: 'TASK_DEPENDENCY_CYCLE',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',

  // 5xx
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Serialized error body. This is the public shape; nothing else escapes. */
export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Base class for every error the API raises deliberately.
 *
 * `isOperational` is the safety catch. An `AppError` is something we anticipated
 * and whose message we wrote, so it is safe to send. Anything else — a driver
 * error, a null dereference, a bug — is not an `AppError`, and the handler
 * replaces it wholesale with a generic 500. The default is therefore "say
 * nothing", and disclosure requires an explicit decision at throw time.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;
  readonly isOperational = true;

  constructor(
    code: ErrorCode,
    statusCode: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, new.target);
  }

  toResponse(requestId: string): ErrorResponseBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request failed validation.', details?: Record<string, unknown>) {
    super(ERROR_CODES.VALIDATION_FAILED, 400, message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(
    message = 'Authentication is required.',
    code: ErrorCode = ERROR_CODES.UNAUTHENTICATED,
  ) {
    super(code, 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    details?: Record<string, unknown>,
  ) {
    super(ERROR_CODES.PERMISSION_DENIED, 403, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(ERROR_CODES.NOT_FOUND, 404, `${resource} not found.`);
  }
}

/**
 * Raised when a tenant-scoped lookup crosses an organization boundary.
 *
 * Carries a 404 status, not 403, so that even a mishandled throw cannot leak
 * existence. See `ERROR_CODES.TENANT_MISMATCH`.
 */
export class TenantMismatchError extends AppError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.TENANT_MISMATCH, 404, 'Resource not found.', undefined);
    Object.defineProperty(this, 'auditDetails', { value: details, enumerable: false });
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'The request conflicts with the current state of the resource.',
    code: ErrorCode = ERROR_CODES.CONFLICT,
    details?: Record<string, unknown>,
  ) {
    super(code, 409, message, details);
  }
}

/** Optimistic concurrency failure — Section 11.2. */
export class VersionConflictError extends ConflictError {
  constructor(expected: number) {
    super(
      'This record was modified by someone else. Refresh and try again.',
      ERROR_CODES.VERSION_CONFLICT,
      { expectedVersion: expected },
    );
  }
}

/** A disallowed move in a state machine — Section 8. */
export class InvalidStateTransitionError extends ConflictError {
  constructor(from: string, to: string, allowed: readonly string[]) {
    super(`Cannot move from ${from} to ${to}.`, ERROR_CODES.INVALID_STATE_TRANSITION, {
      from,
      to,
      allowed,
    });
  }
}

/** A well-formed request that would break a business invariant — Section 8.4. */
export class BusinessRuleError extends AppError {
  constructor(
    message: string,
    code: ErrorCode = ERROR_CODES.BUSINESS_RULE_VIOLATION,
    details?: Record<string, unknown>,
  ) {
    super(code, 422, message, details);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(ERROR_CODES.RATE_LIMITED, 429, 'Too many requests. Please slow down.', {
      retryAfterSeconds,
    });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Last line of defence. Anything that is not an `AppError` becomes an opaque
 * 500 — the original is logged server-side with its stack and never serialized.
 */
export function toErrorResponse(error: unknown, requestId: string): ErrorResponseBody {
  if (isAppError(error)) return error.toResponse(requestId);

  return {
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
      requestId,
    },
  };
}
