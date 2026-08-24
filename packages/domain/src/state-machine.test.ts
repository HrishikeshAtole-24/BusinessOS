import { describe, expect, it } from 'vitest';
import {
  PROJECT_STATUSES,
  StateMachine,
  TASK_STATUSES,
  isTaskComplete,
  projectStateMachine,
  taskStateMachine,
  type TaskStatus,
} from './state-machine';

describe('task state machine (Section 8.1)', () => {
  it('follows the happy path', () => {
    const path: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(
        taskStateMachine.canTransition(path[i]!, path[i + 1]!),
        `${path[i]} -> ${path[i + 1]}`,
      ).toBe(true);
    }
  });

  it('refuses to skip review', () => {
    // Straight from IN_PROGRESS to DONE would bypass the review gate.
    expect(taskStateMachine.canTransition('IN_PROGRESS', 'DONE')).toBe(false);
  });

  it('refuses to start a task that is already done without reopening', () => {
    expect(taskStateMachine.canTransition('DONE', 'IN_REVIEW')).toBe(false);
    expect(taskStateMachine.canTransition('DONE', 'TODO')).toBe(false);
    // Reopening is legal, and lands in IN_PROGRESS because work demonstrably began.
    expect(taskStateMachine.canTransition('DONE', 'IN_PROGRESS')).toBe(true);
  });

  it('can block from any working state', () => {
    for (const from of ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] as TaskStatus[]) {
      expect(taskStateMachine.canTransition(from, 'BLOCKED'), `${from} -> BLOCKED`).toBe(true);
    }
  });

  it('unblocks back into the pipeline, not to the front of the queue', () => {
    expect(taskStateMachine.canTransition('BLOCKED', 'IN_PROGRESS')).toBe(true);
    expect(taskStateMachine.canTransition('BLOCKED', 'TODO')).toBe(true);
    // Whatever blocked it may have invalidated the work, so review is not
    // reachable directly.
    expect(taskStateMachine.canTransition('BLOCKED', 'IN_REVIEW')).toBe(false);
    expect(taskStateMachine.canTransition('BLOCKED', 'DONE')).toBe(false);
  });

  it('treats a no-op transition as valid', () => {
    // A PATCH resending the current status should be idempotent, not a 409.
    for (const status of TASK_STATUSES) {
      expect(taskStateMachine.check(status, status).ok, `${status} -> ${status}`).toBe(true);
    }
  });

  it('reports what WAS allowed when rejecting', () => {
    const result = taskStateMachine.check('TODO', 'DONE');
    expect(result.ok).toBe(false);
    expect(result.allowed).toEqual(['IN_PROGRESS', 'BLOCKED']);
  });

  it('can reach DONE from every status', () => {
    // No status is a dead end that strands a task forever.
    for (const status of TASK_STATUSES) {
      if (status === 'DONE') continue;
      expect(taskStateMachine.reachableFrom(status).has('DONE'), `from ${status}`).toBe(true);
    }
  });

  it('only DONE counts as complete', () => {
    for (const status of TASK_STATUSES) {
      expect(isTaskComplete(status)).toBe(status === 'DONE');
    }
  });
});

describe('project state machine', () => {
  it('runs planning through to completion', () => {
    expect(projectStateMachine.canTransition('PLANNING', 'ACTIVE')).toBe(true);
    expect(projectStateMachine.canTransition('ACTIVE', 'COMPLETED')).toBe(true);
  });

  it('cannot go straight from planning to completed', () => {
    expect(projectStateMachine.canTransition('PLANNING', 'COMPLETED')).toBe(false);
  });

  it('requires a cancelled project to be revived deliberately', () => {
    // Back through PLANNING, so reviving is an explicit decision.
    expect(projectStateMachine.canTransition('CANCELLED', 'ACTIVE')).toBe(false);
    expect(projectStateMachine.canTransition('CANCELLED', 'PLANNING')).toBe(true);
  });

  it('allows a completed project to reopen', () => {
    expect(projectStateMachine.canTransition('COMPLETED', 'ACTIVE')).toBe(true);
  });

  it('can reach a finished state from anywhere', () => {
    for (const status of PROJECT_STATUSES) {
      const reachable = projectStateMachine.reachableFrom(status);
      expect(
        reachable.has('COMPLETED') || reachable.has('CANCELLED') || status === 'COMPLETED',
        `from ${status}`,
      ).toBe(true);
    }
  });
});

describe('StateMachine', () => {
  it('treats a state with no outgoing transitions as terminal', () => {
    const machine = new StateMachine<'a' | 'b'>({ a: ['b'], b: [] });
    expect(machine.isTerminal('b')).toBe(true);
    expect(machine.isTerminal('a')).toBe(false);
  });

  it('honours an explicit terminal set', () => {
    const machine = new StateMachine<'a' | 'b'>({ a: ['b'], b: ['a'] }, new Set(['b']));
    expect(machine.isTerminal('b')).toBe(true);
  });

  it('reachableFrom terminates on a cyclic table', () => {
    const machine = new StateMachine<'a' | 'b'>({ a: ['b'], b: ['a'] });
    expect(machine.reachableFrom('a')).toEqual(new Set(['a', 'b']));
  });
});
