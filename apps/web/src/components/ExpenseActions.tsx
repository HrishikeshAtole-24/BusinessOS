'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { API_URL } from '../lib/config';

/**
 * Row actions for one claim.
 *
 * Which buttons appear is driven by the state machine in
 * `@businessos/domain` — DRAFT can be submitted, SUBMITTED can be withdrawn,
 * APPROVED can be reimbursed by someone holding `expense.reimburse`. The API
 * re-checks all of it; this only avoids showing a button that would 409.
 */
export function ExpenseActions({
  expenseId,
  status,
  canReimburse,
}: {
  expenseId: string;
  status: string;
  canReimburse: boolean;
  isMine: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  async function act(action: 'submit' | 'withdraw' | 'reimburse') {
    setPending(action);
    try {
      await fetch(`${API_URL}/v1/expenses/${expenseId}/${action}`, {
        method: 'POST',
        credentials: 'include',
      });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  if (status === 'DRAFT') {
    return (
      <button className="btn btn-primary btn-sm" onClick={() => act('submit')} disabled={!!pending}>
        {pending ? '…' : 'Submit'}
      </button>
    );
  }

  if (status === 'SUBMITTED') {
    return (
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => act('withdraw')}
        disabled={!!pending}
      >
        {pending ? '…' : 'Withdraw'}
      </button>
    );
  }

  if (status === 'APPROVED' && canReimburse) {
    return (
      <button
        className="btn btn-primary btn-sm"
        onClick={() => act('reimburse')}
        disabled={!!pending}
      >
        {pending ? '…' : 'Reimburse'}
      </button>
    );
  }

  return null;
}
