/**
 * Hierarchy algorithms — report Section 26.1 ("Org hierarchy — Tree —
 * adjacency map + DFS/BFS for reporting chains").
 *
 * Two structures in BusinessOS are trees stored as adjacency edges:
 *
 *   Department.parentId   Engineering -> Backend -> Payments
 *   Employee.managerId    CEO -> VP -> Manager -> Engineer
 *
 * A self-referencing foreign key can express "my parent exists". It cannot
 * express "my parent is not also my descendant" — that is a reachability
 * question, and the database has no constraint for it. So the invariant is
 * enforced here, before the write.
 *
 * Everything below is a pure function over an adjacency map: no Prisma, no I/O.
 * That keeps them exhaustively testable and makes the complexity legible.
 */

/** `child -> parent`. Absent or null means the node is a root. */
export type ParentMap = ReadonlyMap<string, string | null>;

/**
 * Walk from a node to its root, collecting ancestors nearest-first.
 *
 * Time O(d), space O(d), where d is depth. The visited set is not an
 * optimization — it is what stops an already-corrupt cycle in the data from
 * spinning this loop forever.
 */
export function ancestorsOf(nodeId: string, parents: ParentMap): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([nodeId]);

  let current = parents.get(nodeId) ?? null;
  while (current !== null && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = parents.get(current) ?? null;
  }

  return chain;
}

/**
 * Would setting `parentId` as the parent of `nodeId` create a cycle?
 *
 * Three ways it can, and all three are the same question:
 *
 *   1. A node is its own parent            (nodeId === parentId)
 *   2. The proposed parent is a descendant (A -> B, then B -> A)
 *   3. Deeper: A -> B -> C, then C -> A
 *
 * All three reduce to: *is `nodeId` on the path from `parentId` to the root?*
 * If it is, adding the edge closes a loop.
 *
 * Time O(d) — one walk up the ancestor chain — rather than the O(V+E) a full
 * graph traversal would cost, because a tree gives each node exactly one
 * parent. There is nowhere else to look.
 */
export function wouldCreateCycle(
  nodeId: string,
  proposedParentId: string | null,
  parents: ParentMap,
): boolean {
  if (proposedParentId === null) return false; // detaching to root is always safe
  if (nodeId === proposedParentId) return true; // self-parent

  // If nodeId is an ancestor of the proposed parent, the edge closes a loop.
  return ancestorsOf(proposedParentId, parents).includes(nodeId);
}

/** `parent -> children`, the inverted adjacency used for downward traversal. */
export type ChildrenMap = ReadonlyMap<string | null, string[]>;

export function buildChildrenMap(parents: ParentMap): ChildrenMap {
  const children = new Map<string | null, string[]>();
  for (const [child, parent] of parents) {
    const bucket = children.get(parent) ?? [];
    bucket.push(child);
    children.set(parent, bucket);
  }
  return children;
}

/**
 * Every node beneath `rootId`, breadth-first.
 *
 * BFS rather than DFS because the natural question here is "who is under this
 * manager, nearest first" — a reporting chain read level by level. Time O(V+E)
 * over the subtree, space O(width).
 */
export function descendantsOf(rootId: string, children: ChildrenMap): string[] {
  const found: string[] = [];
  const queue: string[] = [...(children.get(rootId) ?? [])];
  const seen = new Set<string>([rootId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue; // defensive against corrupt data
    seen.add(current);
    found.push(current);
    queue.push(...(children.get(current) ?? []));
  }

  return found;
}

export interface TreeNode<T> {
  value: T;
  children: Array<TreeNode<T>>;
  depth: number;
}

/**
 * Assemble a flat, adjacency-encoded list into nested tree roots.
 *
 * Single pass to index by id, second pass to link — O(n) rather than the O(n²)
 * of scanning the list for each node's children.
 *
 * Nodes whose parent is missing from the input are treated as roots. That
 * matters for permission-filtered reads: an employee may see their own
 * department but not its parent, and the subtree they can see should still
 * render rather than vanishing.
 */
export function buildTree<T extends { id: string; parentId: string | null }>(
  items: readonly T[],
): Array<TreeNode<T>> {
  const nodes = new Map<string, TreeNode<T>>();
  for (const item of items) {
    nodes.set(item.id, { value: item, children: [], depth: 0 });
  }

  const roots: Array<TreeNode<T>> = [];
  for (const item of items) {
    const node = nodes.get(item.id)!;
    const parent = item.parentId === null ? undefined : nodes.get(item.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Depth is assigned by traversal, not stored, so it cannot drift out of sync
  // with the edges after a re-parent.
  const stack: Array<TreeNode<T>> = roots.map((r) => {
    r.depth = 0;
    return r;
  });
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of node.children) {
      child.depth = node.depth + 1;
      stack.push(child);
    }
  }

  return roots;
}

/** Depth-first flatten, so a tree can be rendered as an indented list. */
export function flattenTree<T>(roots: ReadonlyArray<TreeNode<T>>): Array<TreeNode<T>> {
  const out: Array<TreeNode<T>> = [];

  function visit(node: TreeNode<T>): void {
    out.push(node);
    for (const child of node.children) visit(child);
  }

  for (const root of roots) visit(root);
  return out;
}

/** Deepest path length in the tree. O(V). */
export function maxDepth<T>(roots: ReadonlyArray<TreeNode<T>>): number {
  let deepest = 0;
  for (const node of flattenTree(roots)) {
    if (node.depth > deepest) deepest = node.depth;
  }
  return deepest;
}
