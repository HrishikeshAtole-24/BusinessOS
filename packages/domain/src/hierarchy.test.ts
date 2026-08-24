import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  buildChildrenMap,
  buildTree,
  descendantsOf,
  flattenTree,
  maxDepth,
  wouldCreateCycle,
  type ParentMap,
} from './hierarchy.js';

/**
 * The cycle tests are the important ones. A cycle in a reporting line is not a
 * cosmetic bug: every traversal over it — the org chart, an approval route
 * walking up to a manager, a permission check on "my reports" — becomes an
 * infinite loop. The database cannot prevent it, so these tests are the
 * guarantee.
 */

/** ceo <- vp <- manager <- engineer, plus a second branch under the VP. */
function orgChart(): ParentMap {
  return new Map<string, string | null>([
    ['ceo', null],
    ['vp-eng', 'ceo'],
    ['vp-sales', 'ceo'],
    ['manager', 'vp-eng'],
    ['engineer', 'manager'],
    ['intern', 'engineer'],
    ['rep', 'vp-sales'],
  ]);
}

describe('ancestorsOf', () => {
  it('walks to the root, nearest first', () => {
    expect(ancestorsOf('intern', orgChart())).toEqual(['engineer', 'manager', 'vp-eng', 'ceo']);
  });

  it('returns nothing for a root', () => {
    expect(ancestorsOf('ceo', orgChart())).toEqual([]);
  });

  it('returns nothing for an unknown node', () => {
    expect(ancestorsOf('ghost', orgChart())).toEqual([]);
  });

  it('terminates on already-corrupt cyclic data instead of hanging', () => {
    // If bad data ever reaches the database, reading it must not wedge a worker.
    const corrupt: ParentMap = new Map([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
    ]);
    const chain = ancestorsOf('a', corrupt);
    expect(chain.length).toBeLessThanOrEqual(3);
    expect(new Set(chain).size).toBe(chain.length);
  });
});

describe('wouldCreateCycle', () => {
  it('rejects a node being its own parent', () => {
    expect(wouldCreateCycle('manager', 'manager', orgChart())).toBe(true);
  });

  it('rejects a direct swap: A reports to B, then B reports to A', () => {
    expect(wouldCreateCycle('vp-eng', 'manager', orgChart())).toBe(true);
  });

  it('rejects a deep cycle three levels up', () => {
    // ceo -> vp-eng -> manager -> engineer, so making the CEO report to the
    // engineer closes the loop.
    expect(wouldCreateCycle('ceo', 'engineer', orgChart())).toBe(true);
  });

  it('allows a move across branches', () => {
    // The engineer moving under sales is a reorg, not a cycle.
    expect(wouldCreateCycle('engineer', 'vp-sales', orgChart())).toBe(false);
  });

  it('allows promotion to a root', () => {
    expect(wouldCreateCycle('manager', null, orgChart())).toBe(false);
  });

  it('allows an unrelated new node to attach anywhere', () => {
    // ParentMap is a ReadonlyMap on purpose — these algorithms never mutate
    // their input — so the fixture is extended by building a new map.
    const chart: ParentMap = new Map([...orgChart(), ['new-hire', null]]);
    expect(wouldCreateCycle('new-hire', 'manager', chart)).toBe(false);
  });

  it('rejects every ancestor as a proposed child, and accepts every non-ancestor', () => {
    // Property-style (Section 20.3): the rule is exactly "an ancestor may not
    // become a descendant", so assert it over the whole chart rather than on
    // three hand-picked cases.
    const chart = orgChart();
    const everyone = [...chart.keys()];

    for (const node of everyone) {
      const ancestors = new Set(ancestorsOf(node, chart));
      for (const candidate of everyone) {
        const expected = candidate === node || ancestors.has(candidate);
        expect(
          wouldCreateCycle(candidate, node, chart),
          `setting ${node} as parent of ${candidate}`,
        ).toBe(expected);
      }
    }
  });
});

describe('descendantsOf', () => {
  it('finds the whole subtree breadth-first', () => {
    const children = buildChildrenMap(orgChart());
    const found = descendantsOf('vp-eng', children);
    expect(new Set(found)).toEqual(new Set(['manager', 'engineer', 'intern']));
    // Nearest level first: the direct report precedes their report.
    expect(found.indexOf('manager')).toBeLessThan(found.indexOf('engineer'));
    expect(found.indexOf('engineer')).toBeLessThan(found.indexOf('intern'));
  });

  it('returns nothing for a leaf', () => {
    expect(descendantsOf('intern', buildChildrenMap(orgChart()))).toEqual([]);
  });

  it('never includes the root itself', () => {
    expect(descendantsOf('ceo', buildChildrenMap(orgChart()))).not.toContain('ceo');
  });

  it('reaches everyone else from the root', () => {
    const found = descendantsOf('ceo', buildChildrenMap(orgChart()));
    expect(found).toHaveLength(orgChart().size - 1);
  });

  it('terminates on corrupt cyclic data', () => {
    const corrupt: ParentMap = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(() => descendantsOf('a', buildChildrenMap(corrupt))).not.toThrow();
  });
});

describe('buildTree', () => {
  const departments = [
    { id: 'eng', parentId: null, name: 'Engineering' },
    { id: 'backend', parentId: 'eng', name: 'Backend' },
    { id: 'payments', parentId: 'backend', name: 'Payments' },
    { id: 'frontend', parentId: 'eng', name: 'Frontend' },
    { id: 'sales', parentId: null, name: 'Sales' },
  ];

  it('nests children under their parents', () => {
    const roots = buildTree(departments);
    expect(roots.map((r) => r.value.id).sort()).toEqual(['eng', 'sales']);

    const eng = roots.find((r) => r.value.id === 'eng')!;
    expect(eng.children.map((c) => c.value.id).sort()).toEqual(['backend', 'frontend']);
  });

  it('assigns depth by traversal', () => {
    const flat = flattenTree(buildTree(departments));
    const depths = Object.fromEntries(flat.map((n) => [n.value.id, n.depth]));
    expect(depths).toEqual({ eng: 0, backend: 1, payments: 2, frontend: 1, sales: 0 });
  });

  it('reports the deepest path', () => {
    expect(maxDepth(buildTree(departments))).toBe(2);
  });

  it('treats a node with an unreachable parent as a root', () => {
    // This is what a permission-filtered read looks like: the caller can see
    // their own department but not its parent, and the visible subtree must
    // still render instead of disappearing.
    const partial = [
      { id: 'payments', parentId: 'backend', name: 'Payments' },
      { id: 'billing', parentId: 'payments', name: 'Billing' },
    ];
    const roots = buildTree(partial);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.value.id).toBe('payments');
    expect(roots[0]!.children[0]!.value.id).toBe('billing');
  });

  it('handles an empty input', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('keeps every node exactly once', () => {
    const flat = flattenTree(buildTree(departments));
    expect(flat).toHaveLength(departments.length);
    expect(new Set(flat.map((n) => n.value.id)).size).toBe(departments.length);
  });
});
