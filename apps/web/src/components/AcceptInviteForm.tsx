'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { API_URL } from '../lib/config';

/**
 * Accept an invitation.
 *
 * Two shapes behind one form. `requiresAccount` comes from the server, which
 * decides it from the invited email address — not from anything this component
 * asserts, and not from a query parameter. A client-controlled flag here would
 * let someone claim "no account needed" and skip setting a password.
 */

interface InvitePreview {
  email: string;
  organization: { name: string; slug: string };
  role: { key: string; name: string };
  requiresAccount: boolean;
}

const MIN_PASSWORD_LENGTH = 12;

export function AcceptInviteForm({ token, preview }: { token: string; preview: InvitePreview }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (preview.requiresAccount && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setPending(true);
    try {
      const response = await fetch(`${API_URL}/v1/invitations/accept`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          ...(preview.requiresAccount ? { name, password } : {}),
        }),
      });

      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        setError(body.error?.message ?? 'Could not accept the invitation.');
        return;
      }

      // Accepting signs you in, so go straight to the dashboard.
      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('Cannot reach the API.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="auth-panel" onSubmit={handleSubmit} noValidate>
      <div className="auth-heading">
        <h1 style={{ fontSize: 'var(--text-lg)' }}>Join {preview.organization.name}</h1>
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          Invited as <strong>{preview.role.name}</strong>
        </p>
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="field">
        <label className="label" htmlFor="invited-email">
          Email
        </label>
        {/* Read-only: the invitation is bound to this address. Letting it be
            edited would mean accepting an invite meant for someone else. */}
        <input id="invited-email" className="input" value={preview.email} disabled readOnly />
      </div>

      {preview.requiresAccount ? (
        <>
          <div className="field">
            <label className="label" htmlFor="invited-name">
              Your name
            </label>
            <input
              id="invited-name"
              className="input"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="invited-password">
              Choose a password
            </label>
            <input
              id="invited-password"
              className="input"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby="invited-password-hint"
            />
            <span className="field-hint" id="invited-password-hint">
              At least {MIN_PASSWORD_LENGTH} characters.
            </span>
          </div>
        </>
      ) : (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          You already have a BusinessOS account. Accepting adds this organization to it.
        </p>
      )}

      <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
        {pending ? 'Joining…' : `Join ${preview.organization.name}`}
      </button>
    </form>
  );
}
