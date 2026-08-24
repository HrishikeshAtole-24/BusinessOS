import { apiFetch } from '../../../lib/api';
import { requireSession } from '../../../lib/session';
import { LeaveRequestForm } from '../../../components/LeaveRequestForm';

export const metadata = { title: 'Leave — BusinessOS' };

interface BalanceResponse {
  data: Array<{
    leaveType: { id: string; name: string; code: string; colour: string | null };
    year: number;
    entitled: number;
    used: number;
    pending: number;
    available: number;
  }>;
}

interface LeaveResponse {
  data: Array<{
    id: string;
    status: string;
    startDate: string;
    endDate: string;
    days: number;
    reason: string | null;
    employee: { id: string; firstName: string; lastName: string };
    leaveType: { id: string; name: string; code: string; colour: string | null };
  }>;
  scope: 'self' | 'organization';
}

interface TypesResponse {
  data: Array<{ id: string; name: string; code: string; annualQuota: number; isPaid: boolean }>;
}

const STATUS_TONE: Record<string, string> = {
  SUBMITTED: 'badge badge-warning',
  APPROVED: 'badge badge-success',
  REJECTED: 'badge badge-danger',
  CANCELLED: 'badge',
  DRAFT: 'badge',
};

export default async function LeavePage() {
  const session = await requireSession();
  const [balances, requests, types] = await Promise.all([
    apiFetch<BalanceResponse>('/v1/leave-balances'),
    apiFetch<LeaveResponse>('/v1/leave-requests?limit=50'),
    apiFetch<TypesResponse>('/v1/leave-types'),
  ]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Leave</h1>
          <p className="page-subtitle">
            {requests.scope === 'organization'
              ? 'All leave in the organization'
              : 'Your leave and balances'}
          </p>
        </div>
      </div>

      {balances.data.length > 0 ? (
        <div className="stat-grid">
          {balances.data.map((balance) => (
            <div className="stat" key={balance.leaveType.id}>
              <div className="stat-label">
                <span className="row" style={{ gap: 'var(--space-2)' }}>
                  {balance.leaveType.colour ? (
                    <span
                      className="dot"
                      style={{ background: balance.leaveType.colour }}
                      aria-hidden="true"
                    />
                  ) : null}
                  {balance.leaveType.name}
                </span>
              </div>
              <div className="stat-value nums">{balance.available}</div>
              <div className="stat-meta">
                {/* `pending` is shown because it is deducted from available:
                    it is what stops the same days being booked twice. */}
                {balance.used} used · {balance.pending} held · {balance.entitled} total
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <LeaveRequestForm types={types.data} />

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Requests</h2>
          <span className="badge">{requests.data.length}</span>
        </div>
        {requests.data.length === 0 ? (
          <div className="card-body">
            <div className="empty">
              <div className="empty-title">No leave requested</div>
              <p>Request time off above.</p>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {requests.scope === 'organization' ? <th>Who</th> : null}
                  <th>Type</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Days</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {requests.data.map((leave) => (
                  <tr key={leave.id}>
                    {requests.scope === 'organization' ? (
                      <td>
                        {leave.employee.firstName} {leave.employee.lastName}
                      </td>
                    ) : null}
                    <td>
                      <span className="badge">{leave.leaveType.code}</span>
                    </td>
                    <td className="muted nums">{leave.startDate}</td>
                    <td className="muted nums">{leave.endDate}</td>
                    <td className="nums">{leave.days}</td>
                    <td>
                      <span className={STATUS_TONE[leave.status] ?? 'badge'}>
                        {leave.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="muted">{leave.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
        Signed in as {session.user.name} · {session.roles.join(', ') || 'no role'}
      </p>
    </div>
  );
}
