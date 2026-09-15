import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionStateMachine,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  ACTIVE_STATES,
} from '../../src/domain/state-machine.js';
import { InvalidStateTransitionError } from '../../src/domain/errors.js';
import type { ExecutionStatus } from '../../src/types/execution.js';

describe('ExecutionStateMachine', () => {
  test('initializes with STARTING by default', () => {
    const sm = new ExecutionStateMachine();
    assert.equal(sm.currentStatus, 'STARTING');
    assert.equal(sm.isActive(), true);
    assert.equal(sm.isTerminal(), false);
    assert.equal(sm.transitions.length, 0);
  });

  test('initializes with custom status and existing transitions', () => {
    const initialTransition = {
      from: 'STARTING' as ExecutionStatus,
      to: 'RUNNING' as ExecutionStatus,
      timestamp: Date.now(),
      reason: 'Started',
      actor: 'system' as const,
    };
    const sm = new ExecutionStateMachine('RUNNING', [initialTransition]);
    assert.equal(sm.currentStatus, 'RUNNING');
    assert.equal(sm.transitions.length, 1);
    assert.deepEqual(sm.transitions[0], initialTransition);
  });

  test('validates all declared valid transitions', () => {
    const allStates: ExecutionStatus[] = [
      'STARTING',
      'RUNNING',
      'WAITING',
      'PAUSED',
      'TAKEN_OVER',
      'BLOCKED',
      'HANDOFF_PENDING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ];

    for (const fromState of allStates) {
      const allowed = VALID_TRANSITIONS[fromState];
      for (const toState of allStates) {
        const sm = new ExecutionStateMachine(fromState);
        const shouldBeAllowed = allowed.has(toState);
        assert.equal(
          sm.canTransitionTo(toState),
          shouldBeAllowed,
          `Expected transition from ${fromState} to ${toState} to be ${shouldBeAllowed}`,
        );

        if (shouldBeAllowed) {
          const rec = sm.transition(toState, {
            reason: `Testing ${fromState} -> ${toState}`,
            actor: 'system',
          });
          assert.equal(sm.currentStatus, toState);
          assert.equal(rec.from, fromState);
          assert.equal(rec.to, toState);
          assert.equal(rec.reason, `Testing ${fromState} -> ${toState}`);
        } else {
          assert.throws(
            () => sm.transition(toState),
            InvalidStateTransitionError,
            `Expected invalid transition from ${fromState} to ${toState} to throw InvalidStateTransitionError`,
          );
        }
      }
    }
  });

  test('terminal states correctly report isTerminal() and allow no transitions', () => {
    for (const terminal of TERMINAL_STATES) {
      const sm = new ExecutionStateMachine(terminal);
      assert.equal(sm.isTerminal(), true);
      assert.equal(sm.isActive(), false);
      assert.equal(sm.getValidNextStates().length, 0);

      for (const target of ['STARTING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED'] as ExecutionStatus[]) {
        assert.throws(() => sm.transition(target), InvalidStateTransitionError);
      }
    }
  });

  test('active states correctly report isActive()', () => {
    for (const active of ACTIVE_STATES) {
      const sm = new ExecutionStateMachine(active);
      assert.equal(sm.isActive(), true);
      assert.equal(sm.isTerminal(), false);
    }
  });

  test('transition records include timestamps and metadata', () => {
    const sm = new ExecutionStateMachine('STARTING');
    const now = 1720000000000;
    const rec = sm.transition('RUNNING', {
      executionId: 'exec-123',
      reason: 'User command',
      actor: 'human',
      timestamp: now,
      metadata: { initiatedBy: 'CLI' },
    });

    assert.equal(rec.from, 'STARTING');
    assert.equal(rec.to, 'RUNNING');
    assert.equal(rec.timestamp, now);
    assert.equal(rec.actor, 'human');
    assert.deepEqual(rec.metadata, { initiatedBy: 'CLI' });
    assert.equal(sm.transitions.length, 1);
  });
});
