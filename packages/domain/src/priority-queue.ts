/**
 * Binary heap priority queue — report Section 26.1.
 *
 *   "Notification priority | Heap | Priority queue for urgent scheduled
 *    notifications"
 *
 * Why a heap and not a sorted array. Notifications arrive continuously and are
 * drained continuously, so both operations matter:
 *
 *   sorted array   insert O(n) (shift everything), pop O(1)
 *   sorted on pop  insert O(1), pop O(n log n) — re-sorting every drain
 *   binary heap    insert O(log n), pop O(log n)
 *
 * A heap wins whenever inserts and pops interleave, which is exactly the
 * notification pattern. It is a min-heap over a comparator, so "highest
 * priority" simply means "smallest by this comparison".
 */

export type Comparator<T> = (a: T, b: T) => number;

export class PriorityQueue<T> {
  /**
   * The heap as a flat array. For index i:
   *   parent  = (i - 1) >> 1
   *   left    = 2i + 1
   *   right   = 2i + 2
   *
   * An array rather than linked nodes: contiguous memory, no per-node
   * allocation, and index arithmetic instead of pointer chasing.
   */
  private readonly items: T[] = [];

  constructor(private readonly compare: Comparator<T>) {}

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** Highest-priority item without removing it. O(1). */
  peek(): T | undefined {
    return this.items[0];
  }

  /** O(log n): append at the end, then sift up until the heap holds again. */
  push(item: T): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  /**
   * Remove and return the highest-priority item. O(log n).
   *
   * The last element is moved to the root and sifted down, rather than shifting
   * the whole array — that shift is what makes an array-based queue O(n).
   */
  pop(): T | undefined {
    if (this.items.length === 0) return undefined;

    const top = this.items[0]!;
    const last = this.items.pop()!;

    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }

    return top;
  }

  /**
   * Drain up to `limit` items in priority order.
   *
   * Note this is O(k log n) for k items, not O(n log n): taking the top ten of
   * ten thousand never touches the rest, which is the point when a worker
   * batches deliveries.
   */
  drain(limit = Number.POSITIVE_INFINITY): T[] {
    const out: T[] = [];
    while (out.length < limit && !this.isEmpty()) out.push(this.pop()!);
    return out;
  }

  /**
   * Build from an existing array in O(n).
   *
   * Floyd's method: sift down from the last internal node backwards. Pushing
   * each item individually would be O(n log n), and the difference is real when
   * a worker loads a backlog.
   */
  static from<T>(items: readonly T[], compare: Comparator<T>): PriorityQueue<T> {
    const queue = new PriorityQueue<T>(compare);
    queue.items.push(...items);
    for (let i = (queue.items.length >> 1) - 1; i >= 0; i -= 1) queue.siftDown(i);
    return queue;
  }

  private siftUp(start: number): void {
    let index = start;
    const item = this.items[index]!;

    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = this.items[parentIndex]!;
      if (this.compare(item, parent) >= 0) break;
      this.items[index] = parent;
      index = parentIndex;
    }

    this.items[index] = item;
  }

  private siftDown(start: number): void {
    let index = start;
    const length = this.items.length;
    const item = this.items[index]!;

    for (;;) {
      const left = 2 * index + 1;
      if (left >= length) break;

      const right = left + 1;
      // Pick the smaller child, or the heap property breaks on the other side.
      const child =
        right < length && this.compare(this.items[right]!, this.items[left]!) < 0 ? right : left;

      if (this.compare(this.items[child]!, item) >= 0) break;
      this.items[index] = this.items[child]!;
      index = child;
    }

    this.items[index] = item;
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/** Lower rank = more urgent, so the comparator is a plain subtraction. */
const PRIORITY_RANK: Record<NotificationPriority, number> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

export interface Deliverable {
  id: string;
  priority: NotificationPriority;
  /** Epoch ms. Older first within a priority band. */
  createdAt: number;
}

/**
 * Priority first, then age.
 *
 * The age tiebreak is what prevents starvation: without it, a steady trickle of
 * URGENT items would keep a LOW notification queued forever, and "forever" is
 * not a delivery guarantee.
 */
export function compareDeliverables(a: Deliverable, b: Deliverable): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  return byPriority !== 0 ? byPriority : a.createdAt - b.createdAt;
}

/** Order a batch for delivery. O(n) to build, O(k log n) to take k. */
export function orderForDelivery<T extends Deliverable>(items: readonly T[], limit?: number): T[] {
  return PriorityQueue.from(items, compareDeliverables).drain(limit);
}
