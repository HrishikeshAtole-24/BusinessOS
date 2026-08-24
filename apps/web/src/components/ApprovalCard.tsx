'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { API_URL } from '../lib/config';

/**
 * One item in the approval inbox.
 *
 * Shows the whole chain, not just the current step. An approver deciding
 * without seeing who came before — and who comes after — is deciding with less
 * context than the policy assumed.
 */

interface Step {
  id: string;
  sequence: number;
  name: string;
  approverType: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';
  approver: { id: string; firstName: string; lastName: string } | null;
  approverRoleKey: string | null;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  comment: string | null;
}

export interface Approval {
  id: string;
  entityType: 'EXPENSE' | 'LEAVE';
  entityId: string;
  amount: string | null;
  currency: string | null;
  currentSequence: number | null;
  createdAt: string;
  requester: { id: string; firstName: string; lastName: string };
  steps: Step[];
}

const STEP_TONE: Record<Step['status'], string> = {
  PENDING: 'badge badge-warning',
  APPROVED: 'badge badge-success',
  REJECTED: 'badge badge-danger',
  SKIPPED: 'badge',
};

export function ApprovalCard({ approval }: { approval: Approval }) {
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = approval.steps.find((s) => s.sequence === approval.currentSequence);

  async function decide(decision: 'APPROVED' | 'REJECTED') {
    setError(null);
    setPending(decision);
    try {
      const response = await fetch(`${API_URL}/v1/approvals/${approval.id}/decide`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, ...(comment.trim() ? { comment: comment.trim() } : {}) }),
      });
      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        setError(body.error?.message ?? 'Could not record the decision.');
        return;
      }
      // The inbox is server-rendered, so re-run it rather than mutating local
      // state — the decision may also have moved the request to someone else.
      router.refresh();
    } catch {
      setError('Cannot reach the API.');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div className="row">
          <span className="badge badge-accent">{approval.entityType.toLowerCase()}</span>
          <span className="card-title">
            {approval.requester.firstName} {approval.requester.lastName}
          </span>
        </div>
        {approval.amount ? (
          <span className="badge nums">
            {approval.currency} {approval.amount}
          </span>
        ) : null}
      </div>

      <div className="card-body stack">
        {error ? (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        ) : null}

        <ol className="chain">
          {approval.steps.map((step) => (
            <li
              className={
                step.sequence === approval.currentSequence
                  ? 'chain-item chain-current'
                  : 'chain-item'
              }
              key={step.id}
            >
              <span className="order-index nums">{step.sequence}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <strong>{step.name}</strong>
                  <span className={STEP_TONE[step.status]}>{step.status.toLowerCase()}</span>
                </div>
                <div className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                  {step.approver
                    ? `${step.approver.firstName} ${step.approver.lastName}`
                    : step.approverRoleKey
                      ? `anyone with the ${step.approverRoleKey} role`
                      : '—'}
                  {step.decidedBy ? ` · decided by ${step.decidedBy.name}` : ''}
                  {/* The skip reason is stored on the step: a chain with a
                      silently missing link is impossible to explain later. */}
                  {step.comment ? ` · ${step.comment}` : ''}
                </div>
              </span>
            </li>
          ))}
        </ol>

        {current ? (
          <>
            <div className="field">
              <label className="label" htmlFor={`comment-${approval.id}`}>
                Comment (optional)
              </label>
              <input
                id={`comment-${approval.id}`}
                className="input"
                value={comment}
                placeholder="Why you are approving or rejecting"
                onChange={(e) => setComment(e.target.value)}
              />
            </div>
            <div className="row">
              <button
                className="btn btn-primary"
                onClick={() => decide('APPROVED')}
                disabled={pending !== null}
              >
                {pending === 'APPROVED' ? 'Approving…' : `Approve ${current.name}`}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => decide('REJECTED')}
                disabled={pending !== null}
              >
                {pending === 'REJECTED' ? 'Rejecting…' : 'Reject'}
              </button>
              <span className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                Rejecting ends the whole request.
              </span>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
