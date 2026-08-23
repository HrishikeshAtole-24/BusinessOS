import { Sidebar } from '../../components/Sidebar';
import { Topbar } from '../../components/Topbar';
import { initials, requireSession } from '../../lib/session';

/**
 * Authenticated application shell.
 *
 * A Server Component: it resolves the session once and passes only what each
 * child needs. Permissions reach the sidebar as a plain string array rather
 * than a client-side fetch, so navigation is correct on first paint with no
 * flash of the wrong menu.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="shell">
      {/* First tab stop, so keyboard users can skip the navigation. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <Sidebar permissions={session.permissions} />

      <Topbar
        organization={session.organization!}
        memberships={session.memberships}
        user={session.user}
        initials={initials(session.user.name)}
        roles={session.roles}
      />

      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}
