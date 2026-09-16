/**
 * Attention history
 *
 * The honest post-mortem of the Attention OS: "where did my attention go,
 * and what did Conductor suppress while I wasn't looking?" Every entry is
 * derived from durable rows already in the control plane (decisions,
 * events, executions) — nothing is stored twice, nothing is invented.
 *
 * Invariant honored here: attention saved is NEVER reported, because it
 * has never been measured. The renderer says so literally.
 */

import type { Execution } from '../domain/execution.js';
import type { ConductorDecision } from '../types/decision.js';
import type { ConductorEvent } from '../types/event.js';
import type { PolicyCategory } from '../types/policy.js';
import { DEFAULT_POLICY_RULES } from '../policy/policy-engine.js';
import { didSubjectRecur } from '../decision/decision-quality.js';
import { buildAttentionModel, type AttentionModel } from '../attention/attention-orchestrator.js';
import { formatDuration } from './attention-metrics.js';
import type { ConductorRuntime } from '../cli/commands.js';

/** Bounded event read: newest rows per execution, never the full log. */
export const ATTENTION_HISTORY_EVENT_CAP = 300;

export interface AttentionHistoryInput {
  executions: Execution[];
  decisions: ConductorDecision[];
  events: ConductorEvent[];
  /** Window start (inclusive). */
  since: number;
  /** Window end (inclusive); defaults to the newest timestamp seen. */
  until?: number;
  /** Candidate ids the attention budget demoted this pass, when known. */
  budgetDemoted?: string[];
}

/** A request that actually reached the human inside the window. */
export interface InterruptedFact {
  decisionId: string;
  title: string;
  /** answered = accepted/custom, refused = rejected, unanswered = expired/cancelled/still-open-but-shown. */
  outcome: 'answered' | 'refused' | 'unanswered';
  /** resolvedAt - createdAt when a verdict exists; null otherwise. */
  responseMs: number | null;
  /** The same subject produced a LATER decision (answer didn't stick). */
  recurred: boolean;
}

/** A pending decision that was durably visible but not put in front of you. */
export interface DeferredFact {
  decisionId: string;
  title: string;
  /** budget = demoted by the interruption budget, away = you were away, queue = simply queued behind. */
  reason: 'budget' | 'queue' | 'away';
}

/** One recorded action that ran on your delegated authority. */
export interface DelegatedFact {
  command: string;
  category: string;
  delegationId: string;
  grantedBy: string;
}

/** A notable event that was BACKGROUND/RECORD-classified (observed, not surfaced). */
export interface ObservationFact {
  kind: 'test.failed' | 'command.failed';
  summary: string;
}

export interface RecurringSubject {
  subject: string;
  count: number;
}

export interface CategoryRollup {
  accepted: number;
  rejected: number;
  pending: number;
}

export interface AttentionHistory {
  window: { since: number; until: number };
  interrupted: InterruptedFact[];
  deferred: DeferredFact[];
  delegated: DelegatedFact[];
  observations: ObservationFact[];
  recurringSubjects: RecurringSubject[];
  /** policy-category → verdict counts (categories with zero decisions are absent). */
  categories: Partial<Record<PolicyCategory, CategoryRollup>>;
  totals: {
    decisions: number;
    takeovers: number;
    autonomousActions: number;
  };
}

