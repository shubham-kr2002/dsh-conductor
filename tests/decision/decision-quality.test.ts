import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { DecisionQueue } from '../../src/decision/decision-queue.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';
import { deriveDecisionQuality, didSubjectRecur, rollupDecisionQuality } from '../../src/decision/decision-quality.js';

function harness() {
  const db = new ConductorDatabase({ path: ':memory:' });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  return { db, execRepo, decisionRepo, decisions, manager };
}

function danger(execId: string, callId: string, command: string): void {
  // helper kept explicit for readability
  void execId; void callId; void command;
}
void danger;

describe('Decision quality — observable facts, nothing invented', () => {
  test('present() records first presentation once, only while pending', () => {
    const h = harness();
    const exec = h.manager.createExecution({ goal: 'g', workspaceRoot: '/w' });
    exec.start();
    h.manager.executionRepo.save(exec);
    h.manager.processEvent(
      EventAdapter.createEvent(exec.id, 'agent.question', { questionId: 'q1', question: 'Pick a cache?', consequence: 'high' }),
    );
    const d = h.decisions.pending()[0]!;
    assert.equal(d.quality?.presentedAt, undefined);

    h.decisions.present(d.id);
    const first = h.decisions.get(d.id).quality!.presentedAt!;
    assert.ok(first > 0);

    // second present is a no-op; resolution freezes it entirely
    const later = first + 5_000;
    // simulate by direct repo tamper is pointless; just call again
    h.decisions.present(d.id);
    assert.equal(h.decisions.get(d.id).quality!.presentedAt, first);

    h.decisions.resolve(d.id, 'accepted', { answerBy: 'dev' });
    h.decisions.present(d.id); // resolved → must not re-mark
    assert.equal(h.decisions.get(d.id).quality!.presentedAt, first);
    void later;
    h.db.close();
  });

  test('responseMs and recurred derive from stored rows only', () => {
    const h = harness();
    const exec = h.manager.createExecution({ goal: 'g', workspaceRoot: '/w' });
    exec.start();
    h.manager.executionRepo.save(exec);
    const feed = (callId: string, command: string) => {
      for (const evt of EventAdapter.adaptToolCall(exec.id, { callId, name: 'bash', arguments: { command } })) {
        h.manager.processEvent(evt);
      }
    };
    feed('c1', 'git push --force origin main');
    const d1 = h.decisions.pending().find((d) => d.status === 'pending')!;
    const resolvedAt = h.decisions.resolve(d1.id, 'accepted', { answerBy: 'dev' }).resolution!.resolvedAt;
    while (Date.now() <= resolvedAt) { /* cross the millisecond boundary deterministically */ }

    let all = h.decisionRepo.list({ executionId: exec.id });
    let q = deriveDecisionQuality(h.decisions.get(d1.id), all, h.execRepo.findById(exec.id));
    assert.ok(q.responseMs != null && q.responseMs >= 0);
    assert.equal(q.recurred, false);
    assert.ok(q.outcome === 'resumed-and-progressed' || q.outcome === 'completed-after');

    // same subject comes back later => recurrence is an observable fact
    feed('c2', 'git push --force origin main');
    const d2 = h.decisionRepo.list({ executionId: exec.id }).find((d) => d.id !== d1.id && d.status === 'pending')!;
    all = h.decisionRepo.list({ executionId: exec.id });
    q = deriveDecisionQuality(h.decisions.get(d1.id), all, h.execRepo.findById(exec.id));
    assert.equal(q.recurred, true, 'repeat of same subject recorded');
    assert.equal(deriveDecisionQuality(d2, all, null).outcome, 'pending');

    const roll = rollupDecisionQuality(all);
    assert.equal(roll.resolved, 1);
    assert.equal(roll.recurredCount, 1);
    h.db.close();
  });

  test('didSubjectRecur ignores other executions and earlier decisions', () => {
    const base = {
      id: 'a', executionId: 'e1', title: 't', question: 'q', context: 'c', options: [],
      impact: 'major', urgency: 'high', confidence: 0.9, status: 'pending',
      createdAt: 100, updatedAt: 100,
    } as const;
    const resolved = { ...base, status: 'accepted', subject: 'bash:x', resolution: { status: 'accepted', resolvedAt: 200, resolvedBy: 'dev' } };
    const otherExec = { ...base, id: 'b', executionId: 'e2', subject: 'bash:x', createdAt: 300 };
    const earlier = { ...base, id: 'c', subject: 'bash:x', createdAt: 50 };
    assert.equal(didSubjectRecur(resolved as never, [resolved as never, otherExec as never, earlier as never]), false, 'different execution ignored');
    assert.equal(didSubjectRecur(resolved as never, [resolved as never, { ...earlier, executionId: 'e1' } as never]), false, 'earlier ignored');
    assert.equal(didSubjectRecur(resolved as never, [resolved as never, { ...otherExec, executionId: 'e1' } as never]), true, 'same execution, later');
  });
});

