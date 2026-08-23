import { Sidebar } from '../../components/Sidebar';
import { UserMenu } from '../../components/UserMenu';
import { initials, requireSession } from '../../lib/session';

/**
 * Authenticated application shell.
 *
 * A Server Component: it resolves the session once and passes only what each
 * child needs. The permission list reaches the sidebar as a plain array of
 * strings rather than a client-side fetch, so navigation renders correctly on
 * the first paint with no flash of the wrong menu.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="shell">
      {/* First tab stop, so keyboard users can skip the navigation. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <Sidebar permissions={session.permissions} organizationName={session.organization!.name} />

      <header className="topbar">
        <span className="org-chip">
          <span className="dot dot-ok" aria-hidden="true" />
          {session.organization!.name}
        </span>

        <div className="topbar-actions">
          <UserMenu
            name={session.user.name}
            email={session.user.email}
            initials={initials(session.user.name)}
            roles={session.roles}
          />
        </div>
      </header>

      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}
