'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { API_URL } from '../lib/config';

/**
 * Identity chip and sign-out.
 *
 * Sign-out calls the API so the session is revoked server-side. Clearing the
 * cookie alone would leave a token that still authenticates if it was ever
 * captured — the cookie is a copy, not the session.
 */

interface UserMenuProps {
  name: string;
  email: string;
  initials: string;
  roles: string[];
}

export function UserMenu({ name, email, initials, roles }: UserMenuProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await fetch(`${API_URL}/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <div className="row">
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <span className="avatar" aria-hidden="true">
          {initials}
        </span>
        <div style={{ lineHeight: 1.3 }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)' }}>
            {name}
          </div>
          <div className="subtle" style={{ fontSize: 'var(--text-xs)' }} title={email}>
            {roles.join(', ') || 'no role'}
          </div>
        </div>
      </div>

      <button className="btn btn-ghost btn-sm" onClick={signOut} disabled={pending}>
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
