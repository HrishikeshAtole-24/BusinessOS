import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { TaskStatus } from '@businessos/contracts';
import { apiFetch, apiFetchOrNull } from '../../../../lib/api';
import { requireSession } from '../../../../lib/session';

export const metadata = { title: 'Project — BusinessOS' };

interface ProjectDetail {
  id: string;
  name: string;
  key: string;
  description: string | null;
  status: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  budgetAmount: string | null;
  budgetCurrency: string | null;
  version: number;
  owner: { id: string; firstName: string; lastName: string } | null;
  members: Array<{
    role: string;
    employee: { id: string; firstName: string; lastName: string; designation: string };
  }>;
  _count: { tasks: number };
  allowedTransitions: string[];
}

interface TasksResponse {
  data: Array<{
    id: string;
    key: string;
    title: string;
    status: TaskStatus;
    priority: string;
    dueDate: string | null;
    estimateHours: number | null;
    assignee: { id: string; firstName: string; lastName: string } | null;
    blockedByCount: number;
    blocksCount: number;
  }>;
}

interface ScheduleResponse {
  order: string[] | null;
  cyclic: string[];
  criticalPath: string[];
  criticalPathHours: number;
  ready: string[];
  blocked: Array<{ taskId: string; waitingOn: string[] }>;
  tasks: Record<string, { key: string; status: string }>;
}

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: 'TODO', label: 'To do' },
  { status: 'IN_PROGRESS', label: 'In progress' },
  { status: 'BLOCKED', label: 'Blocked' },
  { status: 'IN_REVIEW', label: 'In review' },
  { status: 'DONE', label: 'Done' },
];

/**
 * Project board.
 *
 * The Schedule panel is the visible output of the graph algorithms: Kahn's
 * topological order, the critical path, and which tasks are ready versus
 * waiting. Section 26.2 asks to be able to explain not just the algorithm but
 * why the product needed it — this panel is that answer.
 */
