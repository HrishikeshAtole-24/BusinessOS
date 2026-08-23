import { apiFetch } from '../../../lib/api';
import { can, requireSession } from '../../../lib/session';
import { OrganizationSettingsForm } from '../../../components/OrganizationSettingsForm';

export const metadata = { title: 'Settings — BusinessOS' };

interface CurrentOrganization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  status: string;
  version: number;
  createdAt: string;
}

export default async function SettingsPage() {
  const session = await requireSession();
  const organization = await apiFetch<CurrentOrganization>('/v1/organizations/current');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Organization profile and preferences</p>
        </div>
      </div>

      {can(session, 'organization.update') ? (
        <OrganizationSettingsForm organization={organization} />
      ) : (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Organization</h2>
            <span className="badge">read only</span>
          </div>
          <div className="card-body stack">
            <ReadOnlyRow label="Name" value={organization.name} />
            <ReadOnlyRow label="URL name" value={organization.slug} />
            <ReadOnlyRow label="Timezone" value={organization.timezone} />
            <ReadOnlyRow label="Currency" value={organization.currency} />
            <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
              Editing needs <code>organization.update</code>, which your role does not hold.
            </p>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Your session</h2>
        </div>
        <div className="card-body stack">
          <ReadOnlyRow
            label="Signed in as"
            value={`${session.user.name} (${session.user.email})`}
          />
          <ReadOnlyRow label="Roles" value={session.roles.join(', ') || 'none'} />
          <ReadOnlyRow label="Permissions" value={`${session.permissions.length} of 46`} />
          <ReadOnlyRow
            label="Organizations"
            value={session.memberships.map((m) => m.name).join(', ')}
          />
        </div>
      </section>
    </div>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between">
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 'var(--weight-medium)' }}>{value}</span>
    </div>
  );
}
