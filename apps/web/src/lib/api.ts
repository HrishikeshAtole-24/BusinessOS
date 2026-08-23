import { cookies } from 'next/headers';
import { API_URL } from './config';

/**
 * Server-side API client.
 *
 * Section 24.1: the API stays the business boundary. Server Components read
 * through this client rather than reaching for Prisma, so authorization is
 * enforced in exactly one place instead of two that can disagree.
 *
 * Cookie forwarding is the part worth understanding. A Server Component runs on
 * the Next server, not in the browser, so it has no ambient cookie jar — the
 * session cookie must be attached explicitly from the incoming request.
 *
 * That works in development because cookies are scoped by host and **ignore the
 * port**: a cookie set by `localhost:4000` is visible to `localhost:3000`. In
 * production, where the API lives on a different hostname, this needs either a
 * shared parent domain with an explicit `Domain` attribute, or the API proxied
 * under the same origin. Worth deciding before deployment, not after.
 */

export { API_URL };

export interface ApiError {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = error.code;
    this.requestId = error.requestId;
    this.details = error.details;
  }
}

/**
 * Fetch from the API as the current user.
 *
 * `cache: 'no-store'` on everything. These responses are tenant- and
 * permission-scoped, and a cached one could be served to the wrong person —
 * which is a data leak, not a stale page.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let body: { error?: ApiError } = {};
    try {
      body = (await response.json()) as { error?: ApiError };
    } catch {
      // A non-JSON error body means the API is down or something upstream
      // returned HTML. Do not let a parse failure mask the real status.
    }
    throw new ApiRequestError(
      response.status,
      body.error ?? {
        code: 'UNKNOWN',
        message: `Request failed with status ${response.status}`,
        requestId: '',
      },
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Fetch that tolerates an expected failure.
 *
 * Useful where a 401 or 403 is a legitimate outcome to render around — an
 * unauthenticated visitor, or a section the current role cannot see — rather
 * than an exception to propagate.
 */
export async function apiFetchOrNull<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    return await apiFetch<T>(path, init);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
      return null;
    }
    throw error;
  }
}
