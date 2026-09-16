/**
 * Attention suppression, batching and budget
 *
 * The difference between an approval system and an Attention OS:
 * important ≠ interrupt. These pure functions decide how much of the
 * human each candidate legitimately claims — never hiding consequential
 * information, only ordering and deferring it, always with a reason.
 *
 * Safety floor (invariants, Part 24):
 *  - CRITICAL candidates are never demoted by the budget;
 *  - pending DECISIONS never sink below 'queue' (they are durable,
 *    visible, and the run may be held);
 *  - suppression here affects PRESENTATION only — never execution
 *    authority (that stays with policy/attention actions in the gate).
 */

import type { AttentionDisposition, HumanAttentionContext } from '../types/attention.js';
import type { AttentionCandidate } from './attention-candidate.js';
import { compareAttention } from './attention-priority.js';

export const DEFAULT_BUDGET = {
  /** Interrupt items shown as "needs you now" while the developer is present. */
  maxInterruptsPresent: 1,
  /** While away there is nobody to interrupt; return-to-work shows all. */
  maxInterruptsAway: 0,
  /** Observations in one execution+category within this window cluster. */
  batchWindowMs: 10 * 60_000,
} as const;

export type BudgetPolicy = typeof DEFAULT_BUDGET;

/** An over-budget interrupt becomes a durable queue item (never lower). */
function demote(): AttentionDisposition {
  return 'queue';
}

export interface BudgetResult {
  items: AttentionCandidate[];
  /** ids demoted from interrupt -> queue by the budget pass. */
  demoted: string[];
}

/**
 * The interruption budget: 5 things happened, 2 matter, 1 needs action
 * now, 2 can wait — so the human sees exactly that shape.
 */
export function applyAttentionBudget(
  candidates: AttentionCandidate[],
  ctx: HumanAttentionContext,
  policy: BudgetPolicy = DEFAULT_BUDGET,
): BudgetResult {
  const sorted = [...candidates].sort(compareAttention(ctx.now));
  const base = ctx.away ? policy.maxInterruptsAway : policy.maxInterruptsPresent;
  // CRITICAL items already own the human's front row; a developer facing a
  // critical item is not handed more "interrupts" — they queue durably.
  const criticals = sorted.filter((c) => c.disposition === 'critical').length;
  const limit = Math.max(0, base - criticals);
  const demoted: string[] = [];
  let interrupts = 0;

  const items = sorted.map((c) => {
    if (c.disposition === 'interrupt') {
      if (interrupts < limit) {
        interrupts += 1;
        return c;
      }
      demoted.push(c.id);
      return {
        ...c,
        disposition: demote(),
        whyWaiting: ctx.away
          ? 'You were away — this heads your return-to-work summary; nothing was lost.'
          : c.factors.blocking
            ? 'Something more consequential holds the front; this run stays safely paused meanwhile.'
            : 'The agent keeps working without it; this stays queued and durable.',
      };
    }
    // queue/surface/batch keep their disposition but still get a reason
    if ((c.disposition === 'queue' || c.disposition === 'surface') && c.whyWaiting == null) {
      return {
        ...c,
        whyWaiting: c.factors.blocking
          ? 'Its execution is paused, but a higher-consequence item leads.'
          : c.factors.consequence === 'low'
            ? 'Low consequence; safe to batch into your next review.'
            : 'Still waiting for you — nothing is lost by answering the lead item first.',
      };
    }
    return c;
  });

  return { items, demoted };
}

/** Stable cluster identity for members merged in the same window. */
function clusterKey(c: AttentionCandidate): string {
  return `${c.executionId}|${c.category}`;
}

/**
 * Batch related OBSERVATION candidates within a window into one cluster.
 * Members are preserved in refIds/clusterIds — forensic history is never
 * destroyed (Part 10). Decisions and execution-state candidates are
 * never batched away.
 */
export function clusterObservations(
  candidates: AttentionCandidate[],
  policy: BudgetPolicy = DEFAULT_BUDGET,
): AttentionCandidate[] {
  const out: AttentionCandidate[] = [];
  const clusters = new Map<string, AttentionCandidate>();

  for (const c of candidates) {
    if (c.kind !== 'observation' || c.category === 'delegated-activity') {
      // Ambient delegated activity is context, not a storm to group.
      out.push(c);
      continue;
    }
    const key = clusterKey(c);
    const head = clusters.get(key);
    if (head && c.createdAt - head.createdAt <= policy.batchWindowMs) {
      head.clusterIds.push(c.id);
      head.refIds = [...head.refIds, ...c.refIds];
      head.disposition = 'batch';
      head.summary = clusterHeadline(head);
      continue;
    }
    const copy = { ...c, refIds: [...c.refIds], clusterIds: [...c.clusterIds] };
    clusters.set(key, copy);
    out.push(copy);
  }
  return out;
}

function clusterHeadline(head: AttentionCandidate): string {
  const n = head.clusterIds.length + 1;
  const noun =
    head.category === 'failure-cluster' ? 'failure'
      : head.category === 'delegated-activity' ? 'delegated action'
        : 'event';
  return `${head.summary.replace(/\s*\(\d+\s*\w+.*\)\s*$/, '')} (${String(n)} ${noun}${n === 1 ? '' : 's'} grouped)`;
}

/**
 * Collapse fully-duplicate candidates (same id or same execution+category+
 * subject evidence arriving twice). Duplicate delivery must be safe.
 */
export function dedupeCandidates(candidates: AttentionCandidate[]): AttentionCandidate[] {
  const byId = new Map<string, AttentionCandidate>();
  const byKey = new Map<string, AttentionCandidate>();
  const dropped: string[] = [];

  for (const c of candidates) {
    const existing = byId.get(c.id);
    const key = `${c.kind}|${c.executionId}|${c.category}|${c.title}`;
    const twin = byKey.get(key);
    // Only collapse a genuine duplicate: same candidate id or overlapping
    // refIds. Two DISTINCT rows (a second question under the same generic
    // title, a same-titled failure storm) are never merged away — a
    // re-delivered decision shares its candidate id anyway (adversarial
    // matrix note: distinct pending items must stay individually
    // resolvable).
    const overlaps =
      twin !== undefined &&
      twin.id !== c.id &&
      twin.refIds.some((r) => c.refIds.includes(r));
    if (existing || overlaps) {
      const target = existing ?? twin!;
      target.refIds = [...new Set([...target.refIds, ...c.refIds])];
      target.clusterIds = [...new Set([...target.clusterIds, ...c.clusterIds])];
      dropped.push(c.id);
      continue;
    }
    byId.set(c.id, c);
    byKey.set(key, c);
  }
  void dropped;
  return [...byId.values()];
}
