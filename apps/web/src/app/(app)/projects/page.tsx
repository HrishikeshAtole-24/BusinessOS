import Link from 'next/link';
import type { ProjectSummary } from '@businessos/contracts';
import { apiFetch } from '../../../lib/api';
import { can, requireSession } from '../../../lib/session';

export const metadata = { title: 'Projects — BusinessOS' };

interface ProjectsResponse {
  data: ProjectSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

const STATUS_TONE: Record<string, string> = {
  PLANNING: 'badge',
  ACTIVE: 'badge badge-success',
  ON_HOLD: 'badge badge-warning',
  COMPLETED: 'badge badge-accent',
  CANCELLED: 'badge badge-danger',
};

const PRIORITY_TONE: Record<string, string> = {
  LOW: 'badge',
  MEDIUM: 'badge',
  HIGH: 'badge badge-warning',
  URGENT: 'badge badge-danger',
};

export default async function ProjectsPage() {
  const session = await requireSession();
  const projects = await apiFetch<ProjectsResponse>('/v1/projects?limit=50');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-subtitle">
            {projects.data.length} project{projects.data.length === 1 ? '' : 's'} in{' '}
            {session.organization!.name}
          </p>
        </div>
        {can(session, 'project.create') ? (
          <Link className="btn btn-primary" href="/projects/new">
            New project
          </Link>
        ) : null}
      </div>

      {projects.data.length === 0 ? (
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <div className="empty-title">No projects yet</div>
              <p>Create one to start tracking tasks and dependencies.</p>
            </div>
          </div>
        </section>
      ) : (
        <div className="split">
          {projects.data.map((project) => {
            const progress =
              project.taskCount === 0
                ? 0
                : Math.round((project.doneCount / project.taskCount) * 100);

            return (
              <section className="card" key={project.id}>
                <div className="card-header">
                  <Link href={`/projects/${project.id}`} className="row">
                    <span className="badge mono">{project.key}</span>
                    <span className="card-title">{project.name}</span>
                  </Link>
                  <span className={STATUS_TONE[project.status] ?? 'badge'}>
                    {project.status.toLowerCase().replace('_', ' ')}
                  </span>
                </div>
                <div className="card-body stack">
                  <div className="row-between">
                    <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                      {project.doneCount} of {project.taskCount} tasks done
                    </span>
                    <span className="nums" style={{ fontSize: 'var(--text-sm)' }}>
                      {progress}%
                    </span>
                  </div>
                  <div
                    className="meter"
                    role="meter"
                    aria-valuenow={project.doneCount}
                    aria-valuemin={0}
                    aria-valuemax={project.taskCount}
                    aria-label={`${progress}% complete`}
                  >
                    <span className="meter-fill" style={{ width: `${progress}%` }} />
                  </div>

                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <span className={PRIORITY_TONE[project.priority] ?? 'badge'}>
                      {project.priority.toLowerCase()}
                    </span>
                    <span className="badge">{project.memberCount} members</span>
                    {project.dueDate ? <span className="badge">due {project.dueDate}</span> : null}
                    {project.budgetAmount ? (
                      <span className="badge nums">
                        {project.budgetCurrency} {formatMoney(project.budgetAmount)}
                      </span>
                    ) : null}
                  </div>

                  {project.owner ? (
                    <span className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                      Owner: {project.owner.firstName} {project.owner.lastName}
                    </span>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Format an amount that arrived as a decimal STRING.
 *
 * Section 28.2: money never becomes a JS number. Parsing to float here to add a
 * thousands separator would defeat the point, so the grouping is done on the
 * integer part as text.
 */
function formatMoney(amount: string): string {
  const [whole = '0', fraction] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction && fraction !== '00' ? `${grouped}.${fraction}` : grouped;
}
