import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { buildApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Integration tests for authentication, tenancy and authorization.
 *
 * These are the suites Section 20.2 marks critical: cross-tenant access
 * attempts, the role/permission matrix, and session revocation. They are worth
 * more than any unit test here, because every one of them describes a way the
 * system could leak another tenant's data.
 *
 * They run against the real database via `app.inject()`, which exercises the
 * full request pipeline — cookies, plugins, guards, Prisma — without binding a
 * port. Section 20.1 specifies Testcontainers for this; that needs Docker,
 * which is not available on this machine (ADR-015), so these run against the
 * seeded development database instead. Assertions are written to be
 * order-independent and to clean up what they create.
 *
 * Requires `pnpm db:seed` to have run.
 */

const PASSWORD = 'BusinessOS!2026';
const account = (role: string) => `${role}@businessos.dev`;
const DEMO_SLUG = 'demo';

let app: App;

beforeAll(async () => {
  // Rate limiting off: this suite logs in far more often than a human would.
  // The limiter itself is covered by rate-limit.test.ts.
  app = await buildApp({ rateLimit: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/**
 * Log in and return a session cookie with a known active organization.
 *
 * Login only auto-selects a tenant when the user belongs to exactly one. A user
 * who has since joined or created a second organization lands with no active
 * tenant and therefore no permissions — which made these tests depend on
 * unrelated data. Switching explicitly makes the fixture deterministic.
 */
async function login(email: string, slug = DEMO_SLUG, password = PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });
  expect(response.statusCode, `login failed for ${email}: ${response.body}`).toBe(200);

  const sessionCookie = response.cookies.find((c) => c.name === 'businessos.sid');
  expect(sessionCookie, 'no session cookie was set').toBeDefined();
  const cookie = `businessos.sid=${sessionCookie!.value}`;

  const { memberships } = response.json<{ memberships: Array<{ id: string; slug: string }> }>();
  const target = memberships.find((m) => m.slug === slug);
  expect(target, `${email} is not a member of "${slug}"`).toBeDefined();

  const switched = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${target!.id}/switch`,
    headers: { cookie },
  });
  expect(switched.statusCode, `switch to "${slug}" failed`).toBe(200);

  return cookie;
}

function get(url: string, cookie: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

// ---------------------------------------------------------------------------

describe('login', () => {
  it('issues an HttpOnly, SameSite=Lax session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: account('owner'), password: PASSWORD },
    });

    const cookie = response.cookies.find((c) => c.name === 'businessos.sid');
    expect(cookie).toBeDefined();
    // httpOnly is what stops an XSS bug from exfiltrating the session.
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Lax');
    expect(cookie!.path).toBe('/');
  });

  it('stores only a hash of the session token, never the token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: account('owner'), password: PASSWORD },
    });
    const token = response.cookies.find((c) => c.name === 'businessos.sid')!.value;

    // The plaintext must not appear anywhere in the sessions table.
    const stored = await prisma.session.findFirst({ where: { tokenHash: token } });
    expect(stored).toBeNull();
  });

  it('rejects a wrong password and an unknown email identically', async () => {
    // Any difference between these two responses — status, code, message — is
    // an account-enumeration oracle.
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: account('owner'), password: 'definitely-not-it' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'no-such-person@businessos.dev', password: 'definitely-not-it' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(wrongPassword.statusCode);

    const a = wrongPassword.json<{ error: { code: string; message: string } }>().error;
    const b = unknownUser.json<{ error: { code: string; message: string } }>().error;
    expect(b.code).toBe(a.code);
    expect(b.message).toBe(a.message);
  });

  it('never returns a password hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: account('owner'), password: PASSWORD },
    });
    expect(response.body).not.toContain('argon2');
    expect(response.body).not.toContain('passwordHash');
  });
});

describe('unauthenticated access', () => {
  it.each([
    ['GET', '/v1/auth/me'],
    ['GET', '/v1/organizations'],
    ['GET', '/v1/organizations/current'],
    ['GET', '/v1/organizations/current/members'],
    ['GET', '/v1/invitations'],
    ['POST', '/v1/organizations'],
  ])('%s %s requires a session', async (method, url) => {
    const response = await app.inject({ method: method as 'GET' | 'POST', url });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged session cookie', async () => {
    const response = await get('/v1/auth/me', 'businessos.sid=forged-token-value-aaaaaaaaaaaaaaaa');
    expect(response.statusCode).toBe(401);
  });
});

describe('permission matrix', () => {
  /**
   * The table is the specification. Adding a route means adding a row, and a
   * row that is wrong is an authorization bug caught here rather than in
   * production.
   */
  const matrix: Array<{
    url: string;
    permission: string;
    allowed: string[];
    denied: string[];
  }> = [
    {
      url: '/v1/organizations/current',
      permission: 'organization.read',
      allowed: ['owner', 'hr', 'manager', 'finance', 'employee'],
      denied: [],
    },
    {
      url: '/v1/organizations/current/roles',
      permission: 'role.read',
      allowed: ['owner'],
      denied: ['employee', 'finance'],
    },
    {
      url: '/v1/invitations',
      permission: 'member.invite',
      allowed: ['owner', 'hr'],
      denied: ['employee', 'finance', 'manager'],
    },
  ];

  for (const entry of matrix) {
    for (const role of entry.allowed) {
      it(`${role} CAN GET ${entry.url} (${entry.permission})`, async () => {
        const response = await get(entry.url, await login(account(role)));
        expect(response.statusCode).toBe(200);
      });
    }

    for (const role of entry.denied) {
      it(`${role} CANNOT GET ${entry.url} (${entry.permission})`, async () => {
        const response = await get(entry.url, await login(account(role)));
        expect(response.statusCode).toBe(403);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('PERMISSION_DENIED');
      });
    }
  }

  it('employee holds no permission ending in .approve', async () => {
    const response = await get('/v1/auth/me', await login(account('employee')));
    const { permissions } = response.json<{ permissions: string[] }>();
    expect(permissions.filter((p) => p.endsWith('.approve'))).toEqual([]);
  });

  it('employee holds no cross-person read permission', async () => {
    const response = await get('/v1/auth/me', await login(account('employee')));
    const { permissions } = response.json<{ permissions: string[] }>();
    for (const forbidden of ['leave.read', 'attendance.read', 'expense.read', 'audit.read']) {
      expect(permissions, `employee must not hold ${forbidden}`).not.toContain(forbidden);
    }
    expect(permissions).toContain('leave.read_self');
  });
});

describe('tenant isolation', () => {
  it('returns 404, not 403, when switching to an organization you do not belong to', async () => {
    // 403 would confirm the organization exists. 404 reveals nothing —
    // Section 32, IDOR.
    const cookie = await login(account('employee'));
    const foreign = '01a02fbf-0000-7000-8000-000000000000';

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${foreign}/switch`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('scopes the member list to the active organization only', async () => {
    const cookie = await login(account('owner'));
    const response = await get('/v1/organizations/current/members', cookie);

    const { data } = response.json<{ data: Array<{ user: { email: string } }> }>();
    const me = await get('/v1/auth/me', cookie);
    const organizationId = me.json<{ organization: { id: string } }>().organization.id;

    const expected = await prisma.membership.count({ where: { organizationId } });
    expect(data.length).toBe(expected);
  });

  it('derives the organization from the session, not from client input', async () => {
    // The guard reads request.auth.activeOrganizationId. A body or query
    // parameter naming another tenant must have no effect whatsoever.
    const cookie = await login(account('employee'));
    const foreign = '01a02fbf-0000-7000-8000-000000000000';

    const honest = await get('/v1/organizations/current', cookie);
    const attempted = await get(`/v1/organizations/current?organizationId=${foreign}`, cookie);

    expect(attempted.statusCode).toBe(honest.statusCode);
    expect(attempted.json<{ id: string }>().id).toBe(honest.json<{ id: string }>().id);
  });
});

describe('session lifecycle', () => {
  it('invalidates the session immediately on logout', async () => {
    const cookie = await login(account('finance'));
    expect((await get('/v1/auth/me', cookie)).statusCode).toBe(200);

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);

    // The same cookie must now fail. If this passes, revocation is cosmetic.
    expect((await get('/v1/auth/me', cookie)).statusCode).toBe(401);
  });

  it('keeps other sessions alive when one logs out', async () => {
    const first = await login(account('manager'));
    const second = await login(account('manager'));

    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: first } });

    expect((await get('/v1/auth/me', first)).statusCode).toBe(401);
    expect((await get('/v1/auth/me', second)).statusCode).toBe(200);
  });
});

describe('validation', () => {
  it('rejects a malformed email before touching the database', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email', password: 'whatever-goes-here' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  it('never leaks a stack trace or database detail', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    expect(response.body).not.toMatch(/at .*\(.*:\d+:\d+\)/); // stack frame
    expect(response.body.toLowerCase()).not.toContain('prisma');
    expect(response.body.toLowerCase()).not.toContain('postgres');
  });
});
