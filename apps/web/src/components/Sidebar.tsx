'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Primary navigation.
 *
 * A Client Component only because it needs `usePathname()` to mark the current
 * route. Everything else about it is static.
 *
 * Navigation is permission-aware: a link whose permission the current role does
 * not hold renders inert rather than disappearing. Hiding it entirely makes the
 * product feel smaller than it is and leaves people unsure whether a feature
 * exists; showing it dimmed answers "you cannot do this here" honestly.
 *
 * This is presentation, not security. Every route behind these links is guarded
 * by the API, which is the only thing an attacker cannot skip.
 */

interface NavItem {
  href: string;
  label: string;
  /** Permission required to use this link. Omitted means always available. */
  permission?: string;
  /** Not built yet — rendered inert with a "Soon" marker. */
  planned?: boolean;
}

interface NavGroup {
  heading: string | null;
  items: NavItem[];
}

const NAVIGATION: NavGroup[] = [
  {
    heading: null,
    items: [{ href: '/dashboard', label: 'Overview' }],
  },
  {
    heading: 'People',
    items: [
      { href: '/members', label: 'Members', permission: 'member.read' },
      { href: '/employees', label: 'Employees', permission: 'employee.read' },
      { href: '/departments', label: 'Departments', permission: 'department.read' },
      {
        href: '/attendance',
        label: 'Attendance',
        permission: 'attendance.read_self',
        planned: true,
      },
      { href: '/leave', label: 'Leave', permission: 'leave.read_self', planned: true },
    ],
  },
  {
    heading: 'Work',
    items: [
      { href: '/projects', label: 'Projects', permission: 'project.read', planned: true },
      { href: '/tasks', label: 'Tasks', permission: 'task.read', planned: true },
      {
        href: '/timesheets',
        label: 'Timesheets',
        permission: 'timesheet.read_self',
        planned: true,
      },
    ],
  },
  {
    heading: 'Finance',
    items: [
      { href: '/expenses', label: 'Expenses', permission: 'expense.read_self', planned: true },
      { href: '/approvals', label: 'Approvals', permission: 'approval.read', planned: true },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { href: '/audit', label: 'Audit log', permission: 'audit.read', planned: true },
      { href: '/analytics', label: 'Analytics', permission: 'analytics.read', planned: true },
    ],
  },
];

interface SidebarProps {
  permissions: string[];
}

export function Sidebar({ permissions }: SidebarProps) {
  const pathname = usePathname();
  // A Set, because this is checked once per link on every render.
  const granted = new Set(permissions);

  return (
    <aside className="sidebar">
      <Link className="sidebar-brand" href="/dashboard">
        <span className="sidebar-mark" aria-hidden="true">
          B
        </span>
        BusinessOS
      </Link>

      {/* aria-label distinguishes this landmark from any other nav on the page. */}
      <nav className="sidebar-nav" aria-label="Main">
        {NAVIGATION.map((group) => (
          <div className="nav-group" key={group.heading ?? 'root'}>
            {group.heading ? <div className="nav-heading">{group.heading}</div> : null}

            {group.items.map((item) => {
              const allowed = !item.permission || granted.has(item.permission);
              const locked = !allowed || item.planned;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

              if (locked) {
                return (
                  <span
                    className="nav-link"
                    key={item.href}
                    data-locked="true"
                    aria-disabled="true"
                    title={!allowed ? 'Your role does not have access to this' : 'Not built yet'}
                  >
                    {item.label}
                    {item.planned && allowed ? <span className="badge">Soon</span> : null}
                  </span>
                );
              }

              return (
                <Link
                  className="nav-link"
                  key={item.href}
                  href={item.href}
                  // aria-current is what a screen reader announces as "current
                  // page"; the stylesheet keys off the same attribute, so the
                  // visual and the accessibility tree cannot drift apart.
                  aria-current={active ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <Link
          className="nav-link"
          href="/settings"
          aria-current={pathname === '/settings' ? 'page' : undefined}
        >
          Settings
        </Link>
      </div>
    </aside>
  );
}
