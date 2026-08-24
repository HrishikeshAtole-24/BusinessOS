/**
 * State machines — report Sections 8 and 13.3.
 *
 *   "Represent allowed transitions explicitly. Do not scatter status checks
 *    throughout controllers."
 *
 * The alternative — `if (task.status === 'DONE') throw ...` sprinkled across
 * handlers — fails in a specific way: every new status means auditing every
 * handler for a check somebody forgot. A transition table makes the legal moves
 * a single readable object, and makes an illegal move impossible to express
 * rather than merely discouraged.
 */

export interface TransitionResult<S extends string> {
  ok: boolean;
  from: S;
  to: S;
  /** What WAS allowed, so an error message can say so. */
  allowed: readonly S[];
}

/**
 * A finite state machine over a transition table.
 *
 * Generic because the same machine drives tasks, expenses, leave requests and
 * approval steps — Section 8 defines one for each, and they differ only in
 * their table.
 */
export class StateMachine<S extends string> {
  constructor(
    private readonly transitions: Readonly<Record<S, readonly S[]>>,
    /** States from which nothing may move. */
    private readonly terminal: ReadonlySet<S> = new Set(),
  ) {}

  /** Legal next states from `state`. */
  allowedFrom(state: S): readonly S[] {
    return this.transitions[state] ?? [];
  }

  canTransition(from: S, to: S): boolean {
    return this.allowedFrom(from).includes(to);
  }

  isTerminal(state: S): boolean {
    return this.terminal.has(state) || this.allowedFrom(state).length === 0;
  }

  /**
   * Check a move without throwing, so callers can decide the response.
   *
   * A no-op transition (from === to) is allowed: a PATCH that resends the
   * current status should be idempotent, not an error.
   */
  check(from: S, to: S): TransitionResult<S> {
    if (from === to) return { ok: true, from, to, allowed: this.allowedFrom(from) };
    return { ok: this.canTransition(from, to), from, to, allowed: this.allowedFrom(from) };
  }

  /** Every state reachable from `state`, transitively. Useful for UI hints. */
  reachableFrom(state: S): Set<S> {
    const seen = new Set<S>();
    const stack: S[] = [...this.allowedFrom(state)];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...this.allowedFrom(next));
    }
    return seen;
  }
}

// ---------------------------------------------------------------------------
// Task lifecycle — Section 8.1
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * ```
 * TODO -> IN_PROGRESS -> IN_REVIEW -> DONE
 *   |          |              |
 *   +--------> BLOCKED <------+
 * ```
 *
 * Two decisions worth stating:
 *
 * DONE is not terminal. Work gets reopened — a review finds a defect, or a
 * dependency changes underneath it — and forcing a new task for that loses the
 * history. It reopens to IN_PROGRESS only, never straight back to TODO, because
 * the work demonstrably started.
 *
 * BLOCKED returns to IN_PROGRESS, never to IN_REVIEW. Whatever blocked it may
 * have invalidated the work, so it re-enters the pipeline rather than jumping
 * to the front of the queue.
 */
export const taskStateMachine = new StateMachine<TaskStatus>({
  TODO: ['IN_PROGRESS', 'BLOCKED'],
  IN_PROGRESS: ['IN_REVIEW', 'BLOCKED', 'TODO'],
  BLOCKED: ['TODO', 'IN_PROGRESS'],
  IN_REVIEW: ['DONE', 'IN_PROGRESS', 'BLOCKED'],
  DONE: ['IN_PROGRESS'],
});

/** Statuses that count as finished for dependency and progress purposes. */
export const COMPLETED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['DONE']);

export function isTaskComplete(status: TaskStatus): boolean {
  return COMPLETED_TASK_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = [
  'PLANNING',
  'ACTIVE',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * CANCELLED is terminal; COMPLETED is not, because a project can reopen when
 * follow-up work appears. Neither can be reached from the other directly — a
 * cancelled project has to be revived through PLANNING, which forces the
 * decision to be explicit.
 */
export const projectStateMachine = new StateMachine<ProjectStatus>(
  {
    PLANNING: ['ACTIVE', 'CANCELLED'],
    ACTIVE: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
    ON_HOLD: ['ACTIVE', 'CANCELLED'],
    COMPLETED: ['ACTIVE'],
    CANCELLED: ['PLANNING'],
  },
  new Set(),
);
