import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { SqliteDelegationRepository } from '../../src/storage/delegation-repository.js';
import { DecisionQueue } from '../../src/decision/decision-queue.js';
import { DelegationService } from '../../src/delegation/delegation-service.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';
import { buildAttentionModel } from '../../src/attention/attention-orchestrator.js';
import { DEFAULT_POLICY_RULES } from '../../src/policy/policy-engine.js';
import { approvalSubject } from '../../src/policy/approval-subject.js';
import { explainNonInterruption, autonomousHighlights } from '../../src/attention/non-interruption-why.js';
import { ConductorBridge } from '../../src/dsh/conductor-bridge.js';
import type { Execution } from '../../src/domain/execution.js';
import type { ConductorEvent } from '../../src/types/event.js';

const T0 = 1_700_000_000_000;
const M = 60_000;

function runtime() {
  const db = new ConductorDatabase({ path: ':memory:' });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const delegationRepo = new SqliteDelegationRepository(db);
  const delegations = new DelegationService({ delegationRepo, decisionRepo });
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  manager.delegations = delegations;
  return { db, execRepo, eventRepo, decisionRepo, delegationRepo, delegations, decisions, manager };
}

function exec(r: ReturnType<typeof runtime>, agent: string, goal = 'g'): Execution {
  const e = r.manager.createExecution({ goal, workspaceRoot: '/srv', agent: { id: agent } });
  e.start();
  r.execRepo.save(e);
  return e;
}

function gate(r: ReturnType<typeof runtime>, execId: string, callId: string, command: string): void {
  for (const evt of EventAdapter.adaptToolCall(execId, { callId, name: 'bash', arguments: { command } })) {
    r.manager.processEvent(evt);
  }
}

function loadModel(r: ReturnType<typeof runtime>, now = Date.now()) {
  const executions = r.execRepo.list({});
  const decisions = r.decisionRepo.list({});
  const events = executions.flatMap((e) => r.eventRepo.listByExecution(e.id, { limit: 300 }));
  return buildAttentionModel({ executions, decisions, events, now });
}

describe('Attention model — multi-agent fleet view', () => {
  test('five agents, three problems: ordered attention, honest map', () => {
    const r = runtime();
    const a = exec(r, 'atlas', 'payments migration');
    const b = exec(r, 'hera', 'api refactor');
    const c = exec(r, 'nova', 'docs sweep');
    exec(r, 'orion', 'test coverage');
    exec(r, 'vesta', 'lint cleanup');

    // atlas: critical force-push gate;  hera: major install gate;  nova: benign
    gate(r, a.id, 'a1', 'git push --force origin main');
    gate(r, b.id, 'b1', 'pnpm add zod');
    for (const evt of EventAdapter.adaptToolCall(c.id, { callId: 'c1', name: 'bash', arguments: { command: 'pnpm test' } })) {
      r.manager.processEvent(evt);
    }

    const model = loadModel(r);
    assert.equal(model.map.agents, 5);
    assert.equal(model.items.filter((i) => i.kind === 'decision').length, 2);
    assert.equal(model.items[0]!.category, 'approval', 'critical force-push first');
    assert.equal(model.items[0]!.disposition, 'critical');
    assert.match(model.items[0]!.executionId, new RegExp(a.id), 'belongs to atlas');

    // budget: force-push is critical (immune); the install was an interrupt
    // → exactly one "needs you now" beyond criticals; install queued/demoted
    assert.equal(model.map.needsYou, 1, 'only the critical holds the front');
    assert.equal(model.map.waiting, 1, 'the other decision waits durably');
    assert.ok(model.items[1]!.whyWaiting, 'waiting explains itself');
    assert.ok(['queue', 'interrupt'].includes(model.items[1]!.disposition));
    assert.ok(model.map.working >= 2, 'healthy agents counted working');
    assert.ok(['HIGH', 'OVERLOADED'].includes(model.map.load.level));
    assert.ok(model.map.load.reasons.length >= 1);

    // deterministic: same rows, same now → same order
    const again = loadModel(r, model.generatedAt);
    assert.deepEqual(again.items.map((i) => i.id), model.items.map((i) => i.id));
    r.db.close();
  });

  test('one agent cannot starve another: aging reorders equal tiers', () => {
    const r = runtime();
    const a = exec(r, 'atlas');
    const b = exec(r, 'hera');
    gate(r, a.id, 'a1', 'pnpm add left-pad');
    // age a's decision artificially
    const older = r.decisionRepo.list({ status: 'pending' })[0]!;
    older.createdAt = T0;
    r.decisionRepo.save(older);
    gate(r, b.id, 'b1', 'pnpm add zod');
    const model = loadModel(r, T0 + 30 * M);
    assert.equal(model.items[0]!.refIds[0], older.id, 'oldest equal-tier decision leads');
    r.db.close();
  });

  test('completed executions leave the active attention model', () => {
    const r = runtime();
    const a = exec(r, 'atlas');
    r.manager.processEvent(EventAdapter.createEvent(a.id, 'execution.completed', { summary: 'done' }));
    const model = loadModel(r);
    assert.equal(model.map.working, 0);
    assert.equal(model.map.finished, 1);
    assert.equal(model.items.filter((i) => i.disposition === 'interrupt' || i.disposition === 'critical').length, 0);
    r.db.close();
  });
});

