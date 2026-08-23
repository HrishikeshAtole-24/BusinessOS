'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { API_URL } from '../lib/config';
import { OrgSwitcher } from './OrgSwitcher';

/**
 * Topbar: search, notifications, organization switcher, account menu.
 *
 * Search and notifications are present but inert until the modules that back
 * them exist (Sections 16 and 15.2). They are marked as such rather than
 * hidden — the `⌘K` affordance is worth teaching before the feature lands, and
 * a disabled control is honest where a missing one is confusing.
 */

interface Organization {
  id: string;
  name: string;
  slug: string;
}

interface TopbarProps {
  organization: Organization;
  memberships: Organization[];
  user: { name: string; email: string };
  initials: string;
  roles: string[];
}

export function Topbar({ organization, memberships, user, initials, roles }: TopbarProps) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  async function signOut() {
    setSigningOut(true);
    try {
      // Revoke server-side before clearing anything locally. The cookie is a
      // copy of the credential, not the credential itself.
      await fetch(`${API_URL}/v1/auth/logout`, { method: 'POST', credentials: 'include' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-search">
        <span className="topbar-search-icon">
          <SearchIcon />
        </span>
        <input
          className="input"
          type="search"
          placeholder="Search — coming with the People module"
          disabled
          aria-label="Search (not yet available)"
        />
      </div>

      <div className="topbar-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label="Notifications (not yet available)"
          title="Notifications arrive with the events module"
          disabled
        >
          <BellIcon />
        </button>

        <OrgSwitcher current={organization} memberships={memberships} />

        <div className="org-switcher" ref={menuRef}>
          <button
            ref={triggerRef}
            type="button"
            className="org-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <span className="org-trigger-name">{user.name}</span>
          </button>

          {menuOpen ? (
            <div className="menu" role="menu" aria-label="Account">
              <div className="menu-label">Signed in as</div>
              <div
                className="menu-item"
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
              >
                <span style={{ fontWeight: 'var(--weight-medium)' }}>{user.name}</span>
                <span className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                  {user.email}
                </span>
                <span className="badge badge-accent" style={{ marginTop: 'var(--space-1)' }}>
                  {roles.join(', ') || 'no role'}
                </span>
              </div>
              <div className="menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={signOut}
                disabled={signingOut}
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.5 9.5 12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2a4 4 0 0 0-4 4v2.5L2.75 10.5h10.5L12 8.5V6a4 4 0 0 0-4-4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6.25 12.5a1.75 1.75 0 0 0 3.5 0" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
