import { apiFetch } from '../../../lib/api';
import { can, initials, requireSession } from '../../../lib/session';
import { InviteForm } from '../../../components/InviteForm';

export const metadata = { title: 'Members — BusinessOS' };

interface MembersResponse {
  data: Array<{
    id: string;
    status: string;
    joinedAt: string;
    user: { id: string; name: string; email: string; lastLoginAt: string | null };
    roles: Array<{ key: string; name: string }>;
  }>;
}

interface InvitationsResponse {
  data: Array<{
    id: string;
    email: string;
    expiresAt: string;
    expired: boolean;
    role: { key: string; name: string };
    invitedBy: { name: string; email: string };
  }>;
}

interface RolesResponse {
  data: Array<{ key: string; name: string }>;
}

function formatDate(value: string): string {
  // en-GB with an explicit timezone so the server and client agree. Locale
  // formatting that depends on the runtime's default is a classic hydration
  // mismatch: the server is UTC and the browser is not.
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

export default async function MembersPage() {
  const session = await requireSession();

  const members = await apiFetch<MembersResponse>('/v1/organizations/current/members');

  const mayInvite = can(session, 'member.invite');
  const [invitations, roles] = mayInvite
    ? await Promise.all([
        apiFetch<InvitationsResponse>('/v1/invitations'),
        apiFetch<RolesResponse>('/v1/organizations/current/roles'),
      ])
    : [null, null];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Members</h1>
          <p className="page-subtitle">
            {members.data.length} {members.data.length === 1 ? 'person' : 'people'} in{' '}
            {session.organization!.name}
          </p>
        </div>
      </div>

      {mayInvite && roles ? <InviteForm roles={roles.data} /> : null}

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Directory</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Roles</th>
                <th>Status</th>
                <th>Joined</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {members.data.map((member) => (
                <tr key={member.id}>
                  <td>
                    <span className="row">
                      <span className="avatar" aria-hidden="true">
                        {initials(member.user.name)}
                      </span>
                      <span>
                        <div style={{ fontWeight: 'var(--weight-medium)' }}>
                          {member.user.name}
                          {member.user.id === session.user.id ? (
                            <span className="badge" style={{ marginLeft: 'var(--space-2)' }}>
                              you
                            </span>
                          ) : null}
                        </div>
                        <div className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                          {member.user.email}
                        </div>
                      </span>
                    </span>
                  </td>
                  <td>
                    <span style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                      {member.roles.map((role) => (
                        <span className="badge badge-accent" key={role.key}>
                          {role.name}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>
                    {/* Colour plus text, never colour alone (Section 24.3). */}
                    <span className="row" style={{ gap: 'var(--space-2)' }}>
                      <span
                        className={member.status === 'ACTIVE' ? 'dot dot-ok' : 'dot dot-warn'}
                        aria-hidden="true"
                      />
                      <span className="muted">{member.status.toLowerCase()}</span>
                    </span>
                  </td>
                  <td className="muted">{formatDate(member.joinedAt)}</td>
                  <td className="muted">
                    {member.user.lastLoginAt ? formatDate(member.user.lastLoginAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {invitations ? (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Pending invitations</h2>
            <span className="badge">{invitations.data.length}</span>
          </div>

          {invitations.data.length === 0 ? (
            <div className="card-body">
              <div className="empty">
                <div className="empty-title">No pending invitations</div>
                <p>Invite someone above and they will appear here until they accept.</p>
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Invited by</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.data.map((invitation) => (
                    <tr key={invitation.id}>
                      <td>{invitation.email}</td>
                      <td>
                        <span className="badge badge-accent">{invitation.role.name}</span>
                      </td>
                      <td className="muted">{invitation.invitedBy.name}</td>
                      <td>
                        {invitation.expired ? (
                          <span className="badge badge-danger">expired</span>
                        ) : (
                          <span className="muted">{formatDate(invitation.expiresAt)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
