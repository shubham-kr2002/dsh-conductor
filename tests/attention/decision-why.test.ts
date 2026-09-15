import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { DecisionQueue } from '../../src/decision/decision-queue.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';

function harness() {
  const db = new ConductorDatabase({ path: ':memory:' });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisions = new DecisionQueue(new SqliteDecisionRepository(db), execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  return { db, manager, decisions };
}

function feed(h: { manager: ExecutionManager }, execId: string, toolExec: { callId: string; name: string; arguments: Record<string, unknown> }) {
  for (const evt of EventAdapter.adaptToolCall(execId, toolExec)) h.manager.processEvent(evt);
}

describe('Decision explanation (why) — deterministic seven-field model', () => {
  test('dangerous command decision carries full structured evidence', () => {
    const h = harness();
    const exec = h.manager.createExecution({ goal: 'ship it', workspaceRoot: '/srv/app' });
    exec.start();
    h.manager.executionRepo.save(exec);

    feed(h, exec.id, { callId: 'c1', name: 'bash', arguments: { command: 'git push --force origin main' } });
    const d = h.decisions.pending()[0]!;
    assert.ok(d.why, 'why present');
    assert.match(d.why.what, /git push --force origin main/);
    assert.ok(d.why.whyNow.length > 10, 'whyNow explains the interruption');
    assert.match(d.why.impact, /Critical|Major/);
    assert.ok(['irreversible', 'unknown'].includes(d.why.reversibility));
    assert.ok(d.why.evidence.eventIds.length >= 1);
    assert.ok(d.why.evidence.ruleIds.includes('require-approval-git-force'), 'policy rule id in evidence');
    assert.deepEqual(d.why.evidence.affectedResources, ['git push --force origin main']);
    assert.equal(d.why.evidence.blastRadius, 'external-system');
    assert.equal(d.why.evidence.taskAligned, true);
    assert.ok(d.why.consequences.approve.length > 0 && d.why.consequences.reject.length > 0);

    // round-trips through SQLite intact
    const reloaded = h.decisions.get(d.id);
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.why)), JSON.parse(JSON.stringify(d.why)));
    h.db.close();
  });

  test('dependency install is gated and explains itself', () => {
    const h = harness();
    const exec = h.manager.createExecution({ goal: 'upgrade deps', workspaceRoot: '/srv/app' });
    exec.start();
    h.manager.executionRepo.save(exec);

    feed(h, exec.id, { callId: 'c2', name: 'bash', arguments: { command: 'pnpm add ioredis' } });
    const d = h.decisions.pending()[0]!;
    assert.ok(d, 'pnpm add raises a decision');
    assert.ok(d.why!.evidence.ruleIds.includes('require-approval-dependency-install'));
    assert.match(d.why!.impact, /Moderate|Major|Small/);
    assert.equal(d.why!.evidence.blastRadius, 'workspace');
    h.db.close();
  });

  test('agent question decisions explain the question and answer consequences', () => {
    const h = harness();
    const exec = h.manager.createExecution({ goal: 'payments', workspaceRoot: '/srv/p' });
    exec.start();
    h.manager.executionRepo.save(exec);

    h.manager.processEvent(
      EventAdapter.createEvent(exec.id, 'agent.question', {
        questionId: 'q1',
        question: 'Drop the legacy payments table and recreate it?',
        consequence: 'high',
      }),
    );
    const d = h.decisions.pending()[0]!;
    assert.ok(d.why);
    assert.match(d.why.what, /Drop the legacy payments table/);
    assert.ok(d.why.whyNow.length > 10);
    assert.equal(d.why.reversibility, 'reversible');
    assert.match(d.why.consequences.approve, /proceeds/i);
    assert.match(d.why.consequences.reject, /without/i);
    assert.ok(d.why.evidence.ambiguity > 0, 'ambiguity recorded from attention input');
    h.db.close();
  });
});
