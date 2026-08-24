import { apiFetch } from '../../../lib/api';
import { can, requireSession } from '../../../lib/session';
import { ExpenseForm } from '../../../components/ExpenseForm';
import { ExpenseActions } from '../../../components/ExpenseActions';

export const metadata = { title: 'Expenses — BusinessOS' };

interface ExpensesResponse {
  data: Array<{
    id: string;
    amount: string;
    currency: string;
    spentOn: string;
    description: string;
    status: string;
    receiptKey: string | null;
    version: number;
    employee: { id: string; firstName: string; lastName: string };
    category: { id: string; name: string; code: string };
    project: { id: string; key: string; name: string } | null;
  }>;
  scope: 'self' | 'organization';
}

interface CategoriesResponse {
  data: Array<{ id: string; name: string; code: string; receiptRequiredAbove: string | null }>;
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'badge',
  SUBMITTED: 'badge badge-warning',
  APPROVED: 'badge badge-accent',
  REJECTED: 'badge badge-danger',
  REIMBURSED: 'badge badge-success',
};

export default async function ExpensesPage() {
  const session = await requireSession();
  const [expenses, categories] = await Promise.all([
    apiFetch<ExpensesResponse>('/v1/expenses?limit=50'),
    apiFetch<CategoriesResponse>('/v1/expense-categories'),
  ]);

  // Totals over decimal STRINGS. Section 28.2 keeps money out of JS numbers on
  // the wire; summing in paise (integers) avoids float drift in the display.
  const totals = expenses.data.reduce<Record<string, number>>((acc, e) => {
    if (e.status === 'REJECTED') return acc;
    acc[e.status] = (acc[e.status] ?? 0) + Math.round(Number(e.amount) * 100);
    return acc;
  }, {});
  const rupees = (paise: number) => (paise / 100).toLocaleString('en-IN');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Expenses</h1>
          <p className="page-subtitle">
            {expenses.scope === 'organization' ? 'All claims in the organization' : 'Your claims'}
          </p>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Awaiting approval" value={rupees(totals['SUBMITTED'] ?? 0)} meta="submitted" />
        <Stat label="Approved" value={rupees(totals['APPROVED'] ?? 0)} meta="ready to pay" />
        <Stat label="Reimbursed" value={rupees(totals['REIMBURSED'] ?? 0)} meta="paid out" />
        <Stat label="Claims" value={String(expenses.data.length)} meta="in this view" />
      </div>

      {can(session, 'expense.create') ? <ExpenseForm categories={categories.data} /> : null}

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Claims</h2>
        </div>
        {expenses.data.length === 0 ? (
          <div className="card-body">
            <div className="empty">
              <div className="empty-title">No claims yet</div>
              <p>File one above and it will route through the approval policy.</p>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {expenses.scope === 'organization' ? <th>Who</th> : null}
                  <th>Description</th>
                  <th>Category</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {expenses.data.map((expense) => (
                  <tr key={expense.id}>
                    {expenses.scope === 'organization' ? (
                      <td>
                        {expense.employee.firstName} {expense.employee.lastName}
                      </td>
                    ) : null}
                    <td>
                      {expense.description}
                      {expense.receiptKey ? (
                        <span className="badge" style={{ marginLeft: 'var(--space-2)' }}>
                          receipt
                        </span>
                      ) : null}
                    </td>
                    <td className="muted">{expense.category.name}</td>
                    <td className="muted nums">{expense.spentOn}</td>
                    <td className="nums">
                      {expense.currency} {expense.amount}
                    </td>
                    <td>
                      <span className={STATUS_TONE[expense.status] ?? 'badge'}>
                        {expense.status.toLowerCase()}
                      </span>
                    </td>
                    <td>
                      <ExpenseActions
                        expenseId={expense.id}
                        status={expense.status}
                        canReimburse={can(session, 'expense.reimburse')}
                        isMine={expense.employee.id !== undefined}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value nums">{value}</div>
      <div className="stat-meta">{meta}</div>
    </div>
  );
}