export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireSession();

  const project = await apiFetchOrNull<ProjectDetail>(`/v1/projects/${projectId}`);
  if (!project) notFound();

  const [tasks, schedule] = await Promise.all([
    apiFetch<TasksResponse>(`/v1/tasks?projectId=${projectId}&limit=100`),
    apiFetchOrNull<ScheduleResponse>(`/v1/projects/${projectId}/schedule`),
  ]);

  const readySet = new Set(schedule?.ready ?? []);
  const criticalSet = new Set(schedule?.criticalPath ?? []);
  const waitingOn = new Map((schedule?.blocked ?? []).map((b) => [b.taskId, b.waitingOn]));
  const keyOf = (id: string) => schedule?.tasks[id]?.key ?? '?';

  const done = tasks.data.filter((t) => t.status === 'DONE').length;
  const progress = tasks.data.length === 0 ? 0 : Math.round((done / tasks.data.length) * 100);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="row" style={{ marginBottom: 'var(--space-1)' }}>
            <span className="badge mono">{project.key}</span>
            <span className="badge">{project.status.toLowerCase().replace('_', ' ')}</span>
          </div>
          <h1 className="page-title">{project.name}</h1>
          {project.description ? <p className="page-subtitle">{project.description}</p> : null}
        </div>
        <Link className="btn btn-secondary" href="/projects">
          All projects
        </Link>
      </div>

      <div className="stat-grid">
        <Stat
          label="Tasks"
          value={String(tasks.data.length)}
          meta={`${done} done · ${progress}%`}
        />
        <Stat
          label="Critical path"
          value={`${schedule?.criticalPathHours ?? 0}h`}
          meta={`${schedule?.criticalPath.length ?? 0} tasks set the end date`}
        />
        <Stat
          label="Ready to start"
          value={String(schedule?.ready.length ?? 0)}
          meta="nothing blocking these"
        />
        <Stat
          label="Waiting"
          value={String(schedule?.blocked.length ?? 0)}
          meta="blocked by a dependency"
        />
      </div>

      {/* A cycle should be impossible — the API refuses to create one — so if
          this ever renders, the stored graph is corrupt and needs a human. */}
      {schedule && schedule.cyclic.length > 0 ? (
        <div className="alert alert-danger" role="alert">
          <div>
            <strong>The dependency graph contains a cycle.</strong>
            <div style={{ fontSize: 'var(--text-sm)' }}>
              Affected: {schedule.cyclic.map(keyOf).join(', ')}. The project cannot be scheduled
              until this is broken.
            </div>
          </div>
        </div>
      ) : null}

      <div className="split">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Critical path</h2>
            <span className="badge badge-warning">{schedule?.criticalPathHours ?? 0}h</span>
          </div>
          <div className="card-body">
            {!schedule || schedule.criticalPath.length === 0 ? (
              <div className="empty">
                <div className="empty-title">No critical path</div>
                <p>Add task dependencies and estimates to compute one.</p>
              </div>
            ) : (
              <>
                <p
                  className="muted"
                  style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}
                >
                  The longest dependency chain. Shortening any task <em>not</em> on it changes
                  nothing; any slip here slips the whole project.
                </p>
                <ol className="chain">
                  {schedule.criticalPath.map((id) => {
                    const task = tasks.data.find((t) => t.id === id);
                    return (
                      <li className="chain-item chain-current" key={id}>
                        <span className="badge mono">{keyOf(id)}</span>
                        <span>
                          <Link href={`/tasks/${id}`}>{task?.title ?? keyOf(id)}</Link>
                          <div className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                            {task?.estimateHours ?? 0}h · {task?.status.toLowerCase()}
                          </div>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Execution order</h2>
            <span className="badge">Kahn&apos;s topological sort</span>
          </div>
          <div className="card-body">
            {!schedule?.order ? (
              <div className="empty">
                <div className="empty-title">Cannot order</div>
                <p>The dependency graph is cyclic.</p>
              </div>
            ) : (
              <>
                <p
                  className="muted"
                  style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}
                >
                  A valid sequence honouring every dependency. Tasks marked ready have no incomplete
                  predecessors.
                </p>
                <ol className="order-list">
                  {schedule.order.map((id, index) => (
                    <li key={id} className="order-item">
                      <span className="order-index nums">{index + 1}</span>
                      <span className="badge mono">{keyOf(id)}</span>
                      <span className="order-title">
                        {tasks.data.find((t) => t.id === id)?.title ?? ''}
                      </span>
                      {readySet.has(id) ? <span className="badge badge-success">ready</span> : null}
                      {criticalSet.has(id) ? (
                        <span className="badge badge-warning">critical</span>
                      ) : null}
                      {waitingOn.has(id) ? (
                        <span className="badge" title="Waiting on incomplete predecessors">
                          waits on {waitingOn.get(id)!.map(keyOf).join(', ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Board</h2>
          <span className="badge">{tasks.data.length} tasks</span>
        </div>
        <div className="card-body">
          <div className="board">
            {COLUMNS.map((column) => {
              const columnTasks = tasks.data.filter((t) => t.status === column.status);
              return (
                <div className="board-column" key={column.status}>
                  <div className="board-heading">
                    {column.label}
                    <span className="badge">{columnTasks.length}</span>
                  </div>
                  {columnTasks.length === 0 ? (
                    <p
                      className="subtle"
                      style={{ fontSize: 'var(--text-sm)', padding: 'var(--space-2)' }}
                    >
                      Nothing here
                    </p>
                  ) : (
                    columnTasks.map((task) => (
                      <article className="board-card" key={task.id}>
                        <div className="row-between">
                          <span className="badge mono">{task.key}</span>
                          {criticalSet.has(task.id) ? (
                            <span className="badge badge-warning">critical</span>
                          ) : null}
                        </div>
                        <Link href={`/tasks/${task.id}`} className="board-card-title">
                          {task.title}
                        </Link>
                        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-1)' }}>
                          {task.estimateHours ? (
                            <span className="badge nums">{task.estimateHours}h</span>
                          ) : null}
                          {task.blockedByCount > 0 ? (
                            <span className="badge">↑{task.blockedByCount}</span>
                          ) : null}
                          {task.blocksCount > 0 ? (
                            <span className="badge">↓{task.blocksCount}</span>
                          ) : null}
                          {task.assignee ? (
                            <span className="badge">
                              {task.assignee.firstName} {task.assignee.lastName[0]}.
                            </span>
                          ) : null}
                        </div>
                      </article>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value nums">{value}</div>
      <div className="stat-meta">{meta}</div>
    </div>
  );
}
