import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Execution } from '../../src/domain/execution.js';
import { ExecutionTerminatedError, InvalidStateTransitionError } from '../../src/domain/errors.js';

describe('Execution Aggregate', () => {
  test('creates a new execution with default fields', () => {
    const exec = Execution.create({
      goal: 'Refactor database models',
      workspaceRoot: '/tmp/workspace',
      constraints: ['No breaking changes', 'Write unit tests'],
      agent: { id: 'agent-1', model: 'deepseek-coder' },
    });

    assert.ok(exec.id.startsWith('exec-'));
    assert.equal(exec.goal, 'Refactor database models');
    assert.equal(exec.status, 'STARTING');
    assert.deepEqual(exec.constraints, ['No breaking changes', 'Write unit tests']);
    assert.equal(exec.agent.id, 'agent-1');
    assert.equal(exec.agent.model, 'deepseek-coder');
    assert.equal(exec.workspace.root, '/tmp/workspace');
    assert.equal(exec.metrics.toolCallCount, 0);
    assert.equal(exec.completedWork.length, 0);
    assert.equal(exec.interventions.length, 0);
    assert.equal(exec.isActive(), true);
    assert.equal(exec.isTerminal(), false);
  });

  test('executes complete start -> pause -> resume -> complete lifecycle', () => {
    const exec = Execution.create({
      goal: 'Implement payment gateway',
      workspaceRoot: '/workspace',
    });

    assert.equal(exec.status, 'STARTING');
    exec.start();
    assert.equal(exec.status, 'RUNNING');
    assert.ok(exec.timestamps.startedAt !== undefined);

    exec.recordToolCall();
    exec.recordFileChange('src/payment.ts', 'created');
    exec.addCompletedWork('Created payment service interface');

    exec.pause('Need security review', 'policy');
    assert.equal(exec.status, 'PAUSED');

    exec.resume('Security review approved', 'human');
    assert.equal(exec.status, 'RUNNING');

    exec.recordToolCall();
    exec.complete('Payment gateway integrated');
    assert.equal(exec.status, 'COMPLETED');
    assert.equal(exec.isTerminal(), true);
    assert.ok(exec.timestamps.completedAt !== undefined);
  });

  test('takeover and continue flow records interventions and reconciles files', () => {
    const exec = Execution.create({
      goal: 'Fix authentication bug',
      workspaceRoot: '/workspace',
    });

    exec.start();
    assert.equal(exec.status, 'RUNNING');

    // Human takes over
    exec.takeOver('senior-dev', 'Manual debugging required in session token parser');
    assert.equal(exec.status, 'TAKEN_OVER');
    assert.equal(exec.interventions.length, 1);
    assert.equal(exec.interventions[0].type, 'take_over');
    assert.equal(exec.interventions[0].actor, 'senior-dev');
    assert.equal(exec.metrics.interventionCount, 1);

    // Human returns control with modified files
    exec.continueFromTakeOver('senior-dev', 'Patched jwt validation, continue with tests', [
      'src/auth/token.ts',
    ]);
    assert.equal(exec.status, 'RUNNING');
    assert.equal(exec.interventions.length, 2);
    assert.equal(exec.interventions[1].type, 'continue');
    assert.ok(exec.workspace.filesModified.includes('src/auth/token.ts'));
    assert.equal(exec.metrics.filesChangedCount, 1);
  });

  test('prevents operations on terminated executions', () => {
    const exec = Execution.create({
      goal: 'Test terminal state enforcement',
      workspaceRoot: '/workspace',
    });

    exec.start();
    exec.cancel('User requested abort', 'human');
    assert.equal(exec.status, 'CANCELLED');
    assert.equal(exec.isTerminal(), true);

    assert.throws(() => exec.pause(), ExecutionTerminatedError);
    assert.throws(() => exec.resume(), ExecutionTerminatedError);
    assert.throws(() => exec.takeOver(), ExecutionTerminatedError);
    assert.throws(() => exec.complete(), ExecutionTerminatedError);
    assert.throws(() => exec.fail('error'), ExecutionTerminatedError);
  });

  test('serializes to state and reconstructs accurately', () => {
    const exec = Execution.create({
      goal: 'Build data pipeline',
      workspaceRoot: '/workspace',
      constraints: ['Use SQLite'],
    });

    exec.start();
    exec.recordToolCall();
    exec.recordFileChange('pipeline.ts', 'created');
    exec.addRisk('High memory usage on large datasets');
    exec.addCompletedWork('Scaffolded pipeline structure');
    exec.setPhase('data-ingestion');

    const state = exec.toState();
    const reconstructed = new Execution(state);

    assert.equal(reconstructed.id, exec.id);
    assert.equal(reconstructed.goal, exec.goal);
    assert.equal(reconstructed.status, exec.status);
    assert.equal(reconstructed.currentPhase, 'data-ingestion');
    assert.deepEqual(reconstructed.completedWork, ['Scaffolded pipeline structure']);
    assert.deepEqual(reconstructed.risks, ['High memory usage on large datasets']);
    assert.equal(reconstructed.metrics.toolCallCount, 1);
    assert.equal(reconstructed.transitions.length, exec.transitions.length);
  });
});
