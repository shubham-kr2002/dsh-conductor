import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { DecisionQueue, decisionPriority } from '../../src/decision/decision-queue.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';
import { DecisionNotFoundError } from '../../src/domain/errors.js';
import type { ConductorDecision } from '../../src/types/decision.js';

function setup() {
  const db = new ConductorDatabase({ path: ':memory:' });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  return { db, execRepo, decisionRepo, decisions, manager };
}

function makeDecision(over: Partial<ConductorDecision> = {}): ConductorDecision {
  return {
    id: `dec-${Math.random().toString(36).slice(2)}`,
    executionId: 'exec-x',
    title: 'Approve git push --force?',
    question: 'The agent wants to force-push.',
    context: 'Phase: ship',
    options: [{ id: 'approve-once', label: 'Approve once' }],
    impact: 'major',
    urgency: 'high',
    confidence: 0.9,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

describe('DecisionQueue — persistence', () => {
  const { db, manager, decisions, decisionRepo } = setup();
  test.after(() => db.close());

  test('creates and reloads a decision with full fidelity', () => {
    const exec = manager.createExecution({ goal: 'persist test', workspaceRoot: '/w' });
    const d = decisions.create({
      executionId: exec.id,
      title: 'Migrate database?',
      question: 'This will rewrite the users table.',
      context: 'Irreversible migration',
      options: [
        { id: 'yes', label: 'Yes', isRecommended: true },
        { id: 'no', label: 'No' },
      ],
      recommendation: 'Yes',
      impact: 'critical',
      urgency: 'high',
      confidence: 0.7,
    });

    const loaded = decisionRepo.findById(d.id);
    assert.ok(loaded);
    assert.equal(loaded.status, 'pending');
    assert.equal(loaded.title, 'Migrate database?');
    assert.equal(loaded.options.length, 2);
    assert.equal(loaded.options[0].isRecommended, true);
  });
});

describe('DecisionQueue — prioritization', () => {
  test('impact dominates urgency, then confidence (ambiguity)', () => {
    const minorLow = makeDecision({ impact: 'minor', urgency: 'low', confidence: 0.1 });
    const critical = makeDecision({ impact: 'critical', urgency: 'low', confidence: 0.9 });
    assert.ok(
      decisionPriority(critical) > decisionPriority(minorLow),
      'critical impact must outrank minor regardless of urgency',
    );

    const hiUrg = makeDecision({ impact: 'major', urgency: 'critical', confidence: 0.9 });
    const loUrg = makeDecision({ impact: 'major', urgency: 'low', confidence: 0.9 });
    assert.ok(decisionPriority(hiUrg) > decisionPriority(loUrg));

    const ambiguous = makeDecision({ impact: 'major', urgency: 'high', confidence: 0.2 });
    const certain = makeDecision({ impact: 'major', urgency: 'high', confidence: 0.95 });
    assert.ok(
      decisionPriority(ambiguous) > decisionPriority(certain),
      'lower-confidence (more ambiguity needing judgment) ranks first',
    );
  });
});

describe('DecisionQueue — accept / reject / custom + auto-resume (Phase 4 acceptance)', () => {
  test('meaningful decision point pauses, human resolves, execution continues', () => {
    const { manager, decisions, db, execRepo } = setup();

    const exec = manager.createExecution({ goal: 'refactor billing', workspaceRoot: '/srv/billing' });
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal: 'x' }),
    );
    assert.equal(manager.getStatus(exec.id).status, 'RUNNING');

    // Agent reaches a consequential, ambiguous decision point (irreversible high consequence)
    const q = EventAdapter.createEvent(exec.id, 'agent.question', {
      question: 'Should I drop the legacy payment table or dual-write?',
      context: 'Dropping is irreversible and affects live customers',
      consequence: 'high',
      options: [
        { id: 'drop', label: 'Drop legacy table' },
        { id: 'dual', label: 'Dual-write and migrate' },
      ],
      recommendedOption: 'Dual-write and migrate',
    });
    // Mark it as irreversible through a tool-like high question by using blocked semantics
    const classification = manager.processEvent(q);
    assert.ok(classification);
    assert.equal(classification.level, 'DECISION');

    const status = manager.getStatus(exec.id);
    assert.equal(status.status, 'PAUSED');
    assert.equal(status.attentionRequired, true);

    // A decision exists in the queue and is listed for the developer
    const pending = decisions.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].question, 'Should I drop the legacy payment table or dual-write?');

    // Human resolves it (custom answer); execution must resume automatically
    const resolved = decisions.resolve(pending[0].id, 'custom', {
      customValue: 'Dual-write, keep legacy for 30 days, then drop',
      answerBy: 'lead-dev',
    });
    assert.equal(resolved.status, 'custom');
    assert.equal(resolved.resolution?.customValue, 'Dual-write, keep legacy for 30 days, then drop');

    const afterResume = manager.getStatus(exec.id);
    assert.equal(afterResume.status, 'RUNNING');
    assert.equal(afterResume.attentionRequired, false);
    assert.equal(decisions.pending().length, 0);

    // The resume transition is persisted and reloads
    const reloaded = execRepo.findById(exec.id);
    assert.ok(reloaded);
    assert.equal(reloaded.status, 'RUNNING');
    assert.ok(reloaded.transitions.some((t) => t.to === 'RUNNING' && t.actor === 'human'));
    db.close();
  });

  test('rejecting keeps other pending decisions holding the pause', () => {
    const { manager, decisions, db } = setup();
    const exec = manager.createExecution({ goal: 'multi-decision', workspaceRoot: '/w' });
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal: 'x' }),
    );
    // Two independent risky questions -> two queued decisions. The first
    // pauses; the second arrives while already PAUSED and still queues.
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'agent.question', {
        question: 'Q1', consequence: 'high', options: [{ id: 'a', label: 'A' }],
      }),
    );
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'agent.question', {
        question: 'Q2', consequence: 'critical', options: [{ id: 'b', label: 'B' }],
      }),
    );

    const pend = decisions.pending();
    assert.equal(pend.length, 2);

    // Resolve only the lowest priority; the execution must remain PAUSED.
    const lowest = pend[pend.length - 1];
    decisions.resolve(lowest.id, 'rejected');
    assert.equal(manager.getStatus(exec.id).status, 'PAUSED');

    // Resolving the last one resumes.
    decisions.resolve(pend[0].id, 'accepted');
    assert.equal(manager.getStatus(exec.id).status, 'RUNNING');
    db.close();
  });

  test('resolving an unknown decision throws DecisionNotFoundError', () => {
    const { decisions } = setup();
    assert.throws(() => decisions.get('dec-missing'), DecisionNotFoundError);
  });

  test('resolution is idempotent — a second answer keeps the first', () => {
    const { manager, decisions, db } = setup();
    const exec = manager.createExecution({ goal: 'idem', workspaceRoot: '/w' });
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal: 'x' }),
    );
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'agent.question', {
        question: 'Irreversible?', consequence: 'high',
      }),
    );
    const id = decisions.pending()[0].id;
    const first = decisions.resolve(id, 'accepted');
    const second = decisions.resolve(id, 'rejected');
    assert.equal(second.resolution?.status, first.resolution?.status);
    db.close();
  });

  test('expired decisions are marked and removed from pending', () => {
    const { manager, decisions, db } = setup();
    const exec = manager.createExecution({ goal: 'exp', workspaceRoot: '/w' });
    const d = decisions.create({
      executionId: exec.id,
      title: 'T',
      question: 'Q',
      context: 'C',
      impact: 'moderate',
      urgency: 'low',
      confidence: 0.5,
      ttlMs: 1, // expires almost immediately
    });
    assert.equal(d.status, 'pending');
    // advance past expiry by waiting a hair
    const start = Date.now();
    while (Date.now() - start < 3) {
      /* busy wait 3ms */
    }
    const expiredCount = decisions.expireStale();
    assert.ok(expiredCount >= 1);
    assert.ok(!decisions.pending().some((x) => x.id === d.id));
    db.close();
  });
});
