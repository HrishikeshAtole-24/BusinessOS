import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../app.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

/**
 * Contract tests for the generated OpenAPI document.
 *
 * The spec is generated from the route table, so it cannot drift from the
 * implementation — but it CAN drift from intent. The tests that matter here are
 * the security ones: an endpoint accidentally documented as public is a
 * documented invitation, and reviewers trust a spec more than they trust
 * reading every route file.
 */

let app: App;
let spec: {
  openapi: string;
  paths: Record<string, Record<string, { security?: unknown[]; tags?: string[] }>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
};

const METHODS = new Set(['get', 'post', 'patch', 'put', 'delete']);

/** Every documented operation, as [method, path, operation]. */
function operations() {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.has(method))
      .map(([method, op]) => ({ method: method.toUpperCase(), path, op })),
  );
}

beforeAll(async () => {
  app = await buildApp({ rateLimit: false });
  await app.ready();
  spec = app.swagger() as typeof spec;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('OpenAPI document', () => {
  it('generates without throwing', () => {
    // Regression: the transform assumed `schema` was always defined, which the
    // library's own types claim. At runtime it is undefined for any route
    // without an explicit schema, and generation crashed.
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
  });

  it('documents the session cookie scheme', () => {
    expect(spec.components.securitySchemes).toHaveProperty('sessionCookie');
  });

  it('publishes the shared error envelope', () => {
    expect(spec.components.schemas).toHaveProperty('Error');
  });

  it('tags every operation, so nothing lands in an unnamed bucket', () => {
    const untagged = operations().filter(
      ({ path, op }) => path !== '/' && (!op.tags || op.tags.length === 0),
    );
    expect(untagged.map((u) => `${u.method} ${u.path}`)).toEqual([]);
  });
});

describe('OpenAPI security', () => {
  /**
   * The exact set of operations reachable without a session.
   *
   * Written as an allowlist rather than a count. A new public endpoint should
   * fail this test and require someone to add it here deliberately — that
   * moment of friction is the entire point.
   */
  const EXPECTED_PUBLIC = [
    'GET /',
    'GET /health/dependencies',
    'GET /health/live',
    'GET /health/ready',
    'GET /v1/invitations/preview/{token}',
    'POST /v1/auth/login',
    'POST /v1/auth/signup',
    'POST /v1/invitations/accept',
  ];

  it('marks exactly the intended operations as public', () => {
    const actual = operations()
      .filter(({ op }) => Array.isArray(op.security) && op.security.length === 0)
      .map(({ method, path }) => `${method} ${path}`)
      .sort();

    expect(actual).toEqual(EXPECTED_PUBLIC);
  });

  it('requires a session for every tenant-scoped endpoint', () => {
    // Anything under /v1 that is not on the allowlist must inherit the
    // document-level requirement rather than opting out.
    const leaked = operations()
      .filter(({ method, path }) => {
        if (!path.startsWith('/v1')) return false;
        return !EXPECTED_PUBLIC.includes(`${method} ${path}`);
      })
      .filter(({ op }) => Array.isArray(op.security) && op.security.length === 0)
      .map(({ method, path }) => `${method} ${path}`);

    expect(leaked).toEqual([]);
  });

  it('never documents an organizationId parameter', () => {
    /**
     * Section 9.3: the tenant comes from the session, never from client input.
     * If one of these ever appears in the spec, some endpoint started accepting
     * a caller-chosen tenant — which is the whole isolation boundary gone.
     */
    const offenders: string[] = [];
    for (const { method, path, op } of operations()) {
      const params =
        (op as { parameters?: Array<{ name?: string; in?: string }> }).parameters ?? [];
      for (const param of params) {
        if (param.name === 'organizationId' && param.in !== 'path') {
          offenders.push(`${method} ${path} (${param.in ?? 'unknown'})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
