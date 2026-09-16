/**
 * Attention orchestrator
 *
 * The layer that turns "many things are happening" into "here is where
 * your attention should go". Pure derivation over durable rows — no
 * storage, no events emitted, no LLM. Called on demand by the UI, the
 * CLI and the demo; never on the event hot path.
 *
 *   executions + decisions + recent events
 *        → candidates (attention-candidate.ts)
 *        → dedupe → cluster → sort (attention-priority.ts)
 *        → budget (attention-suppression.ts)
 *        → attention map + ordered items
 */

import type { Execution } from '../domain/execution.js';
import type { ConductorDecision } from '../types/decision.js';
import type { ConductorEvent } from '../types/event.js';
import type { AttentionLoad, HumanAttentionContext } from '../types/attention.js';
import type { AttentionCandidate, CandidateKind } from './attention-candidate.js';
import { compareAttention, dispositionLanguage } from './attention-priority.js';
import {
  applyAttentionBudget,
  clusterObservations,
  dedupeCandidates,
  DEFAULT_BUDGET,
  type BudgetPolicy,
} from './attention-suppression.js';

export interface AttentionModelInput {
  executions: Execution[];
  /** ALL decisions in scope (pending ones become candidates; the rest are history). */
  decisions: ConductorDecision[];
  /** Bounded recent events per execution (observations). */
  events: ConductorEvent[];
  now: number;
  policy?: BudgetPolicy;
}

export interface AttentionMap {
  agents: number;
  needsYou: number;
  waiting: number;
  watching: number;
  working: number;
  finished: number;
  load: AttentionLoad;
}

export interface AttentionModel {
  generatedAt: number;
  map: AttentionMap;
  items: AttentionCandidate[];
  /** ids the budget demoted this pass (observable suppression, never hidden). */
  budgetDemoted: string[];
}

const HELD = new Set(['PAUSED', 'BLOCKED']);

function heldSince(exec: Execution, now: number): number | null {
  if (!HELD.has(exec.status)) return null;
  const t = exec.transitions;
  for (let i = t.length - 1; i >= 0; i--) {
    if (HELD.has(t[i]!.to)) return Math.max(0, now - t[i]!.timestamp);
  }
  return null;
}

/**
 * Is this execution currently away-marked and not yet returned?
 * A human answering a decision (resolution timestamp after the mark) is
 * itself a return signal — answering proves presence and must clear the
 * stale away window, or a developer who resolved one thing would keep
 * seeing a fleet-wide zero-interrupt cockpit.
 */
function awaySince(events: ConductorEvent[], humanReturns: number[] = []): number | null {
  let away: number | null = null;
  for (const e of events) {
    if (e.type !== 'human.intervention') continue;
    const action = (e.payload as Record<string, unknown>).action;
    if (action === 'mark_away') {
      if (away == null || e.timestamp > away) away = e.timestamp;
    } else if (away != null && e.timestamp > away && action !== 'mark_away') {
      // any later human action ends the away window
      away = null;
    }
  }
  if (away != null && humanReturns.some((t) => t > away)) return null;
  return away;
}

function decisionCategory(d: ConductorDecision): AttentionCandidate['category'] {
  return d.subject ? 'approval' : 'question';
}

function candidatesFromDecisions(
  decisions: ConductorDecision[],
  execById: Map<string, Execution>,
  now: number,
): AttentionCandidate[] {
  const out: AttentionCandidate[] = [];
  for (const d of decisions) {
    if (d.status !== 'pending') continue;
    const exec = execById.get(d.executionId);
    const blocking = exec ? HELD.has(exec.status) : false;
    const impactConsequence =
      d.impact === 'critical' ? 'critical' : d.impact === 'major' ? 'high' : d.impact === 'moderate' ? 'medium' : 'low';
    const isCritical = d.impact === 'critical' || d.urgency === 'critical';
    const category = decisionCategory(d);
    out.push({
      id: `cand:decision:${d.id}`,
      executionId: d.executionId,
      goal: exec?.goal ?? d.executionId,
      agentId: exec?.agent.id ?? '—',
      kind: 'decision' satisfies CandidateKind,
      refIds: [d.id],
      category,
      title: d.title,
      summary: d.why?.what ?? d.question,
      disposition: isCritical ? 'critical' : 'interrupt',
      factors: {
        consequence: impactConsequence,
        urgency: isCritical ? 'immediate' : blocking ? 'high' : 'medium',
        blocking,
        blockedMs: exec && blocking ? heldSince(exec, now) : null,
        reversibility: d.why?.reversibility ?? 'unknown',
        ambiguity: d.why?.evidence.ambiguity ?? (1 - d.confidence),
        confidence: d.confidence,
        ageMs: Math.max(0, now - d.createdAt),
        dependents: 0,
        humanCost:
          category === 'approval' && d.options.some((o) => o.id === 'approve-once')
            ? 'single-click'
            : d.options.length > 0
              ? 'pick-an-option'
              : 'read-and-judge',
        deadlineAt: d.expiresAt ?? null,
      },
      whyWaiting: null,
      clusterIds: [],
      ...(d.why ? { why: d.why } : {}),
      createdAt: d.createdAt,
    });
  }
  return out;
}

