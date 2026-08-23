'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { API_URL } from '../lib/config';

/**
 * Sign-in form.
 *
 * A Client Component because it owns transient interaction state — pending,
 * error, field values — that never needs to reach the server.
 *
 * It posts directly to the API with `credentials: 'include'` so the API sets
 * the session cookie itself. Routing it through a Next server action would mean
 * relaying a Set-Cookie header between two servers for no benefit.
 */

interface DemoAccount {
  role: string;
  email: string;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  { role: 'Owner', email: 'owner@businessos.dev' },
  { role: 'HR', email: 'hr@businessos.dev' },
  { role: 'Manager', email: 'manager@businessos.dev' },
  { role: 'Finance', email: 'finance@businessos.dev' },
  { role: 'Employee', email: 'employee@businessos.dev' },
];

const DEMO_PASSWORD = 'BusinessOS!2026';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('owner@businessos.dev');
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const response = await fetch(`${API_URL}/v1/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const body = (await response.json()) as {
        error?: { message: string };
        memberships?: Array<{ id: string; slug: string }>;
        activeOrganizationId?: string | null;
      };

      if (!response.ok) {
        setError(body.error?.message ?? 'Something went wrong. Try again.');
        return;
      }

      // Login only auto-selects a tenant when there is exactly one. With
      // several, pick the first so the user lands somewhere useful; a proper
      // chooser belongs here once multi-org is common.
      if (!body.activeOrganizationId && body.memberships?.length) {
        await fetch(`${API_URL}/v1/organizations/${body.memberships[0]!.id}/switch`, {
          method: 'POST',
          credentials: 'include',
        });
      }

      // refresh() re-runs the Server Components so the shell picks up the new
      // session; push() alone would render the old cached tree.
      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('Cannot reach the API. Is it running on port 4000?');
    } finally {
      setPending(false);
    }
  }

  function useDemoAccount(demoEmail: string) {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    setError(null);
  }

  return (
    <form className="auth-panel" onSubmit={handleSubmit} noValidate>
      <div className="auth-heading">
        <h1 style={{ fontSize: 'var(--text-lg)' }}>Sign in</h1>
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          Continue to your workspace
        </p>
      </div>

      {/* role="alert" so a screen reader announces the failure rather than
          leaving it as silent red text. */}
      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="field">
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="input"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
        />
      </div>

      <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      <div className="auth-demo">
        <span>Demo accounts — each has a different permission set:</span>
        <div className="demo-row">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => useDemoAccount(account.email)}
            >
              {account.role}
            </button>
          ))}
        </div>
      </div>
    </form>
  );
}
