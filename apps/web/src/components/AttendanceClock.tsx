'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API_URL } from '../lib/config';

/**
 * The clock-in widget.
 *
 * The elapsed counter ticks in the browser, but every number that matters —
 * net hours, breaks, overtime — comes from the server, which computes them by
 * merging intervals. A client-side duplicate of that arithmetic would be a
 * second implementation to keep in sync, and the two would eventually disagree
 * on somebody's pay.
 */

interface Break {
  id: string;
  startAt: string;
  endAt: string | null;
  reason: string | null;
}

interface Session {
  id: string;
  checkInAt: string;
  checkOutAt: string | null;
  source: string;
  /** Set by an HR correction; the before/after lives in the audit log. */
  notes: string | null;
  corrected: boolean;
  breaks: Break[];
}

export interface AttendanceToday {
  linked: boolean;
  workDate?: string;
  state?: 'WORKING' | 'ON_BREAK' | 'OUT';
  openSince?: string | null;
  breakSince?: string | null;
  sessions: Session[];
  summary: {
    gross: string;
    net: string;
    breaks: string;
    overtime: string;
    shortfall: string;
    overlapCount: number;
  } | null;
}

export function AttendanceClock({ today }: { today: AttendanceToday }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState('');

  const since = today.state === 'ON_BREAK' ? today.breakSince : today.openSince;

  // Rendered only after mount. Computing it during render would produce
  // different HTML on the server and the client — a guaranteed hydration
  // mismatch, since the two run at different instants.
  useEffect(() => {
    if (!since) {
      setElapsed('');
      return;
    }
    const start = new Date(since).getTime();
    const tick = () => {
      const ms = Date.now() - start;
      const minutes = Math.floor(ms / 60_000);
      setElapsed(`${Math.floor(minutes / 60)}h ${minutes % 60}m`);
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [since]);

  async function act(path: string) {
    setError(null);
    setPending(path);
    try {
      const response = await fetch(`${API_URL}/v1/attendance/${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: { message: string } };
      if (!response.ok) {
        setError(body.error?.message ?? 'Could not record that.');
        return;
      }
      router.refresh();
    } catch {
      setError('Cannot reach the API.');
    } finally {
      setPending(null);
    }
  }

  if (!today.linked) {
    return (
      <section className="card">
        <div className="card-body">
          <div className="empty">
            <div className="empty-title">No employee record</div>
            <p>Your account is not linked to an employee, so attendance cannot be recorded.</p>
          </div>
        </div>
      </section>
    );
  }

  const state = today.state ?? 'OUT';

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Today</h2>
        <span className="row" style={{ gap: 'var(--space-2)' }}>
          <span
            className={
              state === 'WORKING' ? 'dot dot-ok' : state === 'ON_BREAK' ? 'dot dot-warn' : 'dot'
            }
            aria-hidden="true"
          />
          {/* Text alongside the dot — status is never colour alone. */}
          <span className="muted">
            {state === 'WORKING' ? 'Working' : state === 'ON_BREAK' ? 'On break' : 'Not clocked in'}
          </span>
        </span>
      </div>

      <div className="card-body stack">
        {error ? (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        ) : null}

        {today.summary && today.summary.overlapCount > 0 ? (
          <div className="alert alert-info" role="status">
            {today.summary.overlapCount} overlapping session(s) today. Hours are computed from the
            merged intervals, so the total is right — but the punches need correcting.
          </div>
        ) : null}

        {elapsed ? (
          <div className="stat" style={{ border: 0, padding: 0 }}>
            <div className="stat-label">
              {state === 'ON_BREAK' ? 'On break for' : 'Working for'}
            </div>
            <div className="stat-value nums">{elapsed}</div>
          </div>
        ) : null}

        <div className="row" style={{ flexWrap: 'wrap' }}>
          {state === 'OUT' ? (
            <button
              className="btn btn-primary"
              onClick={() => act('check-in')}
              disabled={!!pending}
            >
              {pending === 'check-in' ? 'Checking in…' : 'Check in'}
            </button>
          ) : null}

          {state === 'WORKING' ? (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => act('break/start')}
                disabled={!!pending}
              >
                Start break
              </button>
              <button
                className="btn btn-primary"
                onClick={() => act('check-out')}
                disabled={!!pending}
              >
                {pending === 'check-out' ? 'Checking out…' : 'Check out'}
              </button>
            </>
          ) : null}

          {state === 'ON_BREAK' ? (
            <>
              <button
                className="btn btn-primary"
                onClick={() => act('break/end')}
                disabled={!!pending}
              >
                End break
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => act('check-out')}
                disabled={!!pending}
              >
                Check out
              </button>
              <span className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                Checking out closes the break automatically.
              </span>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
