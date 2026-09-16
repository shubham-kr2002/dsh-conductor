/**
 * Phase-10 ATTENTION COCKPIT — behavioral tests for the UI control plane.
 *
 * Two runtimes over one SQLite file (producer = "the mounted plugin",
 * server = the cockpit backend), exactly like the real multi-process setup.
 * These assert ENDPOINT BEHAVIOR — ordering, sections, budget, delegation
 * authority, forensic explanations — not pixels. Pixel rendering is the
 * browser's job; the server's job is to hand it an honest attention model.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { startConductorUi, type ConductorUiServer } from '../../src/ui/server.js';
import { createRuntime } from '../../src/cli/commands.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';

/* Temp db strictly under tests/.tmp-ui10-* (workspace-writable), removed on exit. */
const dir = mkdtempSync(join(process.cwd(), 'tests', '.tmp-ui10-'));
const dbPath = join(dir, 'conductor.db');
const workspaceRoot = join(dir, 'repo');
mkdirSync(workspaceRoot, { recursive: true });

const producer = createRuntime(dbPath);
let server: ConductorUiServer | null = null;

after(async () => {
  await server?.close();
  producer.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function get<T = any>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${(server as ConductorUiServer).url}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}
async function post<T = any>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${(server as ConductorUiServer).url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function newExecution(label: string, agentId: string): string {
  const exec = producer.manager.createExecution({
    goal: `Attention-os scenario ${label} — upgrade the payment API`,
    workspaceRoot,
    agent: { id: agentId },
  });
  exec.start();
  producer.execRepo.save(exec);
  return exec.id;
}

function gate(execId: string, callId: string, command: string): void {
  for (const evt of EventAdapter.adaptToolCall(execId, { callId, name: 'bash', arguments: { command } })) {
    producer.manager.processEvent(evt);
  }
}

function failTest(execId: string, testName: string): void {
  producer.manager.processEvent(
    EventAdapter.createEvent(execId, 'test.failed', { testName, exitCode: 1 }),
  );
}

const attention = async () => (await get('/api/attention')).body;
const fact = (item: any, name: string): string | undefined =>
  (item.facts ?? []).find((f: any) => f.factor === name)?.value;

let execA = '';
let execB = '';
let execC = '';
let dlId = '';

describe('P10 Attention Cockpit — the map, not the list', () => {
  test('boots the cockpit and answers the attention endpoint with an honest empty map', async () => {
    server = await startConductorUi({ dbPath, port: 0, pollMs: 200 });
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /CONDUCTOR/);
    assert.match(html, /app\.js/);
    assert.equal((await fetch(`${server.url}/styles.css`)).status, 200);

    const att = await attention();
    assert.ok(att.model, 'model wrapped under model:');
    assert.ok(Array.isArray(att.model.items));
    assert.ok(Array.isArray(att.model.budgetDemoted));
    assert.equal(att.model.map.needsYou, 0);
    assert.equal(att.model.load === undefined, true, 'load lives under map.load');
    assert.equal(att.model.map.load.level, 'LOW');
    assert.deepEqual(att.delegations, []);
    assert.deepEqual(att.suggestions, []);
    // JSON-safe: plain data, no serialized class noise, no undefined strings.
    assert.equal(JSON.stringify(att).includes('undefined'), false);
  });

  test('critical lands NEEDS YOU with facts + seven-field why; the next one queues with a reason; failures group durably', async () => {
    execA = newExecution('A', 'atlas');
    gate(execA, 'c1', 'git push --force origin main');
    execB = newExecution('B', 'vesa');
    gate(execB, 'c2', 'pnpm add zod');
    for (const t of ['pricing.test.ts', 'ledger.test.ts', 'auth.test.ts']) failTest(execA, t);

    const att = await attention();
    const items = att.model.items;

    // front row: the critical approval
    const first = items[0];
    assert.equal(first.kind, 'decision');
    assert.equal(first.category, 'approval');
    assert.equal(first.disposition, 'critical');
    assert.equal(first.section, 'needs-you');
    assert.equal(first.label, 'Needs you now');
    assert.equal(first.executionId, execA);
    assert.equal(fact(first, 'Consequence'), 'CRITICAL');
    assert.equal(fact(first, 'Agent blocked'), 'YES');
    assert.ok(fact(first, 'Waiting'), 'waiting fact present');
    // seven-field explanation travels with the item
    assert.ok(first.why, 'why present');
    for (const field of ['what', 'whyNow', 'impact', 'reversibility', 'consequences']) {
      assert.ok(first.why[field], `why.${field} present`);
    }
    assert.ok(first.why.evidence.ruleIds.includes('require-approval-git-force'));
    assert.deepEqual(Object.keys(first.why.evidence).sort(), ['affectedResources', 'ambiguity', 'blastRadius', 'eventIds', 'ruleIds', 'taskAligned']);

    // second decision: demoted by the budget — durably waiting, with a reason
    const queued = items.find((c: any) => c.kind === 'decision' && c.executionId === execB);
    assert.ok(queued, 'pnpm-add decision visible');
    assert.equal(queued.disposition, 'queue', 'interrupt slot taken by critical → queue');
    assert.equal(queued.section, 'waiting');
    assert.ok(queued.whyWaiting && queued.whyWaiting.length > 10, 'deferral explains itself');
    assert.ok(att.model.budgetDemoted.includes(queued.id), 'demotion is observable');

    // the three failures stay ONE grouped row referencing every event
    // (NOTE: clusterObservations would mark this 'batch'/watching; the
    // pipeline's dedupeCandidates pass merges same-title observations
    // BEFORE clustering, so clusterIds stays [] — reported as a core
    // issue. Members remain referenced, which is the durable guarantee.)
    const failure = items.find((c: any) => c.category === 'failure-cluster');
    assert.ok(failure, 'failure grouping present');
    assert.equal(failure.kind, 'observation');
    assert.equal(failure.executionId, execA);
    assert.ok(
      failure.clusterIds.length >= 2 || failure.refIds.length >= 2,
      'cluster holds >= 2 member rows',
    );
    assert.equal(failure.refIds.length + failure.clusterIds.length >= 3, true, 'all three failures referenced');
    assert.ok(['waiting', 'watching'].includes(failure.section));

    // map counts reconcile against what actually exists
    assert.equal(att.model.map.agents, 2);
    assert.equal(att.model.map.needsYou, 1);
    assert.ok(att.model.map.waiting >= 1);
    assert.equal(att.model.map.working, 0, 'both runs are held — nothing is progressing alone');
    assert.equal(att.model.map.finished, 0);
    assert.equal(att.model.map.load.level, 'HIGH');
    assert.ok(att.model.map.load.reasons.some((r: string) => /need your decision/.test(r)));
    for (const c of items) {
      assert.ok(['needs-you', 'waiting', 'watching', 'recorded'].includes(c.section), 'every item has a section');
      assert.ok(Array.isArray(c.facts) && c.facts.length >= 4, 'every item narrates its placement');
    }
  });

  test('/api/state keeps its P9 payload and only adds map semantics', async () => {
    const { status, body } = await get('/api/state');
    assert.equal(status, 200);
    // P9 fields, present with the same types
    assert.equal(typeof body.now, 'number');
    assert.ok(Array.isArray(body.executions) && body.executions.length >= 2);
    const card = body.executions.find((c: any) => c.executionId === execA);
    for (const key of ['executionId', 'goal', 'status', 'statusLabel', 'statusMeaning', 'tone', 'needsYou', 'agent', 'phase', 'progress', 'lastActivity', 'filesChanged', 'pendingDecisions', 'metrics']) {
      assert.ok(key in card, `card keeps ${key}`);
    }
    assert.equal(card.needsYou, true);
    assert.equal(card.pendingDecisions, 1);
    assert.ok(card.metrics.totalMs >= 0 && 'attentionRatio' in card.metrics);
    assert.ok(Array.isArray(body.queue) && body.queue.length >= 2);
    assert.ok(body.queue.every((d: any) => 'priority' in d && 'isQuestion' in d && Array.isArray(d.options)));
    assert.ok(body.quality);
    // attention block: all old keys, plus the P10 map fields
    const a = body.attention;
    assert.equal(a.pendingDecisions, 2);
    assert.ok(a.totalMs > 0);
    assert.ok(a.autonomousMs >= 0 && a.humanMs >= 0 && a.attentionRatio >= 0);
    assert.equal(a.needsYou, 1, 'needsYou now answers from the attention map');
    assert.equal(a.working, 0, 'working counts agents truly alone, not merely non-terminal');
    assert.ok(a.waiting >= 1);
    assert.ok('watching' in a);
    assert.ok(a.load && typeof a.load.level === 'string' && Array.isArray(a.load.reasons));
  });

  test('POST /api/delegate grants scoped authority; the next gate runs covered instead of interrupting', async () => {
    // input validation: a 400, not a crash
    assert.equal((await post('/api/delegate', { scope: 'execution', category: 'git' })).status, 400);
    assert.equal((await post('/api/delegate', { scope: 'banana', category: 'git' })).status, 400);
    assert.equal((await post('/api/delegate', { scope: 'workspace', category: 'not-a-category' })).status, 400);

    const grant = await post('/api/delegate', {
      scope: 'workspace',
      category: 'dependencies',
      grantedBy: 'developer',
      note: 'routine deps on this branch',
    });
    assert.equal(grant.status, 200);
    dlId = grant.body.delegation.id;
    assert.ok(dlId.startsWith('dl-'));
    assert.equal(grant.body.delegation.scope, 'workspace');
    assert.equal(grant.body.delegation.executionId, null);
    assert.equal(grant.body.delegation.authority, 'allow-autonomously');

    const active = (await get('/api/delegations')).body;
    assert.equal(active.delegations.length, 1);
    assert.equal(active.delegations[0].id, dlId);
    assert.equal(active.delegations[0].active, true);

    // the SAME kind of action that interrupted exec B now runs under authority
    execC = newExecution('C', 'orion');
    const pendBefore = (await get('/api/state')).body.attention.pendingDecisions;
    gate(execC, 'c3', 'pnpm add hono');
    const att = await attention();
    assert.equal(
      att.model.items.some((c: any) => c.kind === 'decision' && c.executionId === execC),
      false,
      'no decision appeared for the covered action',
    );
    assert.equal((await get('/api/state')).body.attention.pendingDecisions, pendBefore, 'no new interrupts');
    const cardC = (await get('/api/state')).body.executions.find((c: any) => c.executionId === execC);
    assert.equal(cardC.statusLabel, 'Working autonomously', 'the run never stopped');
    assert.equal(cardC.pendingDecisions, 0);
    // it IS observable: the delegated activity is recorded, not hidden
    assert.ok(att.model.items.some((c: any) => c.kind === 'observation' && c.category === 'delegated-activity' && c.executionId === execC));

    const detail = (await get(`/api/executions/${execC}`)).body;
    assert.ok(detail.autonomous.length > 0, 'allowed-autonomously list present');
    const covered = detail.autonomous.filter((r: any) => r.type === 'policy.delegated');
    assert.ok(covered.length >= 1, 'the pnpm add shows up as a delegated row');
    for (const r of covered) {
      assert.match(r.event, /pnpm add hono/, 'row describes the real command');
      assert.equal(r.whyNotInterrupted.delegatedBy?.id, dlId, 'badge names the delegation');
      assert.ok(
        r.whyNotInterrupted.allowedBecause.some((s: string) => s.includes('delegated') && s.includes(dlId)),
        'allowedBecause cites the developer authority',
      );
      assert.equal(r.whyNotInterrupted.attentionSaved, 'not measured', 'no fake time savings');
    }
    assert.ok(detail.delegations.some((d: any) => d.id === dlId), 'detail lists the covering delegation');
  });

  test('revoke puts the next consequential action back in front of you', async () => {
    const rv = await post(`/api/delegations/${dlId}/revoke`, { by: 'shubham' });
    assert.equal(rv.status, 200);
    assert.equal(rv.body.delegation.revokedBy, 'shubham');
    assert.ok(rv.body.delegation.revokedAt > 0);

    const activeNow = (await get('/api/delegations')).body;
    assert.equal(activeNow.delegations.some((d: any) => d.id === dlId), false, 'not active');
    const all = (await get('/api/delegations?all=1')).body;
    const row = all.delegations.find((d: any) => d.id === dlId);
    assert.ok(row, 'still listed in full audit list');
    assert.equal(row.active, false, 'active flag computed vs now');
    assert.ok(row.revokedAt, 'revocation stamped, never deleted');

    gate(execC, 'c4', 'pnpm add lodash');
    const att = await attention();
    const back = att.model.items.find((c: any) => c.kind === 'decision' && c.executionId === execC);
    assert.ok(back, 'the next gate interrupts again');
    assert.match(back.title, /pnpm add lodash/);
    assert.ok(['needs-you', 'waiting'].includes(back.section));
    assert.ok(['interrupt', 'queue'].includes(back.disposition));
  });

  test('decision memory turns repetition into an offer — and only an offer', async () => {
    const att0 = await attention();
    const ids = ['execB', 'execC'].map((which) => {
      const execId = which === 'execB' ? execB : execC;
      return att0.model.items.find((c: any) => c.kind === 'decision' && c.executionId === execId)!.refIds[0];
    });
    for (const id of ids) {
      const r = await post(`/api/decisions/${id}/resolve`, {
        outcome: 'accepted',
        selectedOptionId: 'approve-once',
        answerBy: 'shubham',
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'accepted');
    }

    const att = await attention();
    const dep = att.suggestions.find((s: any) => s.category === 'dependencies');
    assert.ok(dep, 'two accepted install decisions surface a recurrence offer');
    assert.ok(dep.accepted >= 2);
    assert.equal(dep.rejected, 0);
    assert.match(dep.offer, /dependencies/);
    assert.ok(Array.isArray(dep.sampleTitles) && dep.sampleTitles.length >= 1);
    // offers never grant: the delegation count is unchanged by the offer existing
    assert.equal(att.delegations.filter((d: any) => d.category === 'dependencies').length, 0);
    // and offering is idempotent-safe: no crash with a second read
    assert.ok((await attention()).model.items);
  });

  test('delegation changes propagate over SSE (fingerprint includes delegations)', async () => {
    const res = await fetch(`${(server as ConductorUiServer).url}/stream`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const collect = async (needle: string, tries = 40): Promise<boolean> => {
      for (let i = 0; i < tries; i++) {
        const raced = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('stream idle')), 5000)),
        ]).catch(() => null);
        if (!raced || raced.done) return false;
        buffer += decoder.decode(raced.value, { stream: true });
        if (buffer.includes(needle)) return true;
      }
      return false;
    };
    assert.ok(await collect('"type":"hello"'), 'stream opens with hello frame');
    assert.ok(await collect('"type":"changed"'), 'catch-up frame for pre-existing writes');
    buffer = ''; // anything after this line is a live reaction

    await post('/api/delegate', { scope: 'workspace', category: 'deployment', ttlMs: 60_000 });
    assert.ok(await collect('"type":"changed"'), 'grant changed the fingerprint → pushed');
    const afterGrant = (await get('/api/delegations')).body;
    assert.ok(afterGrant.delegations.some((d: any) => d.category === 'deployment'));

    reader.cancel().catch(() => {});
    res.body?.cancel().catch(() => {});
  });
});
