import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AttentionDisposition } from '../../src/types/attention.js';
import type { AttentionCandidate } from '../../src/attention/attention-candidate.js';
import {
  compareAttention,
  dispositionLanguage,
  effectiveUrgency,
  priorityFacts,
  URGENCY_ESCALATION_MS,
} from '../../src/attention/attention-priority.js';
import {
  applyAttentionBudget,
  clusterObservations,
  dedupeCandidates,
} from '../../src/attention/attention-suppression.js';

const T0 = 1_700_000_000_000;
const M = 60_000;

const BASE_FACTORS: AttentionCandidate['factors'] = {
  consequence: 'high',
  urgency: 'high',
  blocking: true,
  blockedMs: 2 * M,
  reversibility: 'unknown',
  ambiguity: 0.5,
  confidence: 0.9,
  ageMs: 0,
  dependents: 0,
  humanCost: 'single-click',
  deadlineAt: null,
};

function cand(over: Partial<AttentionCandidate> & { id: string }): AttentionCandidate {
  const base: AttentionCandidate = {
    executionId: 'exec-1',
    goal: 'g',
    agentId: 'atlas',
    kind: 'decision',
    refIds: [over.id],
    category: 'approval',
    title: over.id,
    summary: over.id,
    disposition: 'interrupt',
    whyWaiting: null,
    clusterIds: [],
    createdAt: T0,
    ...over,
    factors: { ...BASE_FACTORS, ...(over.factors ?? {}) },
  };
  return base;
}

describe('Deterministic prioritization — explainable, never a fake score', () => {
  const cmp = compareAttention(T0 + M);

  test('higher consequence beats lower', () => {
    const a = cand({ id: 'critical', factors: { ...BASE_FACTORS, consequence: 'critical' } });
    const b = cand({ id: 'medium', factors: { ...BASE_FACTORS, consequence: 'medium' } });
    assert.ok(cmp(a, b) < 0);
    assert.ok(cmp(b, a) > 0);
  });

  test('blocking work outranks non-blocking at equal consequence', () => {
    const a = cand({ id: 'blocked', factors: { ...BASE_FACTORS, blocking: true } });
    const b = cand({ id: 'free', factors: { ...BASE_FACTORS, blocking: false } });
    assert.ok(cmp(a, b) < 0);
  });

  test('irreversible waits less than reversible at equal tiers', () => {
    const a = cand({ id: 'irr', factors: { ...BASE_FACTORS, reversibility: 'irreversible' } });
    const b = cand({ id: 'rev', factors: { ...BASE_FACTORS, reversibility: 'reversible' } });
    assert.ok(cmp(a, b) < 0);
  });

  test('higher ambiguity wins among equals', () => {
    const a = cand({ id: 'vague', factors: { ...BASE_FACTORS, ambiguity: 0.9 } });
    const b = cand({ id: 'clear', factors: { ...BASE_FACTORS, ambiguity: 0.1 } });
    assert.ok(cmp(a, b) < 0);
  });

  test('dependents raise priority; age breaks ties oldest-first (no starvation)', () => {
    const withDeps = cand({ id: 'w', factors: { ...BASE_FACTORS, dependents: 2 } });
    const alone = cand({ id: 'a', factors: { ...BASE_FACTORS, dependents: 0 } });
    assert.ok(cmp(withDeps, alone) < 0);
    const old = cand({ id: 'old', createdAt: T0 });
    const fresh = cand({ id: 'fresh', createdAt: T0 + 5 * M });
    assert.ok(cmp(old, fresh) < 0, 'oldest first among equals');
    assert.ok(cmp(fresh, old) > 0);
  });

  test('aging raises urgency one level after grace, and stops there', () => {
    const med = cand({ id: 'm', createdAt: T0, factors: { ...BASE_FACTORS, urgency: 'medium' } });
    assert.equal(effectiveUrgency(med, T0 + M), 'medium', 'young: unchanged');
    assert.equal(effectiveUrgency(med, T0 + URGENCY_ESCALATION_MS), 'high', 'aged: +1');
    const low = cand({ id: 'l', createdAt: T0, factors: { ...BASE_FACTORS, urgency: 'low' } });
    assert.equal(effectiveUrgency(low, T0 + 60 * M), 'medium', 'low caps at medium — stale ≠ urgent');
    const high = cand({ id: 'h', createdAt: T0, factors: { ...BASE_FACTORS, urgency: 'high' } });
    assert.equal(effectiveUrgency(high, T0 + 24 * 60 * M), 'immediate', 'never beyond immediate');
  });

  test('stale attention does NOT outrank a higher-consequence arrival', () => {
    const oldMedium = cand({ id: 'oldmed', createdAt: T0, factors: { ...BASE_FACTORS, consequence: 'medium' } });
    const newCritical = cand({ id: 'newcrit', createdAt: T0 + 30 * M, factors: { ...BASE_FACTORS, consequence: 'critical' } });
    assert.ok(compareAttention(T0 + 30 * M + URGENCY_ESCALATION_MS)(oldMedium, newCritical) > 0);
  });

  test('priorityFacts narrates the placement in human terms', () => {
    const c = cand({ id: 'x', createdAt: T0, factors: { ...BASE_FACTORS, consequence: 'critical', dependents: 2 } });
    const facts = priorityFacts(c, T0 + 4 * M);
    assert.deepEqual(facts.find((f) => f.factor === 'Consequence')?.value, 'CRITICAL');
    assert.equal(facts.find((f) => f.factor === 'Agent blocked')?.value, 'YES');
    assert.equal(facts.find((f) => f.factor === 'Waiting')?.value, '4m');
    assert.ok(facts.some((f) => f.factor === 'Dependents' && f.value.includes('2')));
  });

  test('ordering is a deterministic total order — identical inputs, identical order', () => {
    const items = [cand({ id: 'a' }), cand({ id: 'b', disposition: 'queue' }), cand({ id: 'c', factors: { ...BASE_FACTORS, consequence: 'critical' } }), cand({ id: 'd', createdAt: T0 - M })];
    const one = [...items].sort(compareAttention(T0));
    const two = [...items].sort(compareAttention(T0));
    assert.deepEqual(one.map((x) => x.id), two.map((x) => x.id));
    assert.equal(one[0]!.id, 'c');
  });
});