function candidatesFromExecutions(execs: Execution[], pendingDecisionExecIds: Set<string>, now: number): AttentionCandidate[] {
  const out: AttentionCandidate[] = [];
  for (const e of execs) {
    if (e.status === 'BLOCKED' && !pendingDecisionExecIds.has(e.id)) {
      out.push({
        id: `cand:blocked:${e.id}`,
        executionId: e.id,
        goal: e.goal,
        agentId: e.agent.id,
        kind: 'execution',
        refIds: [e.id],
        category: 'blocked',
        title: `${e.agent.id} cannot continue safely`,
        summary: 'The agent hit something it should not pass through on its own.',
        disposition: 'critical',
        factors: {
          consequence: 'high',
          urgency: 'immediate',
          blocking: true,
          blockedMs: heldSince(e, now),
          reversibility: 'unknown',
          ambiguity: null,
          confidence: null,
          ageMs: heldSince(e, now) ?? 0,
          dependents: 0,
          humanCost: 'read-and-judge',
          deadlineAt: null,
        },
        whyWaiting: null,
        clusterIds: [],
        createdAt: heldSince(e, now) != null ? now - heldSince(e, now)! : e.timestamps.updatedAt,
      });
    }
    if (e.status === 'HANDOFF_PENDING') {
      out.push({
        id: `cand:handoff:${e.id}`,
        executionId: e.id,
        goal: e.goal,
        agentId: e.agent.id,
        kind: 'execution',
        refIds: [e.id],
        category: 'handoff',
        title: 'Handoff awaiting adoption',
        summary: `${e.agent.id} prepared a handoff; a new agent needs to take over.`,
        disposition: 'surface',
        factors: {
          consequence: 'medium',
          urgency: 'medium',
          blocking: true,
          blockedMs: heldSince(e, now),
          reversibility: 'reversible',
          ambiguity: null,
          confidence: null,
          ageMs: Math.max(0, now - e.timestamps.updatedAt),
          dependents: 1,
          humanCost: 'single-click',
          deadlineAt: null,
        },
        whyWaiting: 'Nothing is corrupted while it waits; the brief is durable.',
        clusterIds: [],
        createdAt: e.timestamps.updatedAt,
      });
    }
    if (e.status === 'TAKEN_OVER' && now - e.timestamps.updatedAt > 10 * 60_000) {
      out.push({
        id: `cand:takeover:${e.id}`,
        executionId: e.id,
        goal: e.goal,
        agentId: e.agent.id,
        kind: 'execution',
        refIds: [e.id],
        category: 'takeover-idle',
        title: 'You are still driving',
        summary: 'The agent has been idle while you hold control.',
        disposition: 'observe',
        factors: {
          consequence: 'low',
          urgency: 'low',
          blocking: true,
          blockedMs: now - e.timestamps.updatedAt,
          reversibility: 'reversible',
          ambiguity: null,
          confidence: null,
          ageMs: now - e.timestamps.updatedAt,
          dependents: 0,
          humanCost: 'single-click',
          deadlineAt: null,
        },
        whyWaiting: null,
        clusterIds: [],
        createdAt: e.timestamps.updatedAt,
      });
    }
  }
  return out;
}

