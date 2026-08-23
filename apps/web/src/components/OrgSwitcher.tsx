'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { API_URL } from '../lib/config';

/**
 * Organization switcher.
 *
 * ADR-016 means no Radix, so the accessible-menu behaviour is ours to
 * implement. The parts that are easy to skip and matter most:
 *
 *   - `aria-expanded` / `aria-haspopup` so assistive tech announces state
 *   - Escape closes and returns focus to the trigger
 *   - Click outside closes
 *   - Arrow keys move between items, not just Tab
 *
 * A div with an onClick would look identical and be unusable without a mouse.
 */

interface Organization {
  id: string;
  name: string;
  slug: string;
}

interface OrgSwitcherProps {
  current: Organization;
  memberships: Organization[];
}

export function OrgSwitcher({ current, memberships }: OrgSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Close on outside click and on Escape. Both listeners are attached only
  // while open, so a closed menu costs nothing.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        // Returning focus to the trigger is what keeps keyboard navigation
        // coherent — otherwise focus falls back to <body> and the user has to
        // tab from the top of the page again.
        triggerRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function onTriggerKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
      // Focus the first item on the next frame, once the menu has rendered.
      requestAnimationFrame(() => itemRefs.current[0]?.focus());
    }
  }

  function onItemKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      itemRefs.current[(index + 1) % memberships.length]?.focus();
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      itemRefs.current[(index - 1 + memberships.length) % memberships.length]?.focus();
    }
  }

  async function switchTo(organizationId: string) {
    if (organizationId === current.id) {
      setOpen(false);
      return;
    }
    setPending(true);
    try {
      await fetch(`${API_URL}/v1/organizations/${organizationId}/switch`, {
        method: 'POST',
        credentials: 'include',
      });
      setOpen(false);
      // Re-run every Server Component: the whole shell is tenant-scoped, so
      // navigation, permissions and page data all change.
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="org-switcher" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="org-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="dot dot-ok" aria-hidden="true" />
        <span className="org-trigger-name">{current.name}</span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div className="menu" role="menu" aria-label="Switch organization">
          <div className="menu-label">Organizations</div>
          {memberships.map((organization, index) => (
            <button
              key={organization.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              className="menu-item"
              aria-current={organization.id === current.id}
              onClick={() => switchTo(organization.id)}
              onKeyDown={(e) => onItemKeyDown(e, index)}
            >
              <span>{organization.name}</span>
              {organization.id === current.id ? <CheckIcon /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* Inline SVG rather than an icon package: two icons do not justify a
   dependency, and these inherit currentColor for free. */

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{
        transform: open ? 'rotate(180deg)' : undefined,
        transition: 'transform var(--duration-fast) var(--ease)',
        flexShrink: 0,
      }}
    >
      <path
        d="M3 4.5 6 7.5 9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2.5 7.5 5.5 10.5 11.5 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
