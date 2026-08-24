import { describe, expect, it } from 'vitest';
import {
  blockedBy,
  buildAdjacency,
  criticalPath,
  findCycle,
  readyNodes,
  reachableFrom,
  reverse,
  topologicalSort,
  wouldCreateEdgeCycle,
  type Edge,
} from './graph';

/**
 * The report's own worked example (Section 10):
 *
 *   Database Design -> Backend API -> Frontend -> Testing -> Deployment
 *
 * plus a parallel branch, because a straight line is a tree and would not
 * exercise anything a DAG needs.
 */
const NODES = ['db', 'api', 'ui', 'qa', 'deploy', 'docs'];
const EDGES: Edge[] = [
  { from: 'db', to: 'api' },
  { from: 'api', to: 'ui' },
  { from: 'ui', to: 'qa' },
  { from: 'qa', to: 'deploy' },
  // Docs run alongside the UI and must also land before deployment: this is
  // what makes the graph a DAG rather than a chain.
  { from: 'api', to: 'docs' },
  { from: 'docs', to: 'deploy' },
];

const graph = () => buildAdjacency(NODES, EDGES);

describe('topologicalSort', () => {
  it('produces an order respecting every edge', () => {
    const { order } = topologicalSort(graph());
    expect(order).not.toBeNull();

    const position = new Map(order!.map((n, i) => [n, i]));
    for (const edge of EDGES) {
      expect(position.get(edge.from)!, `${edge.from} must come before ${edge.to}`).toBeLessThan(
        position.get(edge.to)!,
      );
    }
  });

  it('includes every node exactly once', () => {
    const { order } = topologicalSort(graph());
    expect(order).toHaveLength(NODES.length);
    expect(new Set(order)).toEqual(new Set(NODES));
  });

  it('handles independent nodes with no edges', () => {
    const { order } = topologicalSort(buildAdjacency(['a', 'b', 'c'], []));
    expect(new Set(order)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns null and names the stuck nodes on a cycle', () => {
    const cyclic = buildAdjacency(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    );
    const { order, cyclic: stuck } = topologicalSort(cyclic);
    expect(order).toBeNull();
    expect(new Set(stuck)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('reports only the cycle, not unrelated nodes', () => {
    const mixed = buildAdjacency(
      ['free', 'a', 'b'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    const { cyclic } = topologicalSort(mixed);
    expect(cyclic).not.toContain('free');
    expect(new Set(cyclic)).toEqual(new Set(['a', 'b']));
  });

  it('handles an empty graph', () => {
    expect(topologicalSort(buildAdjacency([], []))).toEqual({ order: [], cyclic: [] });
  });
});

describe('findCycle', () => {
  it('finds nothing in a valid DAG', () => {
    expect(findCycle(graph())).toBeNull();
  });

  it('returns the actual loop, not just a flag', () => {
    // The difference between "there is a cycle somewhere" and an error a user
    // can act on.
    const cyclic = buildAdjacency(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    );
    const cycle = findCycle(cyclic)!;
    expect(cycle).not.toBeNull();
    // Closed loop: starts and ends on the same node.
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('finds a self-loop', () => {
    const selfLoop = buildAdjacency(['a'], [{ from: 'a', to: 'a' }]);
    expect(findCycle(selfLoop)).toEqual(['a', 'a']);
  });

  it('finds a cycle reachable only through a long prefix', () => {
    // A DFS that stopped at the first branch would miss this.
    const deep = buildAdjacency(
      ['s1', 's2', 's3', 'x', 'y'],
      [
        { from: 's1', to: 's2' },
        { from: 's2', to: 's3' },
        { from: 's3', to: 'x' },
        { from: 'x', to: 'y' },
        { from: 'y', to: 'x' },
      ],
    );
    const cycle = findCycle(deep)!;
    expect(cycle).not.toBeNull();
    expect(new Set(cycle)).toEqual(new Set(['x', 'y']));
  });

  it('does not report a diamond as a cycle', () => {
    // a -> b -> d and a -> c -> d. Two paths to the same node is normal in a
    // DAG; a two-colour DFS that forgot BLACK would call this a cycle.
    const diamond = buildAdjacency(
      ['a', 'b', 'c', 'd'],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    );
    expect(findCycle(diamond)).toBeNull();
  });
});

describe('wouldCreateEdgeCycle', () => {
  it('rejects a task depending on itself', () => {
    expect(wouldCreateEdgeCycle('api', 'api', graph())).toBe(true);
  });

  it('rejects a direct back-edge', () => {
    // api already depends on db, so db depending on api closes the loop.
    expect(wouldCreateEdgeCycle('api', 'db', graph())).toBe(true);
  });

  it('rejects a long-range back-edge', () => {
    // deploy is downstream of db through four hops.
    expect(wouldCreateEdgeCycle('deploy', 'db', graph())).toBe(true);
  });

  it('allows a forward edge that only adds a constraint', () => {
    // Docs before QA is a new constraint, not a loop.
    expect(wouldCreateEdgeCycle('docs', 'qa', graph())).toBe(false);
  });

  it('allows an edge between unrelated branches', () => {
    const disconnected = buildAdjacency(['a', 'b', 'x', 'y'], [{ from: 'a', to: 'b' }]);
    expect(wouldCreateEdgeCycle('x', 'y', disconnected)).toBe(false);
  });

  it('agrees with findCycle for every possible new edge', () => {
    // Property-style (Section 20.3): rather than trust hand-picked cases,
    // assert that the fast check matches actually adding the edge and running
    // full cycle detection, across every ordered pair in the graph.
    for (const from of NODES) {
      for (const to of NODES) {
        const predicted = wouldCreateEdgeCycle(from, to, graph());
        const actual = findCycle(buildAdjacency(NODES, [...EDGES, { from, to }])) !== null;
        expect(predicted, `edge ${from} -> ${to}`).toBe(actual);
      }
    }
  });
});

describe('reachableFrom', () => {
  it('finds the full downstream set', () => {
    expect(reachableFrom('api', graph())).toEqual(new Set(['ui', 'qa', 'deploy', 'docs']));
  });

  it('excludes the start node', () => {
    expect(reachableFrom('db', graph()).has('db')).toBe(false);
  });

  it('returns nothing from a terminal node', () => {
    expect(reachableFrom('deploy', graph()).size).toBe(0);
  });
});

describe('reverse', () => {
  it('turns successors into predecessors', () => {
    const predecessors = reverse(graph());
    expect(new Set(predecessors.get('deploy'))).toEqual(new Set(['qa', 'docs']));
    expect(predecessors.get('db')).toEqual([]);
  });
});

describe('readyNodes and blockedBy', () => {
  it('only the root is ready when nothing is done', () => {
    expect(readyNodes(graph(), () => false)).toEqual(['db']);
  });

  it('unblocks successors as work completes', () => {
    const done = new Set(['db']);
    expect(readyNodes(graph(), (n) => done.has(n))).toEqual(['api']);

    done.add('api');
    // Both branches open at once — the parallelism a DAG exists to express.
    expect(new Set(readyNodes(graph(), (n) => done.has(n)))).toEqual(new Set(['ui', 'docs']));
  });

  it('a node with several predecessors waits for all of them', () => {
    const done = new Set(['db', 'api', 'ui', 'qa']);
    // deploy needs docs too, and docs is not done.
    expect(readyNodes(graph(), (n) => done.has(n))).not.toContain('deploy');
    expect(blockedBy('deploy', graph(), (n) => done.has(n))).toEqual(['docs']);
  });

  it('reports nothing blocking once all predecessors are done', () => {
    const done = new Set(['db', 'api', 'ui', 'qa', 'docs']);
    expect(blockedBy('deploy', graph(), (n) => done.has(n))).toEqual([]);
  });
});

describe('criticalPath', () => {
  it('finds the longest weighted chain', () => {
    // db(1) -> api(2) -> ui(5) -> qa(2) -> deploy(1)  = 11
    // db(1) -> api(2) -> docs(1) -> deploy(1)         = 5
    const weights: Record<string, number> = {
      db: 1,
      api: 2,
      ui: 5,
      qa: 2,
      deploy: 1,
      docs: 1,
    };
    const result = criticalPath(graph(), (n) => weights[n] ?? 0);

    expect(result.length).toBe(11);
    expect(result.path).toEqual(['db', 'api', 'ui', 'qa', 'deploy']);
  });

  it('follows the heavier branch when weights shift', () => {
    // Making docs enormous moves the critical path onto it.
    const weights: Record<string, number> = {
      db: 1,
      api: 1,
      ui: 1,
      qa: 1,
      deploy: 1,
      docs: 50,
    };
    const result = criticalPath(graph(), (n) => weights[n] ?? 0);
    expect(result.path).toContain('docs');
    expect(result.path).not.toContain('ui');
  });

  it('computes earliest start as the max over predecessors', () => {
    const weights: Record<string, number> = { db: 1, api: 2, ui: 5, qa: 2, deploy: 1, docs: 1 };
    const { earliestStart } = criticalPath(graph(), (n) => weights[n] ?? 0);

    expect(earliestStart.get('db')).toBe(0);
    expect(earliestStart.get('api')).toBe(1);
    // Both ui and docs start once api finishes at t=3.
    expect(earliestStart.get('ui')).toBe(3);
    expect(earliestStart.get('docs')).toBe(3);
    // deploy waits for the LATER of qa (3+5+2=10) and docs (3+1=4).
    expect(earliestStart.get('deploy')).toBe(10);
  });

  it('returns an empty result for a cyclic graph', () => {
    // Longest path is unbounded around a loop, so there is no answer to give.
    const cyclic = buildAdjacency(
      ['a', 'b'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    expect(criticalPath(cyclic, () => 1)).toEqual({
      path: [],
      length: 0,
      earliestStart: new Map(),
    });
  });
});
