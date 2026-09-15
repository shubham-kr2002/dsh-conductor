import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { DecisionQueue } from '../../src/decision/decision-queue.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';
import { buildAwaySummary, renderAwaySummary } from '../../src/summary/away-mode.js';

function setup() {
  const db = new ConductorDatabase({ path: ':memory:' });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  return { db, manager, decisions, execRepo, eventRepo };
}

function runningExecution(s: ReturnType<typeof setup>, goal = 'ship feature') {
  const exec = s.manager.createExecution({ goal, workspaceRoot: '/srv/app' });
  s.manager.processEvent(
    EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal }),
  );
  return exec;
}

describe('Away mode — quiet autonomous work', () => {
  test('routine progress reports "no action required" and needsYou=false', () => {
    const s = setup();
    const exec = runningExecution(s);

    s.manager.processEvent(
      EventAdapter.createEvent(exec.id, 'file.changed', {
        executionId: exec.id, filePath: 'src/feature.ts', action: 'created',
        toolName: 'write', consequence: 'low', reversibility: 'reversible',
      }),
    );
    s.manager.processEvent(
      EventAdapter.createEvent(exec.id, 'test.passed', { executionId: exec.id, testName: 'feature works' }),
    );
    s.manager.markAway(exec.id);
    s.manager.processEvent(
      EventAdapter.createEvent(exec.id, 'command.started', { executionId: exec.id, command: 'pnpm test' }),
    );
    s.manager.processEvent(
      EventAdapter.createEvent(exec.id, 'command.completed', { executionId: exec.id, command: 'pnpm test', exitCode: 0, durationMs: 200 }),
    );

    const summary = s.manager.getAwaySummary(exec.id);
    assert.equal(summary.needsYou, false);
    assert.match(summary.recommendedNextAction, /autonomously|nothing needs you/i);
    assert.equal(summary.decisionsRequired.length, 0);
    // Only post-away events counted: the two commands, not the earlier file/test events
    assert.equal(summary.failures.length, 0);
    const text = renderAwaySummary(summary);
    assert.match(text, /Agent handled it/);
    s.db.close();
  });
});

describe('Away mode — decision-heavy absence', () => {
  test('pending decisions surface first with urgency; resolved decisions listed separately', () => {
    const s = setup();
    const exec = runningExecution(s);

    // An early decision that the (simulated) human resolved before leaving
    s.manager.processEvent(
      EventAdapter.createEvent(exec.id, 'agent.question', {
        executionId: exec.id, question: 'Early question?', consequence: 'high',
      }),
    );
    const first = s.decisions.pending()[0];
    s.decisions.resolve(first.id, 'accepted');

    s.manager.markAway(exec.id);

    // While away: test failure, then a dangerous operation paused the run
    s.manager.processEvent(
      EventAdapter.createEvent(exec.id, 'test.failed', {
        executionId: exec.id, testName: 'checkout flow', error: 'null pointer',
      }),
    );
    for (const evt of EventAdapter.adaptToolCall(exec.id, {
      callId: 'c1', name: 'bash', arguments: { command: 'terraform destroy -auto-approve' },
    })) {
      s.manager.processEvent(evt);
    }

    const summary = s.manager.getAwaySummary(exec.id);
    assert.equal(summary.needsYou, true);
    assert.equal(summary.status, 'PAUSED');
    assert.ok(summary.decisionsRequired.length >= 1);
    assert.ok(summary.decisionsRequired[0].title.length > 3);
    assert.equal(summary.decisionsResolved.some((d) => d.id === first.id), true);
    assert.ok(summary.failures.some((f) => f.includes('checkout flow')));
    assert.match(summary.recommendedNextAction, /decision/i);
    const text = renderAwaySummary(summary);
    assert.match(text, /NEEDS YOUR ATTENTION/);
    assert.match(text, /terraform destroy/);
    s.db.close();
  });
});

describe('Away mode — window semantics', () => {
  test('away-mark persists across manager instances (CLI processes)', () => {
    const { db, manager, execRepo, eventRepo } = setup();
    const exec = runningExecution({ db, manager, execRepo, eventRepo } as never);
    const ts = manager.markAway(exec.id);
    const execCopy = execRepo.findById(exec.id)!; // an Execution instance
    const events = eventRepo.listByExecution(exec.id);
    db.close();

    // Fresh runtime (like a new CLI invocation) sees the same window start
    const s2 = setup();
    s2.execRepo.save(execCopy);
    for (const evt of events) s2.eventRepo.save(evt);
    const summary2 = s2.manager.getAwaySummary(exec.id);
    assert.equal(summary2.awaySince, ts);
    s2.db.close();
  });

  test('completed executions recommend no action', () => {
    const s = setup();
    const exec = runningExecution(s, 'finish line');
    const stored = s.execRepo.findById(exec.id)!; // the repo instance carries RUNNING
    stored.complete('all done');
    s.execRepo.save(stored);
    const summary = s.manager.getAwaySummary(exec.id);
    assert.match(summary.recommendedNextAction, /finished/i);
    assert.equal(summary.needsYou, false);
    s.db.close();
  });

  test('humanAttentionMinutes reflects the away window', () => {
    const s = setup();
    const exec = runningExecution(s);
    const now = Date.now();
    const summary = buildAwaySummary({
      execution: s.execRepo.findById(exec.id)!,
      events: s.eventRepo.listByExecution(exec.id),
      decisions: [],
      since: now - 20 * 60000, // away 20 minutes
      now,
    });
    assert.equal(summary.humanAttentionMinutes, 20);
    s.db.close();
  });
});
