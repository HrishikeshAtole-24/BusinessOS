'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { API_URL } from '../lib/config';

/**
 * The notification bell.
 *
 * The list is fetched when opened rather than kept live: polling on every page
 * for a badge nobody is looking at is wasted work. The unread COUNT comes from
 * the server render, so the badge is correct on first paint.
 *
 * Ordering comes from the API, which runs the priority heap — urgent first,
 * then oldest within a band.
 */

interface Notification {
  id: string;
  type: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

const PRIORITY_TONE: Record<Notification['priority'], string> = {
  URGENT: 'badge badge-danger',
  HIGH: 'badge badge-warning',
  NORMAL: 'badge',
  LOW: 'badge',
};

export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<Notification[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`${API_URL}/v1/notifications?limit=15`, {
          credentials: 'include',
        });
        if (!response.ok) return;
        const body = (await response.json()) as { data: Notification[]; unread: number };
        if (cancelled) return;
        setItems(body.data);
        setUnread(body.unread);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function markAllRead() {
    await fetch(`${API_URL}/v1/notifications/read-all`, {
      method: 'POST',
      credentials: 'include',
    });
    setUnread(0);
    setItems(
      (current) => current?.map((n) => ({ ...n, readAt: new Date().toISOString() })) ?? null,
    );
    router.refresh();
  }

  async function openItem(item: Notification) {
    if (!item.readAt) {
      await fetch(`${API_URL}/v1/notifications/${item.id}/read`, {
        method: 'POST',
        credentials: 'include',
      });
      setUnread((n) => Math.max(0, n - 1));
    }
    setOpen(false);
    if (item.link) router.push(item.link);
    router.refresh();
  }

  return (
    <div className="org-switcher" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        // The count goes in the accessible name, not only the coloured dot.
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon />
        {unread > 0 ? <span className="icon-btn-dot" aria-hidden="true" /> : null}
      </button>

      {open ? (
        <div className="menu" role="menu" aria-label="Notifications" style={{ minWidth: 320 }}>
          <div className="row-between" style={{ padding: 'var(--space-2) var(--space-3)' }}>
            <span className="menu-label" style={{ padding: 0 }}>
              Notifications
            </span>
            {unread > 0 ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={markAllRead}>
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="menu-divider" />

          {items === null ? (
            <div className="menu-item subtle">Loading…</div>
          ) : items.length === 0 ? (
            <div className="menu-item subtle">Nothing yet</div>
          ) : (
            <div style={{ maxHeight: 340, overflowY: 'auto' }}>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  style={{
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 2,
                    opacity: item.readAt ? 0.6 : 1,
                  }}
                  onClick={() => openItem(item)}
                >
                  <span className="row" style={{ gap: 'var(--space-2)' }}>
                    <span className={PRIORITY_TONE[item.priority]}>
                      {item.priority.toLowerCase()}
                    </span>
                    <strong>{item.title}</strong>
                  </span>
                  {item.body ? (
                    <span className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                      {item.body}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
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
