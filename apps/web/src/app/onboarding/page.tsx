import { redirect } from 'next/navigation';
import { getSession } from '../../lib/session';
import { CreateOrganizationForm } from '../../components/CreateOrganizationForm';

export const metadata = { title: 'Create an organization — BusinessOS' };

/**
 * Where a signed-in user with no active organization lands.
 *
 * Reachable when someone signs up without naming a company, or belongs to
 * several organizations and has not picked one yet.
 */
export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.organization) redirect('/dashboard');

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="sidebar-mark" aria-hidden="true">
            B
          </span>
          BusinessOS
        </div>

        <CreateOrganizationForm memberships={session.memberships} />
      </div>
    </main>
  );
}
