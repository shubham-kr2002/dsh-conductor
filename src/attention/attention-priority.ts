/**
 * Deterministic attention prioritization
 *
 * Answers: "if the developer can look at ONE thing right now, what is it?"
 * There is no numeric attention score. Ordering is a lexicographic walk
 * over explainable factors, and every comparison can be narrated as
 * human-readable facts (priorityFacts) — the same rows the UI renders.
 *
 * Starvation rule (anti-livelock): within the same consequence tier the
 * oldest request wins; age can raise URGENT by one level after a grace
 * period, but stale attention NEVER crosses into critical and never beats
 * a higher-consequence item on age alone.
 */

import type { AttentionDisposition } from '../types/attention.js';
import type { AttentionCandidate, AttentionFactors } from './attention-candidate.js';

/** Age after which a waiting request gets one urgency level (5 min). */
export const URGENCY_ESCALATION_MS = 5 * 60_000;

const DISPOSITION_RANK: Record<AttentionDisposition, number> = {
  critical: 6,
  interrupt: 5,
  queue: 4,
  surface: 3,
  batch: 2,
  observe: 1,
  ignore: 0,
};

const CONSEQUENCE_RANK: Record<AttentionFactors['consequence'], number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

const URGENCY_RANK: Record<AttentionFactors['urgency'], number> = {
  immediate: 3,
  high: 2,
  medium: 1,
  low: 0,
};

const REVERSIBILITY_RANK: Record<AttentionFactors['reversibility'], number> = {
  irreversible: 2,
  unknown: 1,
  reversible: 0,
};

/** Urgency with the deterministic aging rule applied. */
export function effectiveUrgency(c: AttentionCandidate, now: number): AttentionFactors['urgency'] {
  const base = c.factors.urgency;
  const age = Math.max(0, now - c.createdAt);
  if (age >= URGENCY_ESCALATION_MS && (base === 'medium' || base === 'high')) {
    // one level only; low also stays capped at medium (never urgent by age alone)
    return base === 'high' ? 'immediate' : 'high';
  }
  if (age >= URGENCY_ESCALATION_MS && base === 'low') return 'medium';
  return base;
}

/**
 * Full lexicographic comparison. Lower return value = higher priority
 * (Array.sort convention). Deterministic total order, ties broken by
 * creation time then id for stability.
 */
export function compareAttention(now: number) {
  return (a: AttentionCandidate, b: AttentionCandidate): number => {
    const steps: Array<() => number> = [
      // 1. anything that blocks autonomous work goes first
      () => Number(b.factors.blocking) - Number(a.factors.blocking),
      // 2. how damaging could waiting be
      () => CONSEQUENCE_RANK[b.factors.consequence] - CONSEQUENCE_RANK[a.factors.consequence],
      // 3. time sensitivity (with the capped aging rule)
      () => URGENCY_RANK[effectiveUrgency(b, now)] - URGENCY_RANK[effectiveUrgency(a, now)],
      // 4. presentation weight (critical items outrank deferred ones)
      () => DISPOSITION_RANK[b.disposition] - DISPOSITION_RANK[a.disposition],
      // 5. harder-to-undo work deserves eyes sooner
      () => REVERSIBILITY_RANK[b.factors.reversibility] - REVERSIBILITY_RANK[a.factors.reversibility],
      // 6. genuine ambiguity only a human can resolve
      () => (b.factors.ambiguity ?? -1) - (a.factors.ambiguity ?? -1),
      // 7. other agents waiting
      () => b.factors.dependents - a.factors.dependents,
      // 8. anti-starvation: oldest first among equals
      () => a.createdAt - b.createdAt,
      // 9. stable tie-break
      () => a.id.localeCompare(b.id),
    ];
    for (const step of steps) {
      const v = step();
      if (v !== 0) return v;
    }
    return 0;
  };
}

export interface PriorityFact {
  factor: string;
  value: string;
}

/** The factual basis of an item's placement — what the UI/CLI shows. */
export function priorityFacts(c: AttentionCandidate, now: number): PriorityFact[] {
  const f = c.factors;
  const facts: PriorityFact[] = [
    { factor: 'Consequence', value: f.consequence.toUpperCase() },
    { factor: 'Time sensitivity', value: effectiveUrgency(c, now) },
    { factor: 'Agent blocked', value: f.blocking ? 'YES' : 'no' },
    { factor: 'Reversibility', value: f.reversibility },
    { factor: 'Ambiguity', value: f.ambiguity == null ? 'not measured' : `${String(Math.round(f.ambiguity * 100))}%` },
    { factor: 'Waiting', value: formatAge(Math.max(0, now - c.createdAt)) },
  ];
  if (f.dependents > 0) facts.push({ factor: 'Dependents', value: `${String(f.dependents)} execution(s) waiting` });
  if (f.blockedMs != null && f.blockedMs > 0) facts.push({ factor: 'Work prevented', value: formatAge(f.blockedMs) });
  if (f.deadlineAt != null) facts.push({ factor: 'Deadline', value: formatAge(Math.max(0, f.deadlineAt - now)) + ' left' });
  return facts;
}

export function formatAge(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${String(total)}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${String(m)}m`;
  return `${String(Math.floor(m / 60))}h${String(m % 60).padStart(2, '0')}`;
}

/** Cockpit sections + human language for dispositions. */
export interface DispositionLanguage {
  label: string;
  section: 'needs-you' | 'waiting' | 'watching' | 'recorded';
  verb: string;
}

export function dispositionLanguage(d: AttentionDisposition): DispositionLanguage {
  switch (d) {
    case 'critical': return { label: 'Needs you now', section: 'needs-you', verb: 'Take control or decide' };
    case 'interrupt': return { label: 'Needs you now', section: 'needs-you', verb: 'Decide' };
    case 'queue': return { label: 'Safely waiting', section: 'waiting', verb: 'Review when convenient' };
    case 'surface': return { label: 'Worth a glance', section: 'waiting', verb: 'Review' };
    case 'batch': return { label: 'Batched for review', section: 'watching', verb: 'Review cluster' };
    case 'observe': return { label: 'Recorded', section: 'recorded', verb: 'Inspect' };
    default: return { label: 'Ignored', section: 'recorded', verb: '—' };
  }
}
