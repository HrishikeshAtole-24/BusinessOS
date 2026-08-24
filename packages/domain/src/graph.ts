/**
 * Directed graph algorithms — report Section 26.1.
 *
 *   "Task dependency engine | Directed graph + topological sort |
 *    Adjacency list; Kahn's algorithm; cycle rejection"
 *
 * Why this file is not `hierarchy.ts`. A department tree gives every node
 * exactly one parent, so "would this create a cycle?" is answered by walking up
 * a single chain in O(d). Task dependencies are a **DAG**: one task can block
 * many, and be blocked by many. There is no single chain to walk, so the same
 * question needs a real traversal — O(V + E).
 *
 * Pure functions over adjacency maps. No Prisma, no I/O, fully testable.
 */

/** `node -> nodes it points at`. For tasks: predecessor -> successors. */
export type AdjacencyList = ReadonlyMap<string, readonly string[]>;

export interface Edge {
  /** Must finish first. */
  from: string;
  /** Cannot start until `from` is done. */
  to: string;
}

/** Build an adjacency list, ensuring every node appears as a key. */
export function buildAdjacency(nodes: readonly string[], edges: readonly Edge[]): AdjacencyList {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    // Tolerate edges naming unknown nodes rather than throwing: a
    // permission-filtered read may legitimately return a subgraph.
    const bucket = adjacency.get(edge.from);
    if (bucket) bucket.push(edge.to);
  }
  return adjacency;
}

/** Reverse every edge. Successors become predecessors. */
export function reverse(adjacency: AdjacencyList): AdjacencyList {
  const reversed = new Map<string, string[]>();
  for (const node of adjacency.keys()) reversed.set(node, []);
  for (const [from, tos] of adjacency) {
    for (const to of tos) reversed.get(to)?.push(from);
  }
  return reversed;
}

// ---------------------------------------------------------------------------
// Topological sort — Kahn's algorithm
// ---------------------------------------------------------------------------

export interface TopologicalResult {
  /** Valid execution order, or null when the graph contains a cycle. */
  order: string[] | null;
  /** The nodes involved in a cycle, when one exists. */
  cyclic: string[];
}

/**
 * Kahn's algorithm. O(V + E) time, O(V) space.
 *
 * Repeatedly take a node with no unmet dependencies, emit it, and remove its
 * outgoing edges. If the queue empties before every node is emitted, whatever
 * remains has an unbreakable mutual dependency — a cycle.
 *
 * Chosen over DFS-based topological sort for two reasons: it is iterative, so a
 * ten-thousand-task project cannot blow the call stack, and the leftover set
 * falls out for free as the exact set of tasks stuck in a cycle.
 */
export function topologicalSort(adjacency: AdjacencyList): TopologicalResult {
  const inDegree = new Map<string, number>();
  for (const node of adjacency.keys()) inDegree.set(node, 0);
  for (const successors of adjacency.values()) {
    for (const successor of successors) {
      inDegree.set(successor, (inDegree.get(successor) ?? 0) + 1);
    }
  }

  // Everything that can start immediately.
  const queue: string[] = [];
  for (const [node, degree] of inDegree) {
    if (degree === 0) queue.push(node);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);

    for (const successor of adjacency.get(node) ?? []) {
      const remaining = (inDegree.get(successor) ?? 0) - 1;
      inDegree.set(successor, remaining);
      if (remaining === 0) queue.push(successor);
    }
  }

  if (order.length === adjacency.size) return { order, cyclic: [] };

  // Anything with a non-zero in-degree left is in, or downstream of, a cycle.
  const cyclic = [...inDegree.entries()].filter(([, degree]) => degree > 0).map(([node]) => node);

  return { order: null, cyclic };
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

const WHITE = 0; // unvisited
const GREY = 1; // on the current DFS path
const BLACK = 2; // fully explored

/**
 * Find one concrete cycle, as an ordered path.
 *
 * Kahn's tells you *that* a cycle exists and which nodes are involved. This
 * returns the actual loop — `A -> B -> C -> A` — which is the difference
 * between an error message a user can act on and one they cannot.
 *
 * Three-colour DFS: reaching a GREY node means we have looped back onto the
 * current path. A BLACK node is already fully explored and cannot be part of a
 * cycle through here. O(V + E), iterative to avoid stack limits.
 */