describe('Away semantics — honest and self-clearing', () => {
  test('mark_away queues interrupts; answering anything ends the away window', () => {
    const r = runtime();
    const a = exec(r, 'atlas');
    const b = exec(r, 'hera');
    const c = exec(r, 'nova');
    const awayAt = Date.now();
    r.eventRepo.save({
      id: 'evt-away-1', executionId: a.id, type: 'human.intervention',
      timestamp: awayAt, payload: { action: 'mark_away' }, source: 'human',
    } as ConductorEvent);
    gate(r, b.id, 'aw-b', 'pnpm add left-pad');
    gate(r, c.id, 'aw-c', 'pnpm add zod');
    const modelAway = loadModel(r);
    const itemsAway = modelAway.items.filter((i) => i.kind === 'decision');
    assert.equal(itemsAway.length, 2);
    assert.ok(itemsAway.every((i) => i.disposition === 'queue' || i.disposition === 'surface'),
      'away: nobody is interrupted');
    assert.ok(modelAway.map.needsYou === 0);

    // The human answers ONE decision — that is presence, away must clear.
    const first = r.decisions.pending()[0]!;
    r.decisions.resolve(first.id, 'accepted', { answerBy: 'dev' });
    while (Date.now() <= awayAt) { /* cross the clock boundary */ }
    const modelBack = loadModel(r);
    const still = modelBack.items.find((i) => i.kind === 'decision' && i.disposition === 'interrupt');
    assert.ok(still, 'the remaining decision interrupts again once the human is back');
    assert.equal(modelBack.map.needsYou, 1);
    r.db.close();
  });
});

