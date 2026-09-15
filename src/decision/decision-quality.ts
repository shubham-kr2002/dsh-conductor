/**
 * Decision quality — observable facts only
 *
 * A decision is not finished when a button is clicked. We record and derive
 * what actually happened: was it shown, how fast was it answered, did the
 * same subject come back (answer didn't stick), and where the run ended up.
 * Nothing predictive, nothing scored — every field is a fact from stored
 * rows, so "was this interruption necessary?" can be asked later honestly.
 */

import type { ConductorDecision } from '../types/decision.js';
import type { DecisionQuality } from '../types/decision.js';
import type { Execution } from '../domain/execution.js';

/** Did a LATER decision for the same execution+subject appear? */
export function didSubjectRecur(
  decision: ConductorDecision,
  all: ConductorDecision[],
): boolean {
  if (decision.subject == null || decision.subject === '') return false;
  const after = decision.resolution?.resolvedAt ?? decision.updatedAt;
  return all.some(
    (d) =>
      d.id !== decision.id &&
      d.executionId === decision.executionId &&
      d.subject === decision.subject &&
      d.createdAt > after,
  );
}

/**
 * Derive the full quality record for one resolved-or-pending decision from
 * the decision list and the execution's current state.
 */
export function deriveDecisionQuality(
  decision: ConductorDecision,
  all: ConductorDecision[],
  execution: Execution | null,
): DecisionQuality {
  const quality: DecisionQuality = {};
  const res = decision.resolution;

  if (decision.quality?.presentedAt != null) quality.presentedAt = decision.quality.presentedAt;
  if (res) quality.responseMs = res.resolvedAt - decision.createdAt;
  quality.recurred = didSubjectRecur(decision, all);

  if (!res) {
    quality.outcome = 'pending';
  } else if (execution) {
    if (execution.status === 'COMPLETED') {
      quality.outcome = 'completed-after';
    } else if (execution.status === 'FAILED') {
      quality.outcome = execution.timestamps.createdAt < res.resolvedAt ? 'failed-after' : 'pending';
    } else if (quality.recurred) {
      quality.outcome = 'resumed-then-paused-again';
    } else {
      quality.outcome = 'resumed-and-progressed';
    }
  } else {
    quality.outcome = 'pending';
  }
  return quality;
}

/** Aggregate quality facts over resolved decisions (observable, not judged). */
export interface DecisionQualityRollup {
  resolved: number;
  medianResponseMs: number | null;
  recurredCount: number;
  outcomes: Partial<Record<NonNullable<DecisionQuality['outcome']>, number>>;
}

export function rollupDecisionQuality(
  decisions: ConductorDecision[],
): DecisionQualityRollup {
  const resolved = decisions.filter((d) => d.resolution != null);
  const responseMs = resolved
    .map((d) => (d.resolution as { resolvedAt: number }).resolvedAt - d.createdAt)
    .sort((a, b) => a - b);
  const outcomes: DecisionQualityRollup['outcomes'] = {};
  let recurredCount = 0;
  for (const d of resolved) {
    // derive fresh from the same rows — persisted quality may predate later
    // decisions, and live derivation is the observable fact.
    const recurred = d.quality?.recurred ?? didSubjectRecur(d, decisions);
    if (recurred) recurredCount += 1;
    if (d.quality?.outcome) outcomes[d.quality.outcome] = (outcomes[d.quality.outcome] ?? 0) + 1;
  }
  return {
    resolved: resolved.length,
    medianResponseMs: responseMs.length > 0 ? responseMs[Math.floor(responseMs.length / 2)] ?? null : null,
    recurredCount,
    outcomes,
  };
}