function byCreatedThenId(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function byTimeThenId(a: ConductorEvent, b: ConductorEvent): number {
  return a.timestamp - b.timestamp || a.id.localeCompare(b.id);
}

function attentionOf(e: ConductorEvent): { level?: string; action?: string; ruleId?: string } | undefined {
  return e.metadata?.attention as { level?: string; action?: string; ruleId?: string } | undefined;
}

function isErrishCommandCompleted(e: ConductorEvent): boolean {
  return e.type === 'command.completed' && ((e.payload as Record<string, unknown>).exitCode as number | undefined ?? 0) !== 0;
}

/** rule id → policy category, from the shipped default rule set. */
const RULE_CATEGORY: ReadonlyMap<string, PolicyCategory> = new Map(
  DEFAULT_POLICY_RULES.map((r) => [r.id, r.category]),
);

function categoryOfDecision(d: ConductorDecision): PolicyCategory | undefined {
  for (const ruleId of d.why?.evidence.ruleIds ?? []) {
    const cat = RULE_CATEGORY.get(ruleId);
    if (cat) return cat;
  }
  return undefined;
}

/**
 * Build the derived attention history. Deterministic: identical rows +
 * identical window produce an identical object (stable ordering everywhere,
 * no clock reads, no invented fields).
 */
export function buildAttentionHistory(input: AttentionHistoryInput): AttentionHistory {
  const { executions, decisions, events } = input;
  const since = input.since;

  // --- window ------------------------------------------------------------
  let maxTs = since;
  for (const e of events) if (e.timestamp > maxTs) maxTs = e.timestamp;
  for (const d of decisions) {
    if (d.createdAt > maxTs) maxTs = d.createdAt;
    if (d.updatedAt > maxTs) maxTs = d.updatedAt;
    if (d.resolution && d.resolution.resolvedAt > maxTs) maxTs = d.resolution.resolvedAt;
  }
  for (const e of executions) if (e.timestamps.updatedAt > maxTs) maxTs = e.timestamps.updatedAt;
  const until = Math.max(since, input.until ?? maxTs);
  const inWindow = (t: number) => t >= since && t <= until;

  const sortedDecisions = [...decisions].sort(byCreatedThenId);
  const sortedEvents = [...events].sort(byTimeThenId);

  // --- interrupted (reached the human) ------------------------------------
  const interrupted: InterruptedFact[] = [];
  for (const d of sortedDecisions) {
    if (!inWindow(d.createdAt)) continue;
    const answered = d.status === 'accepted' || d.status === 'custom';
    const refused = d.status === 'rejected';
    const closedUnanswered = d.status === 'expired' || d.status === 'cancelled';
    const shownButWaiting = d.status === 'pending' && d.quality?.presentedAt != null;
    if (!answered && !refused && !closedUnanswered && !shownButWaiting) continue;
    interrupted.push({
      decisionId: d.id,
      title: d.title,
      outcome: answered ? 'answered' : refused ? 'refused' : 'unanswered',
      responseMs: d.resolution ? Math.max(0, d.resolution.resolvedAt - d.createdAt) : null,
      // persisted fact wins; otherwise derive from the same rows (Part: derive fresh)
      recurred: d.quality?.recurred ?? didSubjectRecur(d, decisions),
    });
  }

  // --- deferred (durable, visible, but not put in front of you) ------------
  const demoted = new Set(input.budgetDemoted ?? []);
  let newestResolved: ConductorDecision | null = null;
  for (const d of sortedDecisions) {
    if (!d.resolution) continue;
    if (!newestResolved || d.createdAt > newestResolved.createdAt) newestResolved = d;
  }
  let awayAt = 0;
  for (const e of sortedEvents) {
    if (e.type !== 'human.intervention') continue;
    if ((e.payload as Record<string, unknown>).action === 'mark_away') {
      if (e.timestamp > awayAt) awayAt = e.timestamp;
    }
  }
  const deferred: DeferredFact[] = [];
  for (const d of sortedDecisions) {
    if (d.status !== 'pending' || !inWindow(d.createdAt)) continue;
    const budgetHit = demoted.has(d.id) || demoted.has(`cand:decision:${d.id}`);
    const queuedBehind = newestResolved != null && d.createdAt < newestResolved.createdAt;
    if (!budgetHit && !queuedBehind) continue;
    deferred.push({
      decisionId: d.id,
      title: d.title,
      reason: budgetHit ? 'budget' : awayAt > 0 && d.createdAt >= awayAt ? 'away' : 'queue',
    });
  }

  // --- delegated (ran on your standing authority) --------------------------
  const delegated: DelegatedFact[] = [];
  for (const e of sortedEvents) {
    if (e.type !== 'policy.delegated' || !inWindow(e.timestamp)) continue;
    const p = e.payload as Record<string, unknown>;
    delegated.push({
      command: String(p.command ?? p.toolName ?? e.type),
      category: String(p.category ?? 'unknown'),
      delegationId: String(p.delegationId ?? ''),
      grantedBy: String(p.grantedBy ?? ''),
    });
  }

  // --- observations (BACKGROUND/RECORD-classified notable events) ----------
  const observations: ObservationFact[] = [];
  for (const e of sortedEvents) {
    if (!inWindow(e.timestamp)) continue;
    const noteworthy = e.type === 'test.failed' || isErrishCommandCompleted(e);
    if (!noteworthy) continue;
    const stored = attentionOf(e);
    if (!stored) continue; // classification is the traceable fact; unclassified rows stay out
    if (stored.level !== 'BACKGROUND' && stored.action !== 'RECORD') continue;
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'test.failed') {
      observations.push({ kind: 'test.failed', summary: `test failed: ${String(p.testName ?? 'suite')}` });
    } else {
      observations.push({
        kind: 'command.failed',
        summary: `command failed (exit ${String(p.exitCode ?? '?')}): ${String(p.command ?? '')}`,
      });
    }
  }

  // --- recurring subjects ---------------------------------------------------
  const subjectCounts = new Map<string, number>();
  for (const d of sortedDecisions) {
    if (!inWindow(d.createdAt)) continue;
    if (!d.subject) continue;
    subjectCounts.set(d.subject, (subjectCounts.get(d.subject) ?? 0) + 1);
  }
  const recurringSubjects = [...subjectCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([subject, count]) => ({ subject, count }))
    .sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject));

  // --- categories rollup ----------------------------------------------------
  const catBuckets = new Map<PolicyCategory, CategoryRollup>();
  for (const d of sortedDecisions) {
    if (!inWindow(d.createdAt)) continue;
    const cat = categoryOfDecision(d);
    if (!cat) continue;
    const row = catBuckets.get(cat) ?? { accepted: 0, rejected: 0, pending: 0 };
    if (d.status === 'accepted' || d.status === 'custom') row.accepted += 1;
    else if (d.status === 'rejected') row.rejected += 1;
    else if (d.status === 'pending') row.pending += 1;
    catBuckets.set(cat, row);
  }
  const categories: AttentionHistory['categories'] = {};
  for (const cat of [...catBuckets.keys()].sort()) categories[cat] = catBuckets.get(cat)!;

  // --- totals ----------------------------------------------------------------
  let takeovers = 0;
  let autonomousActions = 0;
  let windowDecisions = 0;
  for (const d of sortedDecisions) if (inWindow(d.createdAt)) windowDecisions += 1;
  for (const e of sortedEvents) {
    if (!inWindow(e.timestamp)) continue;
    if (e.type === 'human.intervention' && (e.payload as Record<string, unknown>).action === 'take_over') takeovers += 1;
    if (e.type === 'policy.delegated') {
      autonomousActions += 1;
      continue;
    }
    if ((e.type === 'tool.called' || e.type === 'command.started') && attentionOf(e)?.action === 'CONTINUE') {
      autonomousActions += 1;
    }
  }

  return {
    window: { since, until },
    interrupted,
    deferred,
    delegated,
    observations,
    recurringSubjects,
    categories,
    totals: { decisions: windowDecisions, takeovers, autonomousActions },
  };
}