export function findCycle(adjacency: AdjacencyList): string[] | null {
  const colour = new Map<string, number>();
  const parent = new Map<string, string>();
  for (const node of adjacency.keys()) colour.set(node, WHITE);

  for (const start of adjacency.keys()) {
    if (colour.get(start) !== WHITE) continue;

    // Explicit stack of [node, nextChildIndex] so the walk is iterative.
    const stack: Array<[string, number]> = [[start, 0]];
    colour.set(start, GREY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const [node, index] = frame;
      const successors = adjacency.get(node) ?? [];

      if (index >= successors.length) {
        colour.set(node, BLACK);
        stack.pop();
        continue;
      }

      frame[1] += 1;
      const next = successors[index]!;
      const nextColour = colour.get(next) ?? WHITE;

      if (nextColour === GREY) {
        // Walk back along parents to reconstruct the loop.
        const cycle = [next];
        let current = node;
        while (current !== next) {
          cycle.push(current);
          const up = parent.get(current);
          if (up === undefined) break;
          current = up;
        }
        cycle.push(next);
        return cycle.reverse();
      }

      if (nextColour === WHITE) {
        parent.set(next, node);
        colour.set(next, GREY);
        stack.push([next, 0]);
      }
    }
  }

  return null;
}

/**
 * Would adding `from -> to` create a cycle?
 *
 * Equivalent to asking whether `from` is already reachable from `to`. If it is,
 * the new edge closes the loop.
 *
 * O(V + E) worst case, but it walks only the subgraph downstream of `to`, which
 * in practice is a small slice of a project.
 */
export function wouldCreateEdgeCycle(from: string, to: string, adjacency: AdjacencyList): boolean {
  if (from === to) return true; // a task cannot depend on itself
  return reachableFrom(to, adjacency).has(from);
}

/** Every node reachable from `start`, excluding `start` itself. DFS, O(V + E). */
export function reachableFrom(start: string, adjacency: AdjacencyList): Set<string> {
  const seen = new Set<string>();
  const stack = [...(adjacency.get(start) ?? [])];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(adjacency.get(node) ?? []));
  }

  return seen;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Tasks that can start now: every predecessor is complete.
 *
 * `adjacency` is predecessor -> successors, so this walks the reverse edges.
 */
export function readyNodes(
  adjacency: AdjacencyList,
  isComplete: (node: string) => boolean,
): string[] {
  const predecessors = reverse(adjacency);
  const ready: string[] = [];

  for (const node of adjacency.keys()) {
    if (isComplete(node)) continue;
    const blockers = predecessors.get(node) ?? [];
    if (blockers.every((blocker) => isComplete(blocker))) ready.push(node);
  }

  return ready;
}

/** Incomplete predecessors of `node` — the reason it cannot start. */
export function blockedBy(
  node: string,
  adjacency: AdjacencyList,
  isComplete: (node: string) => boolean,
): string[] {
  return (reverse(adjacency).get(node) ?? []).filter((p) => !isComplete(p));
}

export interface CriticalPathResult {
  /** Longest dependency chain by total weight, in execution order. */
  path: string[];
  /** Total weight along it. */
  length: number;
  /** Earliest start offset per node, given unlimited parallelism. */
  earliestStart: Map<string, number>;
}

/**
 * Critical path — the longest weighted path through the DAG.
 *
 * This is the chain that determines the project's duration: shortening any task
 * *not* on it changes nothing, while any slip on it slips the whole project.
 *
 * Longest path is NP-hard on a general graph, but linear on a DAG, because a
 * topological order guarantees every predecessor is finalised before a node is
 * examined. That is the whole reason the topological sort is worth computing.
 * O(V + E).
 */
export function criticalPath(
  adjacency: AdjacencyList,
  weightOf: (node: string) => number,
): CriticalPathResult {
  const { order } = topologicalSort(adjacency);
  // A cyclic graph has no longest path — it is unbounded.
  if (order === null) return { path: [], length: 0, earliestStart: new Map() };

  const earliestStart = new Map<string, number>();
  const finish = new Map<string, number>();
  const cameFrom = new Map<string, string>();

  for (const node of order) {
    const start = earliestStart.get(node) ?? 0;
    earliestStart.set(node, start);
    const end = start + weightOf(node);
    finish.set(node, end);

    for (const successor of adjacency.get(node) ?? []) {
      // A successor starts only once its LAST predecessor finishes.
      if (end > (earliestStart.get(successor) ?? 0)) {
        earliestStart.set(successor, end);
        cameFrom.set(successor, node);
      }
    }
  }

  let endNode: string | null = null;
  let longest = 0;
  for (const [node, end] of finish) {
    if (end >= longest) {
      longest = end;
      endNode = node;
    }
  }

  const path: string[] = [];
  let cursor = endNode;
  while (cursor !== null && cursor !== undefined) {
    path.push(cursor);
    cursor = cameFrom.get(cursor) ?? null;
  }

  return { path: path.reverse(), length: longest, earliestStart };
}