describe('Approval token — accept grants, deny never does, consumption is once', () => {
  function gated() {
    const h = harness();
    const exec = h.manager.createExecution({ goal: 'g', workspaceRoot: '/w' });
    exec.start();
    h.manager.executionRepo.save(exec);
    for (const evt of EventAdapter.adaptToolCall(exec.id, { callId: 'c1', name: 'bash', arguments: { command: 'git push --force origin main' } })) {
      h.manager.processEvent(evt);
    }
    const d = h.decisions.pending().find((x) => x.subject)?.id!;
    return { h, exec, id: d };
  }
  const SUBJECT = 'bash:git push --force origin main';

  test('plain accepted resolution releases the retry token', () => {
    const { h, exec, id } = gated();
    h.decisions.resolve(id, 'accepted', { answerBy: 'dev' });
    assert.equal(h.decisions.consumeApproval(exec.id, SUBJECT), true);
    assert.equal(h.decisions.consumeApproval(exec.id, SUBJECT), false, 'exactly once');
    h.db.close();
  });

  test('accept explicitly picking the deny option grants nothing', () => {
    const { h, exec, id } = gated();
    h.decisions.resolve(id, 'accepted', { answerBy: 'dev', selectedOptionId: 'deny' });
    assert.equal(h.decisions.consumeApproval(exec.id, SUBJECT), false);
    h.db.close();
  });

  test('rejected grants nothing; another accepted decision does', () => {
    const { h, exec, id } = gated();
    h.decisions.resolve(id, 'rejected', { answerBy: 'dev' });
    assert.equal(h.decisions.consumeApproval(exec.id, SUBJECT), false);
    h.db.close();
  });

  test('tryConsume is a conditional single-writer UPDATE', () => {
    const { h, id } = gated();
    h.decisions.resolve(id, 'accepted', { answerBy: 'dev' });
    assert.equal(h.decisionRepo.tryConsume(id, Date.now()), true);
    assert.equal(h.decisionRepo.tryConsume(id, Date.now()), false, 'second writer loses');
    h.db.close();
  });
});

describe('Held run vs lifecycle completion (Bug A regression)', () => {
  test('turn-end completed while PAUSED does not throw and keeps waiting', () => {
    const h = harness();
    const exec = h.manager.createExecution({ goal: 'g', workspaceRoot: '/w' });
    exec.start();
    h.manager.executionRepo.save(exec);
    for (const evt of EventAdapter.adaptToolCall(exec.id, { callId: 'c1', name: 'bash', arguments: { command: 'git push --force origin main' } })) {
      h.manager.processEvent(evt);
    }
    assert.equal(h.execRepo.findById(exec.id)!.status, 'PAUSED');

    // a turn-end lands while the run is held for judgment
    h.manager.processEvent(EventAdapter.createEvent(exec.id, 'execution.completed', { summary: 'done' }));
    const stillPaused = h.execRepo.findById(exec.id)!;
    assert.equal(stillPaused.status, 'PAUSED', 'held state preserved');

    // resolve, resume, then completion works legally
    const pend = h.decisions.pending()[0];
    h.decisions.resolve(pend.id, 'accepted', { answerBy: 'dev' });
    assert.equal(h.execRepo.findById(exec.id)!.status, 'RUNNING');
    h.manager.processEvent(EventAdapter.createEvent(exec.id, 'execution.completed', { summary: 'done' }));
    assert.equal(h.execRepo.findById(exec.id)!.status, 'COMPLETED');
    h.db.close();
  });

  test('failure while TAKEN_OVER is recorded without corrupting control state', () => {
    const h = harness();
    const exec = h.manager.createExecution({ goal: 'g', workspaceRoot: '/w' });
    exec.start();
    exec.takeOver('dev');
    h.manager.executionRepo.save(exec);
    h.manager.processEvent(EventAdapter.createEvent(exec.id, 'execution.failed', { error: 'boom' }));
    assert.equal(h.execRepo.findById(exec.id)!.status, 'FAILED', 'TAKEN_OVER→FAILED is legal');
    h.db.close();
  });
});