describe('Suppression — important is not interrupt', () => {
  test('budget keeps exactly one interrupt when the developer is present', () => {
    const a = cand({ id: 'a' });
    const b = cand({ id: 'b' });
    const { items, demoted } = applyAttentionBudget([a, b], { now: T0, away: false, activeInterrupts: 0 });
    assert.equal(items.filter((c) => c.disposition === 'interrupt').length, 1);
    assert.deepEqual(demoted, ['b'], 'loser demoted durably');
    const loser = items.find((c) => c.id === 'b')!;
    assert.equal(loser.disposition, 'queue');
    assert.ok(loser.whyWaiting && loser.whyWaiting.length > 10, 'deferral explains itself');
  });

  test('CRITICAL items are never demoted by the budget', () => {
    const crit = cand({ id: 'crit', disposition: 'critical', factors: { ...BASE_FACTORS, consequence: 'critical' } });
    const other = cand({ id: 'other', disposition: 'critical' });
    const { items, demoted } = applyAttentionBudget([crit, other], { now: T0, away: true, activeInterrupts: 0 });
    assert.equal(demoted.length, 0);
    assert.ok(items.every((c) => c.disposition === 'critical'));
  });

  test('away context: nobody is interrupted; everything durable remains', () => {
    const a = cand({ id: 'a' });
    const { items, demoted } = applyAttentionBudget([a], { now: T0, away: true, activeInterrupts: 0 });
    assert.deepEqual(demoted, ['a']);
    assert.equal(items[0]!.disposition, 'queue', 'queued, not hidden');
    assert.match(items[0]!.whyWaiting!, /away/i);
  });

  test('related observations batch into one cluster; members stay referenced', () => {
    const obs = (id: string, at: number, name: string): AttentionCandidate => ({
      ...cand({ id }),
      kind: 'observation',
      category: 'failure-cluster',
      summary: `tests failing: ${name}`,
      disposition: 'surface',
      createdAt: at,
    });
    const items = clusterObservations([
      obs('o1', T0, 'a.test'),
      obs('o2', T0 + 2 * M, 'b.test'),
      obs('o3', T0 + 4 * M, 'c.test'),
      obs('o4', T0 + 40 * M, 'd.test'), // outside the window
    ]);
    const heads = items.filter((c) => c.category === 'failure-cluster');
    assert.equal(heads.length, 2, 'one in-window cluster + one late arrival');
    const big = heads[0]!;
    assert.equal(big.disposition, 'batch');
    assert.deepEqual(big.clusterIds, ['o2', 'o3']);
    assert.equal(big.refIds.length, 3, 'every underlying row still referenced (forensics)');
    assert.match(big.summary, /3 failures grouped/);
  });

  test('duplicate candidate delivery collapses; decisions are never batched away', () => {
    const dup = [cand({ id: 'same', refIds: ['d1'] }), cand({ id: 'same', refIds: ['d2'] })];
    assert.equal(dedupeCandidates(dup).length, 1);
    assert.deepEqual(dedupeCandidates(dup)[0]!.refIds, ['d1', 'd2']);
    const decisions = clusterObservations([cand({ id: 'a' }), cand({ id: 'b', title: 'other' })]);
    assert.equal(decisions.filter((c) => c.kind === 'decision').length, 2, 'pending decisions never merged away');
  });

  test('disposition language maps to cockpit sections', () => {
    assert.equal(dispositionLanguage('critical').section, 'needs-you');
    assert.equal(dispositionLanguage('interrupt').label, 'Needs you now');
    assert.equal(dispositionLanguage('queue').section, 'waiting');
    assert.equal(dispositionLanguage('batch').section, 'watching');
    assert.equal(dispositionLanguage('observe').section, 'recorded');
  });
});
