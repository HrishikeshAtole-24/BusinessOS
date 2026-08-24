import { describe, expect, it } from 'vitest';
import {
  approvalStateMachine,
  expenseStateMachine,
  leaveStateMachine,
  materializeSteps,
  nextPendingStep,
  outcomeAfterDecision,
  type PolicyStepDefinition,
  type ResolutionContext,
} from './approval';

/** The report's own example chain: Manager -> Finance -> Director above 50k. */
const POLICY: PolicyStepDefinition[] = [
  { sequence: 1, name: 'Manager', approverType: 'MANAGER' },
  { sequence: 2, name: 'Finance', approverType: 'ROLE', approverRoleKey: 'finance' },
  {
    sequence: 3,
    name: 'Director',
    approverType: 'SPECIFIC_USER',
    approverEmployeeId: 'director',
    minAmount: 50000,
  },
];

const CONTEXT: ResolutionContext = {
  requesterId: 'employee',
  managerId: 'manager',
  departmentHeadId: 'head',
  amount: 2000,
};

const actionable = (steps: ReturnType<typeof materializeSteps>) =>
  steps.filter((s) => s.status === 'PENDING');

describe('materializeSteps — threshold routing (Section 13.2)', () => {
  it('skips the director for a small claim', () => {
    const steps = materializeSteps(POLICY, { ...CONTEXT, amount: 2000 });
    const director = steps.find((s) => s.name === 'Director')!;
    expect(director.status).toBe('SKIPPED');
    expect(director.skipReason).toMatch(/threshold/);
    expect(actionable(steps).map((s) => s.name)).toEqual(['Manager', 'Finance']);
  });

  it('includes the director for a large claim', () => {
    const steps = materializeSteps(POLICY, { ...CONTEXT, amount: 75000 });
    expect(actionable(steps).map((s) => s.name)).toEqual(['Manager', 'Finance', 'Director']);
  });

  it('includes the step exactly at the threshold', () => {
    // >= not >. A policy saying "director above 50000" that skipped exactly
    // 50000 would be an off-by-one on a control.
    const steps = materializeSteps(POLICY, { ...CONTEXT, amount: 50000 });
    expect(steps.find((s) => s.name === 'Director')!.status).toBe('PENDING');
  });

  it('skips threshold steps when no amount applies', () => {
    // Leave has no amount, so a money threshold cannot be met.
    const steps = materializeSteps(POLICY, { ...CONTEXT, amount: null });
    expect(steps.find((s) => s.name === 'Director')!.status).toBe('SKIPPED');
  });
});

describe('materializeSteps — approver resolution', () => {
  it('resolves the manager from the requester', () => {
    const steps = materializeSteps(POLICY, CONTEXT);
    expect(steps[0]!.approverEmployeeId).toBe('manager');
  });

  it('leaves a ROLE step unassigned so any holder can decide', () => {
    // Pinning one finance person at submission time creates a bottleneck the
    // moment they go on leave.
    const finance = materializeSteps(POLICY, CONTEXT).find((s) => s.name === 'Finance')!;
    expect(finance.approverEmployeeId).toBeNull();
    expect(finance.approverRoleKey).toBe('finance');
    expect(finance.status).toBe('PENDING');
  });

  it('resolves the department head', () => {
    const steps = materializeSteps(
      [{ sequence: 1, name: 'Head', approverType: 'DEPARTMENT_HEAD' }],
      CONTEXT,
    );
    expect(steps[0]!.approverEmployeeId).toBe('head');
  });

  it('skips a manager step when the requester has no manager', () => {
    // Leaving it pending would mean a request nobody can ever act on.
    const steps = materializeSteps(POLICY, { ...CONTEXT, managerId: null });
    expect(steps[0]!.status).toBe('SKIPPED');
    expect(steps[0]!.skipReason).toMatch(/no manager/i);
  });

  it('skips a department-head step when the department has no head', () => {
    const steps = materializeSteps(
      [{ sequence: 1, name: 'Head', approverType: 'DEPARTMENT_HEAD' }],
      { ...CONTEXT, departmentHeadId: null },
    );
    expect(steps[0]!.status).toBe('SKIPPED');
  });

  it('skips a SPECIFIC_USER step with nobody named', () => {
    const steps = materializeSteps(
      [{ sequence: 1, name: 'Named', approverType: 'SPECIFIC_USER' }],
      CONTEXT,
    );
    expect(steps[0]!.status).toBe('SKIPPED');
  });
});

describe('materializeSteps — self-approval', () => {
  it('never lets the requester approve their own request', () => {
    // A manager filing their own expense must not approve it just because the
    // policy says "the requester's manager".
    const steps = materializeSteps(POLICY, { ...CONTEXT, managerId: 'employee' });
    expect(steps[0]!.status).toBe('SKIPPED');
    expect(steps[0]!.skipReason).toMatch(/requester/i);
  });

  it('holds even when the requester is named directly on the policy', () => {
    const steps = materializeSteps(
      [
        {
          sequence: 1,
          name: 'Named',
          approverType: 'SPECIFIC_USER',
          approverEmployeeId: 'employee',
        },
      ],
      CONTEXT,
    );
    expect(steps[0]!.status).toBe('SKIPPED');
  });

  it('never produces an actionable step assigned to the requester', () => {
    // Property-style: whatever the context, no PENDING step may name the
    // requester as its approver.
    const contexts: ResolutionContext[] = [
      CONTEXT,
      { ...CONTEXT, managerId: 'employee' },
      { ...CONTEXT, departmentHeadId: 'employee' },
      { ...CONTEXT, managerId: 'employee', departmentHeadId: 'employee', amount: 99999 },
    ];
    const policy: PolicyStepDefinition[] = [
      { sequence: 1, name: 'Manager', approverType: 'MANAGER' },
      { sequence: 2, name: 'Head', approverType: 'DEPARTMENT_HEAD' },
      {
        sequence: 3,
        name: 'Named',
        approverType: 'SPECIFIC_USER',
        approverEmployeeId: 'employee',
      },
    ];
    for (const context of contexts) {
      for (const step of actionable(materializeSteps(policy, context))) {
        expect(step.approverEmployeeId).not.toBe(context.requesterId);
      }
    }
  });
});

