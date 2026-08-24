import Link from 'next/link';
import type { EmployeeSummary } from '@businessos/contracts';
import { apiFetch } from '../../../lib/api';
import { can, requireSession } from '../../../lib/session';
import { EmployeeFilters } from '../../../components/EmployeeFilters';

export const metadata = { title: 'Employees — BusinessOS' };

interface EmployeesResponse {
  data: EmployeeSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface DepartmentsResponse {
  data: Array<{ id: string; name: string; code: string; children: unknown[] }>;
  total: number;
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'badge badge-success',
  ON_LEAVE: 'badge badge-warning',
  ON_NOTICE: 'badge badge-warning',
  EXITED: 'badge badge-danger',
};

/**
 * Employee directory.
 *
 * Filters and the cursor live in the URL rather than component state
 * (Section 24.2: "URL state for filters, sorting and pagination"). That makes a
 * filtered view shareable, survivable across a refresh, and correct with the
 * browser back button — none of which `useState` gives you.
 */
export default async function EmployeesPage(props: PageProps<'/employees'>) {
  const session = await requireSession();
  const params = await props.searchParams;

  const query = new URLSearchParams();
  const q = typeof params['q'] === 'string' ? params['q'] : '';
  const departmentId = typeof params['departmentId'] === 'string' ? params['departmentId'] : '';
  const status = typeof params['status'] === 'string' ? params['status'] : '';
  const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : '';

  if (q) query.set('q', q);
  if (departmentId) query.set('departmentId', departmentId);
  if (status) query.set('status', status);
  if (cursor) query.set('cursor', cursor);
  query.set('limit', '25');

  const [employees, departments] = await Promise.all([
    apiFetch<EmployeesResponse>(`/v1/employees?${query.toString()}`),
    apiFetch<DepartmentsResponse>('/v1/departments'),
  ]);

  // The tree is nested; the filter dropdown wants a flat list.
  const flatDepartments = flatten(departments.data);

  const nextHref = employees.nextCursor
    ? `/employees?${new URLSearchParams({
        ...(q ? { q } : {}),
        ...(departmentId ? { departmentId } : {}),
        ...(status ? { status } : {}),
        cursor: employees.nextCursor,
      }).toString()}`
    : null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Employees</h1>
          <p className="page-subtitle">
            {session.organization!.name} · {departments.total} department
            {departments.total === 1 ? '' : 's'}
          </p>
        </div>
        {can(session, 'employee.create') ? (
          <Link className="btn btn-primary" href="/employees/new">
            Add employee
          </Link>
        ) : null}
      </div>

      <EmployeeFilters departments={flatDepartments} initial={{ q, departmentId, status }} />

      <section className="card">
        {employees.data.length === 0 ? (
          <div className="card-body">
            <div className="empty">
              <div className="empty-title">No employees match</div>
              <p>
                {q || departmentId || status
                  ? 'Try clearing the filters.'
                  : 'Add the first employee to get started.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Designation</th>
                  <th>Department</th>
                  <th>Reports to</th>
                  <th>Status</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {employees.data.map((employee) => (
                  <tr key={employee.id}>
                    <td>
                      <Link href={`/employees/${employee.id}`} className="row">
                        <span className="avatar" aria-hidden="true">
                          {employee.firstName[0]}
                          {employee.lastName[0]}
                        </span>
                        <span>
                          <div style={{ fontWeight: 'var(--weight-medium)' }}>
                            {employee.firstName} {employee.lastName}
                          </div>
                          <div className="subtle mono" style={{ fontSize: 'var(--text-sm)' }}>
                            {employee.employeeCode}
                          </div>
                        </span>
                      </Link>
                    </td>
                    <td>{employee.designation}</td>
                    <td className="muted">
                      {employee.department ? employee.department.name : '—'}
                    </td>
                    <td className="muted">
                      {employee.manager
                        ? `${employee.manager.firstName} ${employee.manager.lastName}`
                        : '—'}
                    </td>
                    <td>
                      <span className={STATUS_TONE[employee.status] ?? 'badge'}>
                        {employee.status.toLowerCase().replace('_', ' ')}
                      </span>
                    </td>
                    <td className="muted nums">{employee.joinedOn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Keyset pagination: a "next" link carrying the cursor, not a page
            number. There is no total page count because computing one would
            need a COUNT(*) over the whole matching set on every request. */}
        {nextHref ? (
          <div className="card-body row-between">
            <span className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
              Showing {employees.data.length}
            </span>
            <Link className="btn btn-secondary btn-sm" href={nextHref}>
              Next page
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  );
}

interface FlatDepartment {
  id: string;
  name: string;
  code: string;
}

function flatten(nodes: DepartmentsResponse['data']): FlatDepartment[] {
  const out: FlatDepartment[] = [];
  function visit(list: DepartmentsResponse['data']): void {
    for (const node of list) {
      out.push({ id: node.id, name: node.name, code: node.code });
      visit(node.children as DepartmentsResponse['data']);
    }
  }
  visit(nodes);
  return out;
}
