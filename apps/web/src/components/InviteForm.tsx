'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { API_URL } from '../lib/config';

/**
 * Invite a colleague.
 *
 * Email delivery does not exist yet, so the API returns the accept link and
 * this form shows it for copying. That is a development affordance and is
 * called out as such in the UI — an invite link visible on screen is visible to
 * anyone looking at the screen.
 */

interface Role {
  key: string;
  name: string;
}

export function InviteForm({ roles }: { roles: Role[] }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState(
    roles.find((r) => r.key === 'employee')?.key ?? roles[0]?.key ?? '',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setInviteLink(null);
    setPending(true);

    try {
      const response = await fetch(`${API_URL}/v1/invitations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, roleKey }),
      });

      const body = (await response.json()) as {
        error?: { message: string };
        acceptToken?: string;
      };

      if (!response.ok) {
        setError(body.error?.message ?? 'Could not send the invitation.');
        return;
      }

      setInviteLink(`${window.location.origin}/invite/${body.acceptToken}`);
      setEmail('');
      // Re-run the Server Components so the pending-invitations table below
      // reflects the new row without a full reload.
      router.refresh();
    } catch {
      setError('Cannot reach the API.');
    } finally {
      setPending(false);
    }
  }

  async function copyLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the link is selectable on screen either
      // way, so this is not worth surfacing as an error.
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Invite someone</h2>
      </div>

      <div className="card-body stack">
        {error ? (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        ) : null}

        {inviteLink ? (
          <div className="alert alert-success" role="status">
            <div className="stack-sm" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <strong>Invitation created</strong>
              <span style={{ fontSize: 'var(--text-sm)' }}>
                Email delivery is not wired up yet, so share this link directly. It is single use
                and expires in 7 days.
              </span>
              <div className="row" style={{ marginTop: 'var(--space-2)' }}>
                <code
                  className="mono"
                  style={{
                    flex: 1,
                    overflowX: 'auto',
                    padding: 'var(--space-2)',
                    background: 'var(--surface-sunken)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {inviteLink}
                </code>
                <button type="button" className="btn btn-secondary btn-sm" onClick={copyLink}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <form
          onSubmit={handleSubmit}
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
          }}
        >
          <div className="field" style={{ flex: '2 1 240px' }}>
            <label className="label" htmlFor="invite-email">
              Email address
            </label>
            <input
              id="invite-email"
              className="input"
              type="email"
              required
              value={email}
              placeholder="colleague@company.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field" style={{ flex: '1 1 160px' }}>
            <label className="label" htmlFor="invite-role">
              Role
            </label>
            <select
              id="invite-role"
              className="input"
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value)}
            >
              {roles.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.name}
                </option>
              ))}
            </select>
          </div>

          <button className="btn btn-primary" type="submit" disabled={pending || !email}>
            {pending ? 'Creating…' : 'Send invite'}
          </button>
        </form>
      </div>
    </section>
  );
}
