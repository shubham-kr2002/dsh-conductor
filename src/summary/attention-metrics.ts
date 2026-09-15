/**
 * Attention metrics
 *
 * The ONE number Conductor optimizes: human attention minutes per
 * completed task. Everything here is derived from data that already
 * exists — the transition log (which state the run was in, for how long)
 * and the decision list — never from extra bookkeeping.
 */

import type { Execution } from '../domain/execution.js';
import type { ConductorDecision } from '../types/decision.js';
import type { ExecutionStatus } from '../types/execution.js';

/** States where the human is the bottleneck (run waits on judgment). */
const HELD: ReadonlySet<ExecutionStatus> = new Set(['PAUSED', 'BLOCKED']);
/** States where the human actively holds the keyboard. */
const HUMAN_CONTROL: ReadonlySet<ExecutionStatus> = new Set(['TAKEN_OVER']);
/** Terminal states: time after them belongs to nobody. */
const TERMINAL: ReadonlySet<ExecutionStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export interface AttentionMetrics {
  status: ExecutionStatus;
  startedAt: number;
  /** When the run reached a terminal state, else `now`. */
  endsAt: number;
  totalMs: number;
  /** Time the run waited for human judgment (PAUSED + BLOCKED). */
  heldMs: number;
  /** Time a human directly held control (TAKEN_OVER). */
  humanControlMs: number;
  /** totalMs - heldMs - humanControlMs. */
  autonomousMs: number;
  /** Decisions + takeovers — each counts exactly once. */
  interruptions: number;
  decisionsCreated: number;
  decisionsPending: number;
  decisionsResolved: number;
  takeovers: number;
  /** (heldMs + humanControlMs) / totalMs — 0 when totalMs is 0. */
  attentionRatio: number;
}

export function computeAttentionMetrics(
  execution: Execution,
  decisions: ConductorDecision[],
  opts: { now?: number; takeoverCount?: number } = {},
): AttentionMetrics {
  const now = opts.now ?? Date.now();
  const transitions = execution.transitions; // chronological
  const startedAt = execution.timestamps.createdAt;

  let heldMs = 0;
  let humanControlMs = 0;
  let endsAt = now;
  let finalized = false;

  let prevTime = startedAt;
  let prevStatus: ExecutionStatus = execution.status;
  if (transitions.length > 0) {
    // Rebuild state occupancy from the transition log.
    prevStatus = transitions[0]!.from;
    prevTime = startedAt;
    for (const t of transitions) {
      const statusMs = Math.max(0, t.timestamp - prevTime);
      if (HELD.has(prevStatus)) heldMs += statusMs;
      else if (HUMAN_CONTROL.has(prevStatus)) humanControlMs += statusMs;
      prevStatus = t.to;
      prevTime = t.timestamp;
      if (TERMINAL.has(t.to)) {
        finalized = true;
        endsAt = t.timestamp;
      }
    }
  }
  if (!finalized) {
    // time in the current (non-terminal) status
    const tail = Math.max(0, now - prevTime);
    if (HELD.has(prevStatus)) heldMs += tail;
    else if (HUMAN_CONTROL.has(prevStatus)) humanControlMs += tail;
  }

  const totalMs = Math.max(0, endsAt - startedAt);
  const takeovers = opts.takeoverCount ?? 0;
  const decisionsCreated = decisions.length;
  const decisionsPending = decisions.filter((d) => d.status === 'pending').length;
  const decisionsResolved = decisions.filter(
    (d) => d.status === 'accepted' || d.status === 'rejected' || d.status === 'custom',
  ).length;
  const interruptions = decisionsCreated + takeovers;

  return {
    status: execution.status,
    startedAt,
    endsAt,
    totalMs,
    heldMs,
    humanControlMs,
    autonomousMs: Math.max(0, totalMs - heldMs - humanControlMs),
    interruptions,
    decisionsCreated,
    decisionsPending,
    decisionsResolved,
    takeovers,
    attentionRatio: totalMs > 0 ? (heldMs + humanControlMs) / totalMs : 0,
  };
}

/** Compact, human-readable duration ("38m", "4m12s", "0s"). */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${String(total)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function renderAttentionMetrics(m: AttentionMetrics): string {
  const pct = Math.round(m.attentionRatio * 1000) / 10;
  return [
    `total ${formatDuration(m.totalMs)}  ·  autonomous ${formatDuration(m.autonomousMs)}  ·  human ${formatDuration(m.heldMs + m.humanControlMs)}`,
    `attention ratio: ${String(pct)}%`,
    `interruptions: ${String(m.interruptions)} (${String(m.decisionsCreated)} decisions, ${String(m.takeovers)} takeovers)`,
  ].join('\n');
}
