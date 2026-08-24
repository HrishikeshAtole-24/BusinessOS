import { apiFetch } from '../../../lib/api';
import { requireSession } from '../../../lib/session';
import { ApprovalCard, type Approval } from '../../../components/ApprovalCard';

export const metadata = { title: 'Approvals — BusinessOS' };

interface InboxResponse {
  data: Approval[];
  total: number;
}

/**
 * Approval inbox.
 *
 * Only shows requests whose CURRENT step is one you can act on. A later step
 * you own must not appear yet — the chain is sequential, and showing it early
 * would invite a decision made without the earlier context.
 */
export default async function ApprovalsPage() {
  const session = await requireSession();
  const inbox = await apiFetch<InboxResponse>('/v1/approvals/inbox');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-subtitle">
            {inbox.total === 0
              ? 'Nothing is waiting on you.'
              : `${inbox.total} request${inbox.total === 1 ? '' : 's'} waiting on you.`}
          </p>
        </div>
        <span className="badge badge-accent">{session.roles.join(', ') || 'no role'}</span>
      </div>

      {inbox.data.length === 0 ? (
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <div className="empty-title">Inbox clear</div>
              <p>
                Requests appear here when a step names you directly, or names a role you hold, and
                it is that step&apos;s turn.
              </p>
            </div>
          </div>
        </section>
      ) : (
        inbox.data.map((approval) => <ApprovalCard approval={approval} key={approval.id} />)
      )}
    </div>
  );
}
