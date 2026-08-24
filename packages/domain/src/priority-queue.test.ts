import { describe, expect, it } from 'vitest';
import {
  PriorityQueue,
  compareDeliverables,
  orderForDelivery,
  type Deliverable,
} from './priority-queue';

const numeric = (a: number, b: number) => a - b;

describe('PriorityQueue', () => {
  it('pops in priority order regardless of insertion order', () => {
    const queue = new PriorityQueue<number>(numeric);
    for (const n of [5, 3, 8, 1, 9, 2]) queue.push(n);
    expect(queue.drain()).toEqual([1, 2, 3, 5, 8, 9]);
  });

  it('reports size and emptiness', () => {
    const queue = new PriorityQueue<number>(numeric);
    expect(queue.isEmpty()).toBe(true);
    queue.push(1);
    expect(queue.size).toBe(1);
    queue.pop();
    expect(queue.isEmpty()).toBe(true);
  });

  it('returns undefined when popping or peeking an empty queue', () => {
    const queue = new PriorityQueue<number>(numeric);
    expect(queue.pop()).toBeUndefined();
    expect(queue.peek()).toBeUndefined();
  });

  it('peeks without removing', () => {
    const queue = new PriorityQueue<number>(numeric);
    queue.push(4);
    queue.push(2);
    expect(queue.peek()).toBe(2);
    expect(queue.size).toBe(2);
  });

  it('handles duplicates', () => {
    const queue = new PriorityQueue<number>(numeric);
    for (const n of [3, 1, 3, 1, 2]) queue.push(n);
    expect(queue.drain()).toEqual([1, 1, 2, 3, 3]);
  });

  it('interleaves pushes and pops correctly', () => {
    // The pattern a live queue actually sees, and the one a sort-on-drain
    // implementation gets wrong.
    const queue = new PriorityQueue<number>(numeric);
    queue.push(5);
    queue.push(3);
    expect(queue.pop()).toBe(3);
    queue.push(1);
    queue.push(4);
    expect(queue.pop()).toBe(1);
    expect(queue.pop()).toBe(4);
    expect(queue.pop()).toBe(5);
  });

  it('drains only up to the limit', () => {
    const queue = PriorityQueue.from([9, 1, 5, 3, 7], numeric);
    expect(queue.drain(2)).toEqual([1, 3]);
    // The rest survives — a batched worker takes ten and leaves the backlog.
    expect(queue.size).toBe(3);
  });

  it('builds from an array with Floyd heapify', () => {
    const items = Array.from({ length: 500 }, (_, i) => (i * 37) % 500);
    const queue = PriorityQueue.from(items, numeric);
    expect(queue.drain()).toEqual([...items].sort(numeric));
  });

  it('matches a plain sort on random input', () => {
    // Property-style: a heap that disagrees with sort is a broken heap.
    for (let run = 0; run < 20; run += 1) {
      const items = Array.from({ length: 200 }, () => Math.floor(Math.random() * 1000));
      const queue = new PriorityQueue<number>(numeric);
      for (const n of items) queue.push(n);
      expect(queue.drain()).toEqual([...items].sort(numeric));
    }
  });

  it('supports a max-heap by inverting the comparator', () => {
    const queue = PriorityQueue.from([1, 9, 5], (a, b) => b - a);
    expect(queue.drain()).toEqual([9, 5, 1]);
  });
});

describe('notification ordering', () => {
  const make = (id: string, priority: Deliverable['priority'], minutesAgo: number) => ({
    id,
    priority,
    createdAt: Date.now() - minutesAgo * 60_000,
  });

  it('delivers by priority band first', () => {
    const ordered = orderForDelivery([
      make('low', 'LOW', 0),
      make('urgent', 'URGENT', 0),
      make('normal', 'NORMAL', 0),
      make('high', 'HIGH', 0),
    ]);
    expect(ordered.map((n) => n.id)).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it('delivers oldest first within a band', () => {
    const ordered = orderForDelivery([make('newer', 'HIGH', 1), make('older', 'HIGH', 60)]);
    expect(ordered.map((n) => n.id)).toEqual(['older', 'newer']);
  });

  it('prefers an old low-priority item over a newer one', () => {
    // The starvation guard: without the age tiebreak, ordering within a band
    // would be arbitrary and an item could sit indefinitely.
    const ordered = orderForDelivery([make('fresh', 'LOW', 0), make('stale', 'LOW', 10_000)]);
    expect(ordered[0]!.id).toBe('stale');
  });

  it('still puts urgent ahead of a much older low-priority item', () => {
    // Priority dominates age. A password reset does not wait behind a
    // week-old digest.
    const ordered = orderForDelivery([
      make('ancient-low', 'LOW', 100_000),
      make('new-urgent', 'URGENT', 0),
    ]);
    expect(ordered[0]!.id).toBe('new-urgent');
  });

  it('takes only the batch size asked for', () => {
    const items = Array.from({ length: 100 }, (_, i) => make(`n${i}`, 'NORMAL', i));
    expect(orderForDelivery(items, 10)).toHaveLength(10);
  });

  it('is a total order — comparator is antisymmetric', () => {
    const a = make('a', 'HIGH', 5);
    const b = make('b', 'LOW', 5);
    expect(Math.sign(compareDeliverables(a, b))).toBe(-Math.sign(compareDeliverables(b, a)));
  });
});
