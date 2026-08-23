import Link from 'next/link';
import { apiFetchOrNull } from '../../../lib/api';
import { can, initials, requireSession } from '../../../lib/session';

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
  data: Array<{
    key: string;
    name: string;
    description: string | null;
    permissionCount: number;
    memberCount: number;
  }>;
}

interface InvitationsResponse {
  data: Array<{ id: string; email: string; expired: boolean }>;
}

/**
 * Overview.
 *
 * A Server Component that reads through the API (Section 24.1), never the
 * database directly, so authorization lives in exactly one place.
 *
 * Deliberately NOT a dump of the caller's 46 permission strings. That was a
 * developer's view of the data model rather than something a person running a
 * company would open. What belongs here is the state of the organization and
 * the next useful action; the permission model shows itself through which
 * panels appear at all.
 */
export default async function DashboardPage() {
  const session = await requireSession();

  // Parallel, and each tolerates a 4xx: a role without `member.read` gets a
  // 403 for that call, which is an expected outcome to render around rather
  // than an error that should blank the page.
  const [members, roles, invitations] = await Promise.all([
    can(session, 'member.read')
      ? apiFetchOrNull<MembersResponse>('/v1/organizations/current/members')
      : null,
    can(session, 'role.read')
      ? apiFetchOrNull<RolesResponse>('/v1/organizations/current/roles')
      : null,
    can(session, 'member.invite') ? apiFetchOrNull<InvitationsResponse>('/v1/invitations') : null,
  ]);

  const activeMembers = members?.data.filter((m) => m.status === 'ACTIVE') ?? [];
  const pendingInvites = invitations?.data.filter((i) => !i.expired) ?? [];
  const neverSignedIn = activeMembers.filter((m) => !m.user.lastLoginAt).length;

  const recentJoins = [...activeMembers]
    .sort((a, b) => new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime())
    .slice(0, 5);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {greeting()}, {session.user.name.split(' ')[0]}
          </h1>
          <p className="page-subtitle">Here is where {session.organization!.name} stands today.</p>
        </div>
        {can(session, 'member.invite') ? (
          <Link className="btn btn-primary" href="/members">
            Invite someone
          </Link>
        ) : null}
      </div>

      <div className="stat-grid">
        {members ? (
          <Stat
            label="Team"
            value={activeMembers.length}
            meta={activeMembers.length === 1 ? 'active member' : 'active members'}
          />
        ) : null}

        {invitations ? (
          <Stat
            label="Pending invites"
            value={pendingInvites.length}
            meta={pendingInvites.length === 0 ? 'nobody waiting' : 'awaiting acceptance'}
          />
        ) : null}

        {members ? (
          <Stat
            label="Never signed in"
            value={neverSignedIn}
            meta={neverSignedIn === 0 ? 'everyone is onboarded' : 'may need a nudge'}
            tone={neverSignedIn > 0 ? 'warn' : 'ok'}
          />
        ) : null}

        {roles ? <Stat label="Roles" value={roles.data.length} meta="configured" /> : null}
      </div>

      <div className="split">
        {members ? (
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Recently joined</h2>
              <Link className="btn btn-ghost btn-sm" href="/members">
                View all
              </Link>
            </div>
            {recentJoins.length === 0 ? (
              <div className="card-body">
                <div className="empty">
                  <div className="empty-title">Nobody here yet</div>
                  <p>Invite your first colleague to get started.</p>
                </div>
              </div>
            ) : (
              <div className="card-body stack">
                {recentJoins.map((member) => (
                  <div className="row-between" key={member.id}>
                    <span className="row">
                      <span className="avatar" aria-hidden="true">
                        {initials(member.user.name)}
                      </span>
                      <span>
                        <div style={{ fontWeight: 'var(--weight-medium)' }}>{member.user.name}</div>
                        <div className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                          {member.roles.map((r) => r.name).join(', ') || 'no role'}
                        </div>
                      </span>
                    </span>
                    <span className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                      {relativeDate(member.joinedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Your access</h2>
            <span className="badge badge-accent">{session.roles.join(', ') || 'no role'}</span>
          </div>
          <div className="card-body stack">
            <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
              You hold <strong>{session.permissions.length}</strong> of 46 permissions in{' '}
              {session.organization!.name}. Navigation dims whatever your role cannot reach.
            </p>
            <AccessMeter held={session.permissions.length} total={46} />
            <div className="stack-sm" style={{ display: 'flex', flexDirection: 'column' }}>
              <Capability label="Manage people" granted={can(session, 'member.invite')} />
              <Capability label="Configure roles" granted={can(session, 'role.manage')} />
              <Capability label="Approve requests" granted={can(session, 'approval.act')} />
              <Capability label="View audit trail" granted={can(session, 'audit.read')} />
              <Capability label="Edit organization" granted={can(session, 'organization.update')} />
            </div>
          </div>
        </section>
      </div>

      {roles ? (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Roles</h2>
            <Link className="btn btn-ghost btn-sm" href="/settings">
              Settings
            </Link>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Description</th>
                  <th>Permissions</th>
                  <th>Members</th>
                </tr>
              </thead>
              <tbody>
                {roles.data.map((role) => (
                  <tr key={role.key}>
                    <td style={{ fontWeight: 'var(--weight-medium)' }}>{role.name}</td>
                    <td className="muted">{role.description ?? '—'}</td>
                    <td className="nums">{role.permissionCount}</td>
                    <td className="nums">{role.memberCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function greeting(): string {
  // Computed on the server from the seeded organization's timezone. Using the
  // viewer's local hour would produce a hydration mismatch, because the server
  // and the browser sit in different timezones.
  const hour = (new Date().getUTCHours() + 5.5) % 24;
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function relativeDate(value: string): string {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

function Stat({
  label,
  value,
  meta,
  tone,
}: {
  label: string;
  value: number;
  meta: string;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value nums">{value}</div>
      <div className="stat-meta">
        {tone ? (
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            <span className={tone === 'warn' ? 'dot dot-warn' : 'dot dot-ok'} aria-hidden="true" />
            {meta}
          </span>
        ) : (
          meta
        )}
      </div>
    </div>
  );
}

/** Proportion of the catalogue this role holds. */
function AccessMeter({ held, total }: { held: number; total: number }) {
  const percent = Math.round((held / total) * 100);
  return (
    <div
      className="meter"
      role="meter"
      aria-valuenow={held}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${held} of ${total} permissions`}
    >
      <span className="meter-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Yes/no capability line. Text carries the state, not icon colour alone. */
function Capability({ label, granted }: { label: string; granted: boolean }) {
  return (
    <div className="row-between">
      <span className={granted ? undefined : 'subtle'}>{label}</span>
      <span className={granted ? 'badge badge-success' : 'badge'}>
        {granted ? 'allowed' : 'not allowed'}
      </span>
    </div>
  );
}
