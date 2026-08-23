'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { API_URL } from '../lib/config';

interface Membership {
  id: string;
  name: string;
  slug: string;
}

/**
 * Shown when a signed-in user has no active organization.
 *
 * Two paths: switch into one they already belong to, or create a new one.
 */
export function CreateOrganizationForm({ memberships }: { memberships: Membership[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`${API_URL}/v1/organizations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        setError(body.error?.message ?? 'Could not create the organization.');
        return;
      }
      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('Cannot reach the API.');
    } finally {
      setPending(false);
    }
  }

  async function switchTo(organizationId: string) {
    setPending(true);
    try {
      await fetch(`${API_URL}/v1/organizations/${organizationId}/switch`, {
        method: 'POST',
        credentials: 'include',
      });
      router.replace('/dashboard');
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-panel">
      <div className="auth-heading">
        <h1 style={{ fontSize: 'var(--text-lg)' }}>Choose a workspace</h1>
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          {memberships.length > 0
            ? 'Pick one to continue, or start a new organization.'
            : 'Create an organization to get started.'}
        </p>
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}

      {memberships.length > 0 ? (
        <div className="stack-sm" style={{ display: 'flex', flexDirection: 'column' }}>
          {memberships.map((membership) => (
            <button
              key={membership.id}
              type="button"
              className="btn btn-secondary btn-block"
              disabled={pending}
              onClick={() => switchTo(membership.id)}
            >
              {membership.name}
            </button>
          ))}
        </div>
      ) : null}

      <form onSubmit={createOrganization} className="stack">
        <div className="field">
          <label className="label" htmlFor="new-org">
            New organization
          </label>
          <input
            id="new-org"
            className="input"
            value={name}
            required
            minLength={2}
            placeholder="Acme Industries"
            onChange={(e) => setName(e.target.value)}
          />
          <span className="field-hint">Provisions six system roles and makes you the owner.</span>
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={pending || !name}>
          {pending ? 'Creating…' : 'Create organization'}
        </button>
      </form>
    </div>
  );
}