function isoTs(t: number): string {
  return new Date(t).toISOString().replace('.000Z', 'Z');
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Human-readable history, in the style of the existing renderers. */
export function renderAttentionHistory(h: AttentionHistory): string {
  const lines: string[] = [
    '=================================================================',
    '              CONDUCTOR — WHERE YOUR ATTENTION WENT             ',
    '=================================================================',
    `window: ${formatDuration(Math.max(0, h.window.until - h.window.since))}  (${isoTs(h.window.since)} → ${isoTs(h.window.until)})`,
    '',
  ];

  lines.push('NEEDS YOUR REVIEW');
  const open = [
    ...h.deferred.map((d) => `  [${d.reason}] ${truncate(d.title)} — ${d.decisionId}`),
    ...h.interrupted
      .filter((i) => i.outcome === 'unanswered')
      .map((i) => `  [open] ${truncate(i.title)} — ${i.decisionId}`),
  ];
  if (open.length === 0) lines.push('  none needed — everything in this window reached a verdict');
  else lines.push(...open);
  lines.push('');

  lines.push('INTERRUPTED YOU');
  if (h.interrupted.length === 0) lines.push('  none — nothing was pulled out of your flow');
  for (const i of h.interrupted) {
    const took = i.responseMs != null ? ` (took ${formatDuration(i.responseMs)})` : '';
    const back = i.recurred ? ' — came back' : '';
    lines.push(`  • ${truncate(i.title)} → ${i.outcome}${took}${back}`);
    lines.push(`      ${i.decisionId}`);
  }
  lines.push('');

  lines.push('DELEGATED');
  if (h.delegated.length === 0) lines.push('  none — every consequential action still interrupted you');
  for (const d of h.delegated) {
    lines.push(`  • ${truncate(d.command)}  (category: ${d.category} · delegation ${d.delegationId} · granted by ${d.grantedBy})`);
  }
  lines.push('');

  lines.push('SUPPRESSED (observed)');
  if (h.observations.length === 0) lines.push('  none observed');
  for (const o of h.observations) lines.push(`  • ${o.kind}: ${truncate(o.summary)}`);
  lines.push('  attention saved: not measured');
  lines.push('');

  lines.push('RECURRING');
  if (h.recurringSubjects.length === 0) lines.push('  nothing repeated');
  for (const r of h.recurringSubjects) lines.push(`  • ${truncate(r.subject, 90)} ×${String(r.count)}`);

  const cats = Object.entries(h.categories);
  if (cats.length > 0) {
    lines.push('');
    lines.push('BY CATEGORY');
    for (const [cat, row] of cats) {
      lines.push(
        `  ${cat}: ${String(row.accepted)} accepted · ${String(row.rejected)} rejected · ${String(row.pending)} pending`,
      );
    }
  }

  lines.push('-----------------------------------------------------------------');
  lines.push(
    `totals: ${String(h.totals.decisions)} decision(s) · ${String(h.totals.takeovers)} takeover(s) · ` +
      `${String(h.totals.autonomousActions)} autonomous action(s)`,
  );
  lines.push('=================================================================');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Runtime loaders shared by CLI surfaces
// ---------------------------------------------------------------------------

export interface AttentionRows {
  executions: Execution[];
  decisions: ConductorDecision[];
  events: ConductorEvent[];
}

/**
 * Load bounded rows from the control plane: every execution, every
 * decision, and the newest ATTENTION_HISTORY_EVENT_CAP events per
 * execution. `executionId` narrows to one run.
 */
export function loadAttentionRows(rt: ConductorRuntime, opts: { executionId?: string } = {}): AttentionRows {
  const executions = opts.executionId
    ? (() => {
        const exec = rt.execRepo.findById(opts.executionId!);
        if (!exec) throw new Error(`execution not found: ${opts.executionId}`);
        return [exec];
      })()
    : rt.execRepo.list({});
  const decisions = rt.decisionRepo.list(
    opts.executionId ? { executionId: opts.executionId } : {},
  );
  const events: ConductorEvent[] = [];
  for (const e of executions) {
    const total = rt.eventRepo.countByExecution(e.id);
    events.push(
      ...rt.eventRepo.listByExecution(e.id, {
        limit: ATTENTION_HISTORY_EVENT_CAP,
        offset: Math.max(0, total - ATTENTION_HISTORY_EVENT_CAP),
      }),
    );
  }
  return { executions, decisions, events };
}

export interface AttentionFromRuntimeOptions {
  executionId?: string;
  /** Override the history window start (default: oldest row seen). */
  since?: number;
}

/**
 * One load, both views: the live attention model plus the derived history
 * (sharing the budget-demoted ids so deferral reasons are exact).
 */
export function attentionFromRuntime(
  rt: ConductorRuntime,
  now = Date.now(),
  opts: AttentionFromRuntimeOptions = {},
): { model: AttentionModel; history: AttentionHistory } {
  const rows = loadAttentionRows(rt, opts.executionId ? { executionId: opts.executionId } : {});
  const model = buildAttentionModel({ ...rows, now });

  let since = opts.since ?? Number.POSITIVE_INFINITY;
  if (opts.since == null) {
    for (const e of rows.events) if (e.timestamp < since) since = e.timestamp;
    for (const d of rows.decisions) if (d.createdAt < since) since = d.createdAt;
    for (const e of rows.executions) if (e.timestamps.createdAt < since) since = e.timestamps.createdAt;
    if (!Number.isFinite(since)) since = now;
  }

  const history = buildAttentionHistory({
    ...rows,
    since,
    budgetDemoted: model.budgetDemoted,
  });
  return { model, history };
}