describe('materializeSteps — consecutive duplicates', () => {
  it('asks the same person once when they fill two steps in a row', () => {
    // Common in small companies: the manager IS the department head.
    const steps = materializeSteps(
      [
        { sequence: 1, name: 'Manager', approverType: 'MANAGER' },
        { sequence: 2, name: 'Head', approverType: 'DEPARTMENT_HEAD' },
      ],
      { ...CONTEXT, managerId: 'boss', departmentHeadId: 'boss' },
    );
    expect(actionable(steps)).toHaveLength(1);
    expect(steps[1]!.skipReason).toMatch(/same approver/i);
  });

  it('still asks twice when someone reappears after another approver', () => {
    // A -> B -> A is a genuine second look, not a duplicate.
    const steps = materializeSteps(
      [
        { sequence: 1, name: 'One', approverType: 'SPECIFIC_USER', approverEmployeeId: 'a' },
        { sequence: 2, name: 'Two', approverType: 'SPECIFIC_USER', approverEmployeeId: 'b' },
        { sequence: 3, name: 'Three', approverType: 'SPECIFIC_USER', approverEmployeeId: 'a' },
      ],
      CONTEXT,
    );
    expect(actionable(steps)).toHaveLength(3);
  });

  it('compares against the last actionable step, not the last skipped one', () => {
    const steps = materializeSteps(
      [
        { sequence: 1, name: 'One', approverType: 'SPECIFIC_USER', approverEmployeeId: 'a' },
        { sequence: 2, name: 'Skipped', approverType: 'MANAGER' },
        { sequence: 3, name: 'Three', approverType: 'SPECIFIC_USER', approverEmployeeId: 'a' },
      ],
      { ...CONTEXT, managerId: null },
    );
    // Step 3 duplicates step 1 across a skip, so it is still a duplicate.
    expect(actionable(steps).map((s) => s.name)).toEqual(['One']);
  });

  it('preserves sequence numbers even when steps are skipped', () => {
    const steps = materializeSteps(POLICY, { ...CONTEXT, managerId: null });
    expect(steps.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });
});

describe('nextPendingStep and outcomeAfterDecision', () => {
  const steps = (...statuses: string[]) =>
    statuses.map((status, i) => ({ sequence: i + 1, status }));

  it('picks the lowest pending sequence', () => {
    expect(nextPendingStep(steps('APPROVED', 'PENDING', 'PENDING'))!.sequence).toBe(2);
  });

  it('ignores skipped steps', () => {
    expect(nextPendingStep(steps('APPROVED', 'SKIPPED', 'PENDING'))!.sequence).toBe(3);
  });

  it('returns null when nothing is pending', () => {
    expect(nextPendingStep(steps('APPROVED', 'SKIPPED'))).toBeNull();
  });

  it('approves once every step is resolved', () => {
    expect(outcomeAfterDecision(steps('APPROVED', 'SKIPPED', 'APPROVED'))).toBe('APPROVED');
  });

  it('stays pending while a step remains', () => {
    expect(outcomeAfterDecision(steps('APPROVED', 'PENDING'))).toBe('PENDING');
  });

  it('rejects the whole request on a single rejection', () => {
    // Chains are conjunctive: there is nothing to gain by asking the rest.
    expect(outcomeAfterDecision(steps('APPROVED', 'REJECTED', 'PENDING'))).toBe('REJECTED');
  });

  it('approves immediately when every step was skipped', () => {
    // A policy that resolves to nothing actionable must not leave the request
    // stuck forever.
    expect(outcomeAfterDecision(steps('SKIPPED', 'SKIPPED'))).toBe('APPROVED');
  });
});

describe('state machines', () => {
  it('treats an approval decision as final', () => {
    for (const terminal of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      expect(approvalStateMachine.isTerminal(terminal), terminal).toBe(true);
    }
  });

  it('lets a rejected expense be corrected and resubmitted', () => {
    expect(expenseStateMachine.canTransition('REJECTED', 'DRAFT')).toBe(true);
    expect(expenseStateMachine.canTransition('DRAFT', 'SUBMITTED')).toBe(true);
  });

  it('makes reimbursement terminal', () => {
    // Money moved. Reversing it is a new transaction, not a status change.
    expect(expenseStateMachine.isTerminal('REIMBURSED')).toBe(true);
  });

  it('refuses to reimburse an unapproved expense', () => {
    expect(expenseStateMachine.canTransition('SUBMITTED', 'REIMBURSED')).toBe(false);
    expect(expenseStateMachine.canTransition('DRAFT', 'REIMBURSED')).toBe(false);
  });

  it('allows approved leave to be cancelled so the balance can be refunded', () => {
    expect(leaveStateMachine.canTransition('APPROVED', 'CANCELLED')).toBe(true);
  });

  it('refuses to approve leave that was never submitted', () => {
    expect(leaveStateMachine.canTransition('DRAFT', 'APPROVED')).toBe(false);
  });
});
