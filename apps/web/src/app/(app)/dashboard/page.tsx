import { apiFetchOrNull } from '../../../lib/api';
import { can, requireSession } from '../../../lib/session';

export const metadata = { title: 'Overview — BusinessOS' };

interface MembersResponse {
  data: Array<{
    id: string;
    status: string;
    joinedAt: string;
    user: { id: string; name: string; email: string; lastLoginAt: string | null };
    roles: Array<{ key: string; name: string }>;
  }>;
}

interface RolesResponse {
  data: Array<{ key: string; name: string; permissionCount: number; memberCount: number }>;
}

interface InvitationsResponse {
  data: Array<{ id: string; email: string; expired: boolean }>;
}

/**
 * Overview.
 *
 * A Server Component that fetches through the API (Section 24.1), never
 * directly from the database — the API is the single place authorization lives.
 *
 * Every panel is permission-gated. What renders here is genuinely different for
 * an owner and an employee, which is the point: the RBAC model is visible in
 * the product rather than buried in tests.
 */
export default async function DashboardPage() {
  const session = await requireSession();

  /**
   * Fetched in parallel, and each one tolerates a 4xx.
   *
   * `apiFetchOrNull` matters here: a role without `member.read` gets a 403 for
   * the members call, and that is an expected outcome to render around, not an
   * error that should blank the page. Sequential awaits would also serialise
   * three independent round trips for no reason.
   */
  const [members, roles, invitations] = await Promise.all([
    can(session, 'member.read')
      ? apiFetchOrNull<MembersResponse>('/v1/organizations/current/members')
      : null,
    can(session, 'role.read')
      ? apiFetchOrNull<RolesResponse>('/v1/organizations/current/roles')
      : null,
    can(session, 'member.invite') ? apiFetchOrNull<InvitationsResponse>('/v1/invitations') : null,
  ]);

  const activeMembers = members?.data.filter((m) => m.status === 'ACTIVE').length ?? null;
  const pendingInvites = invitations?.data.filter((i) => !i.expired).length ?? null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Good to see you, {session.user.name.split(' ')[0]}</h1>
          <p className="page-subtitle">
            {session.organization!.name} · signed in as {session.roles.join(', ') || 'no role'}
          </p>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">Your permissions</div>
          <div className="stat-value nums">{session.permissions.length}</div>
          <div className="stat-meta">of 46 in the catalogue</div>
        </div>

        {activeMembers !== null ? (
          <div className="stat">
            <div className="stat-label">Active members</div>
            <div className="stat-value nums">{activeMembers}</div>
            <div className="stat-meta">in this organization</div>
          </div>
        ) : null}

        {roles ? (
          <div className="stat">
            <div className="stat-label">Roles</div>
            <div className="stat-value nums">{roles.data.length}</div>
            <div className="stat-meta">system roles provisioned</div>
          </div>
        ) : null}

        {pendingInvites !== null ? (
          <div className="stat">
            <div className="stat-label">Pending invites</div>
            <div className="stat-value nums">{pendingInvites}</div>
            <div className="stat-meta">awaiting acceptance</div>
          </div>
        ) : null}
      </div>

      {/* The permission list, shown plainly. It makes the authorization model
          inspectable from the UI — sign in as another role and this changes. */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">What you can do here</h2>
          <span className="badge badge-accent">{session.roles.join(', ') || 'no role'}</span>
        </div>
        <div className="card-body">
          <PermissionGrid permissions={session.permissions} />
        </div>
      </section>

      {roles ? (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Roles in this organization</h2>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th>Members</th>
                </tr>
              </thead>
              <tbody>
                {roles.data.map((role) => (
                  <tr key={role.key}>
                    <td>
                      <span className="row" style={{ gap: 'var(--space-2)' }}>
                        <strong>{role.name}</strong>
                        <code className="subtle">{role.key}</code>
                      </span>
                    </td>
                    <td className="nums">{role.permissionCount}</td>
                    <td className="nums">{role.memberCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <div className="empty-title">Roles are not visible to you</div>
              <p>
                Viewing roles needs <code>role.read</code>. Your role does not hold it — which is
                the permission system working, not a bug.
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** Group permissions by module so the list reads as capabilities, not strings. */
function PermissionGrid({ permissions }: { permissions: string[] }) {
  const byModule = new Map<string, string[]>();
  for (const permission of permissions) {
    const [module = 'other', action = permission] = permission.split('.');
    const bucket = byModule.get(module) ?? [];
    bucket.push(action);
    byModule.set(module, bucket);
  }

  const modules = [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 'var(--space-4)',
      }}
    >
      {modules.map(([module, actions]) => (
        <div key={module} className="stack-sm" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontWeight: 'var(--weight-medium)', textTransform: 'capitalize' }}>
            {module}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
            {actions.sort().map((action) => (
              <span className="badge" key={action}>
                {action}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
