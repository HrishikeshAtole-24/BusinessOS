'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Directory filters.
 *
 * Writes to the URL, not to local state (Section 24.2). The page is a Server
 * Component that reads `searchParams`, so pushing a new query string is what
 * re-runs the query — and it makes a filtered view shareable and
 * back-button-correct for free.
 */

interface Department {
  id: string;
  name: string;
  code: string;
}

const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'ON_NOTICE', label: 'On notice' },
  { value: 'EXITED', label: 'Exited' },
];

export function EmployeeFilters({
  departments,
  initial,
}: {
  departments: Department[];
  initial: { q: string; departmentId: string; status: string };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(initial.q);

  // Debounce the text field so typing does not fire a request per keystroke.
  // Selects apply immediately: one deliberate click deserves one request.
  useEffect(() => {
    if (q === initial.q) return;
    const timer = setTimeout(() => apply({ q }), 350);
    return () => clearTimeout(timer);
    // Intentionally keyed on `q` alone: including `apply` or `initial.q` would
    // re-fire the debounce on every render and defeat the point of debouncing.
  }, [q]);

  function apply(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // Any filter change invalidates the cursor: it points into the old result
    // set, and reusing it would silently start mid-way through a different list.
    next.delete('cursor');
    router.push(`/employees?${next.toString()}`);
  }

  const hasFilters = Boolean(initial.q || initial.departmentId || initial.status);

  return (
    <div className="card">
      <div
        className="card-body"
        style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}
      >
        <div className="field" style={{ flex: '2 1 240px' }}>
          <label className="label" htmlFor="employee-search">
            Search
          </label>
          <input
            id="employee-search"
            className="input"
            type="search"
            value={q}
            placeholder="Name, email, code or designation"
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="field" style={{ flex: '1 1 180px' }}>
          <label className="label" htmlFor="employee-department">
            Department
          </label>
          <select
            id="employee-department"
            className="input"
            value={initial.departmentId}
            onChange={(e) => apply({ departmentId: e.target.value })}
          >
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ flex: '1 1 150px' }}>
          <label className="label" htmlFor="employee-status">
            Status
          </label>
          <select
            id="employee-status"
            className="input"
            value={initial.status}
            onChange={(e) => apply({ status: e.target.value })}
          >
            {STATUSES.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
        </div>

        {hasFilters ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setQ('');
              router.push('/employees');
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
