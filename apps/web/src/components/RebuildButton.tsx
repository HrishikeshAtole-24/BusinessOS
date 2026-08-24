'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { API_URL } from '../lib/config';

/**
 * Recompute the analytics read model.
 *
 * Synchronous here because the demo dataset is small. At real volume this
 * belongs on the reports queue — it is a long scan whose latency has nothing to
 * do with the click that started it, and Section 15.2 already has a queue for
 * exactly that shape of work.
 */
export function RebuildButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function rebuild() {
    setPending(true);
    setResult(null);
    try {
      const response = await fetch(`${API_URL}/v1/analytics/rebuild`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = (await response.json()) as {
        rowsWritten?: number;
        error?: { message: string };
      };
      setResult(
        response.ok
          ? `Recomputed ${body.rowsWritten ?? 0} daily rows`
          : (body.error?.message ?? 'Rebuild failed'),
      );
      if (response.ok) router.refresh();
    } catch {
      setResult('Cannot reach the API.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="row">
      {result ? (
        <span className="subtle" style={{ fontSize: 'var(--text-sm)' }} role="status">
          {result}
        </span>
      ) : null}
      <button className="btn btn-secondary" onClick={rebuild} disabled={pending}>
        {pending ? 'Recomputing…' : 'Rebuild metrics'}
      </button>
    </div>
  );
}
