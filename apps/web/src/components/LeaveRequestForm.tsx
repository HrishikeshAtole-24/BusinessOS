'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { API_URL } from '../lib/config';

interface LeaveType {
  id: string;
  name: string;
  code: string;
  annualQuota: number;
  isPaid: boolean;
}

/**
 * Request time off.
 *
 * The server recomputes working days and re-checks the balance regardless of
 * what this form sends — the day count shown here is a preview, not an input.
 */
export function LeaveRequestForm({ types }: { types: LeaveType[] }) {
  const router = useRouter();
  const [leaveTypeId, setLeaveTypeId] = useState(types[0]?.id ?? '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setPending(true);
    try {
      const response = await fetch(`${API_URL}/v1/leave-requests`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leaveTypeId,
          startDate,
          endDate,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      const body = (await response.json()) as {
        error?: { message: string };
        days?: number;
        status?: string;
        awaiting?: string | null;
      };
      if (!response.ok) {
        setError(body.error?.message ?? 'Could not submit the request.');
        return;
      }
      setSuccess(
        body.status === 'APPROVED'
          ? `${body.days} day(s) approved automatically.`
          : `${body.days} day(s) requested — waiting on ${body.awaiting}.`,
      );
      setStartDate('');
      setEndDate('');
      setReason('');
      router.refresh();
    } catch {
      setError('Cannot reach the API.');
    } finally {
      setPending(false);
    }
  }

  // Weekdays only, matching the server. A preview that disagreed with the
  // stored value would be worse than no preview.
  const preview = countWorkingDays(startDate, endDate);

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Request time off</h2>
        {preview !== null ? <span className="badge">{preview} working day(s)</span> : null}
      </div>
      <form className="card-body stack" onSubmit={handleSubmit}>
        {error ? (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        ) : null}
        {success ? (
          <div className="alert alert-success" role="status">
            {success}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 180px' }}>
            <label className="label" htmlFor="leave-type">
              Type
            </label>
            <select
              id="leave-type"
              className="input"
              value={leaveTypeId}
              onChange={(e) => setLeaveTypeId(e.target.value)}
            >
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                  {type.annualQuota > 0 ? ` (${type.annualQuota}/yr)` : ' (unpaid)'}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="leave-start">
              From
            </label>
            <input
              id="leave-start"
              className="input"
              type="date"
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="leave-end">
              To
            </label>
            <input
              id="leave-end"
              className="input"
              type="date"
              required
              value={endDate}
              min={startDate || undefined}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="leave-reason">
            Reason (optional)
          </label>
          <input
            id="leave-reason"
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <button
          className="btn btn-primary"
          type="submit"
          style={{ alignSelf: 'flex-start' }}
          disabled={pending || !startDate || !endDate}
        >
          {pending ? 'Submitting…' : 'Request leave'}
        </button>
      </form>
    </section>
  );
}

function countWorkingDays(start: string, end: string): number | null {
  if (!start || !end || end < start) return null;
  let days = 0;
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
