import type { DepartmentNode } from '@businessos/contracts';
import { apiFetch } from '../../../lib/api';
import { requireSession } from '../../../lib/session';

export const metadata = { title: 'Departments — BusinessOS' };

interface DepartmentsResponse {
  data: DepartmentNode[];
  total: number;
}

/**
 * Department tree.
 *
 * The API returns it nested, and `depth` comes from traversal rather than being
 * stored — so a re-parent cannot leave a stale depth behind.
 *
 * Rendered as nested <ul>, not a flat list with padding. The nesting is real
 * structure, and a screen reader announces list depth; faking it with margins
 * would look identical and convey nothing.
 */
export default async function DepartmentsPage() {
  const session = await requireSession();
  const departments = await apiFetch<DepartmentsResponse>('/v1/departments');

  const totalHeadcount = sumHeadcount(departments.data);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Departments</h1>
          <p className="page-subtitle">
            {departments.total} department{departments.total === 1 ? '' : 's'} · {totalHeadcount}{' '}
            people · {session.organization!.name}
          </p>
        </div>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Structure</h2>
          <span className="badge">depth {maxDepth(departments.data)}</span>
        </div>
        <div className="card-body">
          {departments.data.length === 0 ? (
            <div className="empty">
              <div className="empty-title">No departments yet</div>
              <p>Departments give employees a place in the organization.</p>
            </div>
          ) : (
            <ul className="tree" role="tree" aria-label="Department hierarchy">
              {departments.data.map((node) => (
                <TreeBranch node={node} key={node.id} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function TreeBranch({ node }: { node: DepartmentNode }) {
  return (
    <li className="tree-item" role="treeitem" aria-expanded={node.children.length > 0}>
      <div className="tree-row">
        <span className="tree-code mono">{node.code}</span>
        <span className="tree-name">{node.name}</span>
        {node.description ? <span className="subtle">{node.description}</span> : null}
        <span className="badge" style={{ marginLeft: 'auto' }}>
          {node.headcount} {node.headcount === 1 ? 'person' : 'people'}
        </span>
      </div>
      {node.children.length > 0 ? (
        <ul role="group">
          {node.children.map((child) => (
            <TreeBranch node={child} key={child.id} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function sumHeadcount(nodes: DepartmentNode[]): number {
  return nodes.reduce((total, node) => total + node.headcount + sumHeadcount(node.children), 0);
}

function maxDepth(nodes: DepartmentNode[], current = 0): number {
  if (nodes.length === 0) return current;
  return Math.max(...nodes.map((n) => maxDepth(n.children, current + 1)));
}
