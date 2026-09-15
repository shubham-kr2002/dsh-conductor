/**
 * Away Mode
 *
 * Generates a return-from-absence summary optimized for the developer's
 * attention budget: what happened, what needs them, and what to do next —
 * a decision-oriented brief, not a transcript.
 */

import type { Execution } from '../domain/execution.js';
import type { ConductorEvent } from '../types/event.js';
import type { ConductorDecision } from '../types/decision.js';
import type { AttentionLevel } from '../types/attention.js';

export interface AwaySummary {
  executionId: string;
  goal: string;
  status: string;
  generatedAt: number;
  awaySince: number;
  humanAttentionMinutes: number;
  completedWork: string[];
  failures: string[];
  significantChanges: string[];
  decisionsRequired: Array<{ id: string; title: string; urgency: string; impact: string }>;
  decisionsResolved: Array<{ id: string; title: string; status: string }>;
  risks: string[];
  recommendedNextAction: string;
  needsYou: boolean;
}

export interface AwaySummaryInput {
  execution: Execution;
  events: ConductorEvent[];
  decisions: ConductorDecision[];
  /** Timestamp the developer went away (defaults to execution start). */
  since?: number;
  /** Wall-clock now, injectable for deterministic tests. */
  now?: number;
}

function attentionOf(evt: ConductorEvent): AttentionLevel | undefined {
  const a = evt.metadata?.attention as { level?: AttentionLevel } | undefined;
  return a?.level;
}

function isErrishEvent(evt: ConductorEvent): boolean {
  if (evt.type === 'test.failed' || evt.type === 'agent.blocked') return true;
  if (evt.type === 'command.completed') {
    const code = (evt.payload as Record<string, unknown>).exitCode as number | undefined;
    return (code ?? 0) !== 0;
  }
  return false;
}

export function buildAwaySummary(input: AwaySummaryInput): AwaySummary {
  const state = input.execution.toState();
  const now = input.now ?? Date.now();
  const since = input.since ?? state.timestamps.startedAt ?? state.timestamps.createdAt;
  const after = input.events.filter((e) => e.timestamp >= since);

  const failures: string[] = [];
  for (const e of after.filter(isErrishEvent)) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'test.failed') {
      failures.push(`test failed: ${String(p.testName ?? 'unknown')} — ${String(p.error ?? '')}`);
    } else if (e.type === 'agent.blocked') {
      failures.push(`agent blocked: ${String(p.reason ?? 'no reason')}`);
    } else {
      failures.push(`command failed (exit ${String(p.exitCode)}): ${String(p.command ?? '')}`);
    }
  }

  // Significant changes = workspace changes that were NOT silent (attention-worthy).
  const significantChanges: string[] = [];
  for (const e of after) {
    if (e.type !== 'file.changed') continue;
    const level = attentionOf(e);
    if (level === 'DECISION' || level === 'CRITICAL') {
      const p = e.payload as Record<string, unknown>;
      significantChanges.push(`${String(p.action ?? 'changed')} ${String(p.filePath ?? '?')} (${level.toLowerCase()})`);
    }
  }
  // Plus any files the human edited during a take-over.
  for (const i of state.interventions) {
    if (i.type === 'continue' && i.filesChanged) {
      for (const f of i.filesChanged) significantChanges.push(`human edited ${f}`);
    }
  }

  const pending = input.decisions.filter((d) => d.status === 'pending');
  const resolved = input.decisions.filter((d) => d.status !== 'pending');

  const needsYou = pending.length > 0 || state.status === 'PAUSED' || state.status === 'BLOCKED';

  const recommendedNextAction = recommend(state.status, pending, failures, after.length);

  return {
    executionId: state.executionId,
    goal: state.goal,
    status: state.status,
    generatedAt: now,
    awaySince: since,
    humanAttentionMinutes: roundMinutes(now - since),
    completedWork: state.completedWork,
    failures,
    significantChanges,
    decisionsRequired: pending
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((d) => ({ id: d.id, title: d.title, urgency: d.urgency, impact: d.impact })),
    decisionsResolved: resolved.map((d) => ({ id: d.id, title: d.title, status: d.status })),
    risks: state.risks,
    recommendedNextAction,
    needsYou,
  };
}

function recommend(
  status: string,
  pending: ConductorDecision[],
  failures: string[],
  eventCount: number,
): string {
  if (status === 'COMPLETED') return 'Nothing to do — the task finished while you were away.';
  if (status === 'FAILED') return 'Execution failed. Review failures, then take over or re-run.';
  if (status === 'BLOCKED') return 'The agent is blocked. Resolve the pending decision or take over.';
  if (pending.length > 0) {
    return `Resolve ${String(pending.length)} decision(s) with "conductor decisions", then continue.`;
  }
  if (status === 'PAUSED') return 'Execution is paused for your judgment. Review and continue.';
  if (failures.length > 0) return 'Some operations failed but the agent is handling them. Monitor or intervene.';
  if (eventCount === 0) return 'No new activity. The agent is still working — nothing needs you.';
  return 'Agent is progressing autonomously. No action required.';
}

function roundMinutes(ms: number): number {
  return Math.max(0, Math.round(ms / 60000));
}

export function renderAwaySummary(s: AwaySummary): string {
  const lines: string[] = [
    '=================================================================',
    '                   CONDUCTOR — WHILE YOU WERE AWAY              ',
    '=================================================================',
    `Goal:      ${s.goal}`,
    `Status:    [${s.status}]  (${String(s.humanAttentionMinutes)}m elapsed)`,
    '',
  ];

  const headline = s.needsYou
    ? '>> NEEDS YOUR ATTENTION'
    : '>> Agent handled it. Keep going.';
  lines.push(headline, '');

  if (s.decisionsRequired.length > 0) {
    lines.push('Decisions required:');
    for (const d of s.decisionsRequired) {
      lines.push(`  [!] ${d.title}  (${d.impact}/${d.urgency})  ${d.id}`);
    }
    lines.push('');
  }
  if (s.decisionsResolved.length > 0) {
    lines.push('Decisions already made:');
    for (const d of s.decisionsResolved) {
      lines.push(`  [-] ${d.title} -> ${d.status}`);
    }
    lines.push('');
  }
  if (s.completedWork.length > 0) {
    lines.push('Completed:');
    lines.push(...s.completedWork.map((w) => `  [+] ${w}`));
    lines.push('');
  }
  if (s.significantChanges.length > 0) {
    lines.push('Significant changes:');
    lines.push(...s.significantChanges.slice(0, 12).map((c) => `  [~] ${c}`));
    lines.push('');
  }
  if (s.failures.length > 0) {
    lines.push('Failures / retries:');
    lines.push(...s.failures.slice(0, 12).map((f) => `  [x] ${f}`));
    lines.push('');
  }
  if (s.risks.length > 0) {
    lines.push('Risks emerged:');
    lines.push(...s.risks.map((r) => `  [?] ${r}`));
    lines.push('');
  }

  lines.push('Recommended next action:');
  lines.push(`  ${s.recommendedNextAction}`);
  lines.push('=================================================================');
  return lines.join('\n');
}