describe('Delegation — explicit entrustment, denial still king', () => {
  test('covered action runs without interruption and leaves forensic trail', () => {
    const r = runtime();
    const a = exec(r, 'atlas');
    r.delegations.grant({ scope: 'workspace', category: 'dependencies', grantedBy: 'shubham' }, T0);

    gate(r, a.id, 'x1', 'pnpm add ioredis@5');
    assert.equal(r.execRepo.findById(a.id)!.status, 'RUNNING', 'no pause');
    assert.equal(r.decisions.pending().length, 0, 'no interruption created');
    const delegated = r.eventRepo.listByExecution(a.id, {}).filter((e) => e.type === 'policy.delegated');
    assert.ok(delegated.length >= 1, 'tool.called + command.started each leave one forensic row');
    assert.match(String(delegated[0]!.payload.command), /pnpm add ioredis/);
    assert.ok(delegated[0]!.payload.delegationId);
    r.db.close();
  });

  test('unrelated categories are unaffected; scope binds; expiry ends it', () => {
    const r = runtime();
    const a = exec(r, 'atlas');
    const b = exec(r, 'hera');
    r.delegations.grant({ scope: 'execution', executionId: a.id, category: 'dependencies', grantedBy: 'dev' }, T0);
    gate(r, b.id, 'y1', 'pnpm add zod');
    assert.equal(r.decisions.pending().length, 1, 'other execution NOT covered by scoped delegation');

    const r2 = runtime();
    const c = exec(r2, 'nova');
    r2.delegations.grant({ scope: 'workspace', category: 'dependencies', grantedBy: 'dev', ttlMs: 1000 }, T0);
    const later = T0 + 5000;
    assert.equal(r2.delegations.covers({ executionId: c.id, category: 'dependencies', now: later }), null, 'expired delegation stops applying');
    gate(r2, c.id, 'z1', 'pnpm add left-pad');
    assert.equal(r2.decisions.pending().length, 1, 'expired: interrupts again');
    r.db.close(); r2.db.close();
  });

  test('explicit denial shadows delegation for that subject; later approval clears', () => {
    const r = runtime();
    const b = exec(r, 'hera');
    // no delegation yet: gate creates a decision, developer DENIES it now.
    gate(r, b.id, 'w0', 'kubectl delete ns staging');
    const subject = approvalSubject('bash', { command: 'kubectl delete ns staging' });
    const d = r.decisions.pending().find((x) => x.subject === subject)!;
    const denied = r.decisions.resolve(d.id, 'rejected', { answerBy: 'dev' });
    const deniedAt = denied.resolution!.resolvedAt; // real clock

    // Only after the denial does the human grant a workspace delegation.
    r.delegations.grant({ scope: 'workspace', category: 'deployment', grantedBy: 'dev' }, deniedAt + 60_000);

    // Delegation predates nothing relevant: the denial is older than the
    // grant, so the delegation applies to the next identical action.
    assert.ok(
      r.delegations.covers({ executionId: b.id, category: 'deployment', subject, resource: 'kubectl delete ns staging', now: deniedAt + 120_000 }),
      'grant after denial applies',
    );

    // Current authority demo: the human DENIES again while the delegation
    // stands → newest verdict is a rejection after the grant → shadowed.
    const pendingAfter = r.decisions.pending().length; // unchanged (covered → no pause)
    assert.equal(pendingAfter, 0);
    const newer = { ...denied, id: `${denied.id}-again`, createdAt: deniedAt + 10, status: 'rejected' as const,
      resolution: { ...denied.resolution!, status: 'rejected' as const, resolvedAt: deniedAt + 200_000 } };
    r.decisionRepo.save(newer);
    assert.equal(
      r.delegations.covers({ executionId: b.id, category: 'deployment', subject, resource: 'kubectl delete ns staging', now: deniedAt + 300_000 }),
      null,
      'denial newer than the grant shadows the delegation — explicit human authority wins',
    );

    // and a subsequent explicit approval lifts the shadow again
    r.decisionRepo.save({ ...newer, status: 'accepted', resolution: { ...newer.resolution!, status: 'accepted', resolvedAt: deniedAt + 400_000 } });
    assert.ok(r.delegations.covers({ executionId: b.id, category: 'deployment', subject, now: deniedAt + 500_000 }));
    r.db.close();
  });

  test('grant validation and revocation audit', () => {
    const r = runtime();
    assert.throws(() => r.delegations.grant({ scope: 'execution', category: 'dependencies', grantedBy: 'x' } as never));
    assert.throws(() => r.delegations.grant({ scope: 'workspace', category: 'dependencies', grantedBy: '' }));
    const d = r.delegations.grant({ scope: 'workspace', category: 'git', grantedBy: 'dev', note: 'solo repo' });
    r.delegations.revoke(d.id, 'dev', T0 + M);
    const stored = r.delegationRepo.findById(d.id)!;
    assert.equal(stored.revokedBy, 'dev');
    assert.ok(stored.revokedAt);
    assert.equal(r.delegations.list({ active: true, now: T0 + 2 * M }).length, 0, 'revoked stops applying');
    assert.equal(r.delegations.list().length, 1, 'row remains for audit');
    r.db.close();
  });

  test('decision memory surfaces offers but never grants itself', () => {
    const r = runtime();
    const a = exec(r, 'atlas');
    const ruleCat = new Map(DEFAULT_POLICY_RULES.map((x) => [x.id, x.category]));
    // approve two install decisions
    for (const [cid, cmd] of [['p1', 'pnpm add a'], ['p2', 'pnpm add b']] as const) {
      // temporarily without delegation: gates create decisions
      gate(r, a.id, cid, cmd);
      const d = r.decisions.pending()[0]!;
      r.decisions.resolve(d.id, 'accepted', { answerBy: 'dev' });
    }
    const suggestions = r.delegations.suggestions({
      decisions: r.decisionRepo.list({}),
      ruleCategory: (id) => ruleCat.get(id),
    });
    const dep = suggestions.find((x) => x.category === 'dependencies');
    assert.ok(dep, 'recurrence recognized');
    assert.equal(dep.accepted, 2);
    assert.match(dep.offer, /Delegate future dependencies actions\?/);
    assert.equal(r.delegations.list({ active: true }).length, 0, 'nothing auto-granted');
    r.db.close();
  });
});