function candidatesFromEvents(events: ConductorEvent[], execById: Map<string, Execution>, now: number): AttentionCandidate[] {
  const out: AttentionCandidate[] = [];
  for (const e of events) {
    const exec = execById.get(e.executionId);
    if (!exec || exec.isTerminal()) continue;
    const payload = e.payload as Record<string, unknown>;
    if (e.type === 'test.failed') {
      out.push({
        id: `cand:testfail:${e.id}`,
        executionId: e.executionId,
        goal: exec.goal,
        agentId: exec.agent.id,
        kind: 'observation',
        refIds: [e.id],
        category: 'failure-cluster',
        title: `Test failures in ${exec.agent.id}`,
        summary: `tests failing: ${String(payload.testName ?? 'suite')}`,
        disposition: 'surface',
        factors: {
          consequence: 'medium',
          urgency: 'low',
          blocking: false,
          blockedMs: null,
          reversibility: 'reversible',
          ambiguity: null,
          confidence: (e.metadata?.attention as { confidence?: number } | undefined)?.confidence ?? null,
          ageMs: Math.max(0, now - e.timestamp),
          dependents: 0,
          humanCost: 'read-and-judge',
          deadlineAt: null,
        },
        whyWaiting: 'The agent is handling it; failure is recorded, not lost.',
        clusterIds: [],
        createdAt: e.timestamp,
      });
    } else if (e.type === 'policy.delegated') {
      out.push({
        // One logical action = one candidate even when the adapter wrote
        // two forensic rows (tool.called + command.started for one call).
        id: `cand:delegated:${String(payload.delegationId ?? e.id)}:${String(payload.command ?? payload.toolName ?? e.id)}`,
        executionId: e.executionId,
        goal: exec.goal,
        agentId: exec.agent.id,
        kind: 'observation',
        refIds: [e.id],
        category: 'delegated-activity',
        title: `Delegated activity in ${exec.agent.id}`,
        summary: `ran under your delegation: ${truncate(String(payload.command ?? payload.toolName ?? 'action'))}`,
        disposition: 'observe',
        factors: {
          consequence: 'low',
          urgency: 'low',
          blocking: false,
          blockedMs: null,
          reversibility: (payload.reversibility as 'reversible') ?? 'reversible',
          ambiguity: null,
          confidence: null,
          ageMs: Math.max(0, now - e.timestamp),
          dependents: 0,
          humanCost: 'read-and-judge',
          deadlineAt: null,
        },
        whyWaiting: null,
        clusterIds: [],
        createdAt: e.timestamp,
      });
    } else if (e.type === 'agent.blocked') {
      // execution-state candidate covers BLOCKED runs; skip duplicate view
    }
  }
  return out;
}

function truncate(s: string, n = 70): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function computeLoad(map: Omit<AttentionMap, 'load'>): AttentionLoad {
  const reasons: string[] = [];
  let level: AttentionLoad['level'] = 'LOW';
  if (map.needsYou > 2) {
    level = 'OVERLOADED';
    reasons.push(`${String(map.needsYou)} items need you at once`);
  } else if (map.needsYou >= 1) {
    level = 'HIGH';
    reasons.push(`${String(map.needsYou)} item(s) need your decision now`);
  } else if (map.waiting >= 3) {
    level = 'MEDIUM';
    reasons.push(`${String(map.waiting)} decisions waiting`);
  }
  if (map.working > 0 && level !== 'OVERLOADED') {
    reasons.push(`${String(map.working)} progressing without you`);
  }
  if (reasons.length === 0) reasons.push('nothing needs you; nothing queued');
  return { level, reasons };
}

/**
 * Build the fleet-wide attention model. Deterministic: identical durable
 * rows + identical `now` produce an identical model.
 */
export function buildAttentionModel(input: AttentionModelInput): AttentionModel {
  const { executions, decisions, events, now } = input;
  const policy = input.policy ?? DEFAULT_BUDGET;

  const execById = new Map(executions.map((e) => [e.id, e]));
  const pendingExecIds = new Set(decisions.filter((d) => d.status === 'pending').map((d) => d.executionId));

  // "The human is back" is global: answering a decision anywhere (or any
  // non-away human intervention) ends every away window plane-wide.
  const humanReturns = decisions
    .map((d) => (d.resolution ? d.resolution.resolvedAt : null))
    .filter((t): t is number => t != null);
  const anyAway = executions.some(
    (e) => awaySince(events.filter((ev) => ev.executionId === e.id), humanReturns) != null,
  );

  const raw = [
    ...candidatesFromDecisions(decisions, execById, now),
    ...candidatesFromExecutions(executions, pendingExecIds, now),
    ...candidatesFromEvents(events, execById, now),
  ];

  const deduped = dedupeCandidates(raw);
  const clustered = clusterObservations(deduped, policy);

  const ctx: HumanAttentionContext = { now, away: anyAway, activeInterrupts: 0 };
  const { items, demoted } = applyAttentionBudget(clustered, ctx, policy);

  const counts = { needsYou: 0, waiting: 0, watching: 0, recorded: 0 };
  const SECTION_KEY = {
    'needs-you': 'needsYou',
    waiting: 'waiting',
    watching: 'watching',
    recorded: 'recorded',
  } satisfies Record<ReturnType<typeof dispositionLanguage>['section'], keyof typeof counts>;
  for (const c of items) counts[SECTION_KEY[dispositionLanguage(c.disposition).section]] += 1;
  const active = executions.filter((e) => !e.isTerminal());
  const base = {
    agents: executions.length,
    needsYou: counts.needsYou,
    waiting: counts.waiting,
    watching: counts.watching,
    working: active.filter((e) => !HELD.has(e.status) && e.status !== 'TAKEN_OVER' && pendingExecIds.has(e.id) === false).length,
    finished: executions.length - active.length,
  };

  return {
    generatedAt: now,
    map: { ...base, load: computeLoad(base) },
    items,
    budgetDemoted: demoted,
  };
}
