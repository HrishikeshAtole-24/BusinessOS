import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { EmployeeSummary } from '@businessos/contracts';
import { apiFetchOrNull } from '../../../../lib/api';
import { requireSession } from '../../../../lib/session';

export const metadata = { title: 'Employee — BusinessOS' };

interface EmployeeDetail extends EmployeeSummary {
  personalEmail: string | null;
  phone: string | null;
  exitedOn: string | null;
  version: number;
  account: { id: string; email: string; lastLoginAt: string | null } | null;
  reports: Array<{ id: string; firstName: string; lastName: string; designation: string }>;
  /** Nearest manager first, produced by walking `managerId` to the root. */
  reportingChain: Array<{
    id: string;
    firstName: string;
    lastName: string;
    designation: string;
  }>;
}

interface TeamResponse {
  data: EmployeeSummary[];
  total: number;
}

/**
 * Employee profile.
 *
 * The reporting chain and the team are the visible output of the tree
 * algorithms in `@businessos/domain`: `ancestorsOf` walks up to the root,
 * `descendantsOf` walks down breadth-first.
 */
export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { employeeId } = await params;
  await requireSession();

  const employee = await apiFetchOrNull<EmployeeDetail>(`/v1/employees/${employeeId}`);
  // A 404 from the API means "not found OR not yours" — the tenant boundary
  // deliberately does not distinguish them (Section 32, IDOR).
  if (!employee) notFound();

  const team = await apiFetchOrNull<TeamResponse>(`/v1/employees/${employeeId}/team`);

  return (
    <div className="page">
      <div className="page-header">
        <div className="row" style={{ gap: 'var(--space-4)' }}>
          <span className="avatar avatar-lg" aria-hidden="true">
            {employee.firstName[0]}
            {employee.lastName[0]}
          </span>
          <div>
            <h1 className="page-title">
              {employee.firstName} {employee.lastName}
            </h1>
            <p className="page-subtitle">
              {employee.designation}
              {employee.department ? ` · ${employee.department.name}` : ''}
            </p>
          </div>
        </div>
        <Link className="btn btn-secondary" href="/employees">
          Back to directory
        </Link>
      </div>

      <div className="split">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Details</h2>
            <span className="badge mono">{employee.employeeCode}</span>
          </div>
          <div className="card-body stack">
            <Row label="Work email" value={employee.workEmail} />
            <Row label="Personal email" value={employee.personalEmail ?? '—'} />
            <Row label="Phone" value={employee.phone ?? '—'} />
            <Row label="Employment" value={pretty(employee.employmentType)} />
            <Row label="Work mode" value={pretty(employee.workMode)} />
            <Row label="Location" value={employee.location ?? '—'} />
            <Row label="Joined" value={employee.joinedOn} />
            {employee.exitedOn ? <Row label="Exited" value={employee.exitedOn} /> : null}
            <Row
              label="Account"
              value={
                employee.account
                  ? employee.account.lastLoginAt
                    ? `Linked · last seen ${employee.account.lastLoginAt.slice(0, 10)}`
                    : 'Linked · never signed in'
                  : 'No login yet'
              }
            />
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Reporting line</h2>
          </div>
          <div className="card-body">
            {employee.reportingChain.length === 0 ? (
              <div className="empty">
                <div className="empty-title">Top of the tree</div>
                <p>This person does not report to anyone.</p>
              </div>
            ) : (
              // Rendered as an ordered list because the order carries meaning:
              // it is the path from this person to the root.
              <ol className="chain">
                <li className="chain-item chain-current">
                  <span className="avatar" aria-hidden="true">
                    {employee.firstName[0]}
                    {employee.lastName[0]}
                  </span>
                  <span>
                    <strong>
                      {employee.firstName} {employee.lastName}
                    </strong>
                    <div className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                      {employee.designation}
                    </div>
                  </span>
                </li>
                {employee.reportingChain.map((person) => (
                  <li className="chain-item" key={person.id}>
                    <span className="avatar" aria-hidden="true">
                      {person.firstName[0]}
                      {person.lastName[0]}
                    </span>
                    <span>
                      <Link href={`/employees/${person.id}`}>
                        {person.firstName} {person.lastName}
                      </Link>
                      <div className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                        {person.designation}
                      </div>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Team</h2>
          <span className="badge">
            {employee.reports.length} direct
            {team && team.total > employee.reports.length ? ` · ${team.total} total` : ''}
          </span>
        </div>
        {!team || team.total === 0 ? (
          <div className="card-body">
            <div className="empty">
              <div className="empty-title">No reports</div>
              <p>Nobody reports to this person yet.</p>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Designation</th>
                  <th>Reports to</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {/* Rows arrive breadth-first: direct reports, then theirs. */}
                {team.data.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <Link href={`/employees/${member.id}`}>
                        {member.firstName} {member.lastName}
                      </Link>
                    </td>
                    <td className="muted">{member.designation}</td>
                    <td className="muted">
                      {member.manager
                        ? `${member.manager.firstName} ${member.manager.lastName}`
                        : '—'}
                    </td>
                    <td>
                      <span className="badge">{member.status.toLowerCase().replace('_', ' ')}</span>
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between">
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 'var(--weight-medium)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function pretty(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}