describe('"Why didn\'t you interrupt me?" — derived from persisted facts', () => {
  test('allowed routine command explains itself', () => {
    const r = runtime();
    const a = exec(r, 'atlas');
    for (const evt of EventAdapter.adaptToolCall(a.id, { callId: 'k1', name: 'bash', arguments: { command: 'pnpm test' } })) {
      r.manager.processEvent(evt);
    }
    const toolEvent = r.eventRepo.listByExecution(a.id, {}).find((e) => e.type === 'tool.called')!;
    const w = explainNonInterruption(toolEvent, { policy: r.manager.policyEngine });
    assert.match(w.action, /pnpm test/);
    assert.ok(w.allowedBecause.some((x) => /policy permits/.test(x)));
    assert.ok(w.allowedBecause.some((x) => /reversible|classified/.test(x)));
    assert.equal(w.attentionSaved, 'not measured');
    assert.equal(w.delegatedBy, null);
    r.db.close();
  });

  test('delegated action cites the delegation', () => {
    const r = runtime();
    const a = exec(r, 'atlas');
    const d = r.delegations.grant({ scope: 'workspace', category: 'dependencies', grantedBy: 'shubham' }, T0);
    gate(r, a.id, 'm1', 'pnpm add ioredis');
    const del = r.eventRepo.listByExecution(a.id, {}).find((e) => e.type === 'policy.delegated')!;
    const w = explainNonInterruption(del, { delegation: d });
    assert.ok(w.delegatedBy);
    assert.equal(w.delegatedBy!.id, d.id);
    assert.ok(w.allowedBecause.some((x) => /you delegated/.test(x)));
    assert.ok(autonomousHighlights(r.eventRepo.listByExecution(a.id, {})).some((e: ConductorEvent) => e.type === 'policy.delegated'));
    r.db.close();
  });
});

describe('Bridge honors delegation at the gate', () => {
  test('covered tool executes (undefined); without cover it denies; denial wins', () => {
    const r = runtime();
    const a = exec(r, 'atlas');
    const bridge = new ConductorBridge({ manager: r.manager, decisions: r.decisions });
    bridge.startExecution('g', { workspaceRoot: '/srv' });
    bridge.bindHostKey(`agent:${a.agent.id}`, a.id);

    const call = { callId: 't1', name: 'bash', arguments: { command: 'pnpm add nx' } };
    r.delegations.grant({ scope: 'workspace', category: 'dependencies', grantedBy: 'dev' }, T0);
    assert.equal(bridge.preToolExecute(call), undefined, 'covered: allowed');
    assert.equal(r.decisions.pending().length, 0);

    assert.equal(bridge.preToolExecute({ callId: 't2', name: 'bash', arguments: { command: 'git push --force origin main' } })!.kind, 'deny', 'non-delegated category still gated');
    r.db.close();
  });
});
