/**
 * Continuation Context
 *
 * The structured, state-first description of an execution that lets an
 * agent (or a human) resume work without reading the transcript. Generated
 * at takeover-freeze and regenerated at continue time with the human's
 * modifications merged in. Never contains model reasoning — only
 * decisions, state, files, failures, and blockers.
 */

import type { Execution } from '../domain/execution.js';
import type { ConductorEvent } from '../types/event.js';
import type { ConductorDecision } from '../types/decision.js';
import type { WorkspaceDiff } from './workspace-snapshot.js';

export interface FailedApproach {
  attempt: string;
  error: string;
  at: number;
}

export interface DecisionSummary {
  title: string;
  status: string;
  answer?: string;
}

export interface HumanModificationSummary {
  created: string[];
  modified: string[];
  deleted: string[];
  notes?: string;
}

export interface ContinuationContext {
  generatedAt: number;
  executionId: string;
  workspaceRoot: string;
  originalGoal: string;
  constraints: string[];
  currentPhase: string;
  progressSummary: string;
  completedWork: string[];
  currentFiles: string[];
  importantDecisions: DecisionSummary[];
  failedApproaches: FailedApproach[];
  knownBlockers: string[];
  pendingAction?: string;
  humanModifications?: HumanModificationSummary;
}

const MAX_FAILED_APPROACHES = 10;
const MAX_CURRENT_FILES = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Derive the structured continuation context from persisted state + recent events. */
export function buildContinuationContext(input: {
  execution: Execution;
  recentEvents: ConductorEvent[];
  decisions: ConductorDecision[];
  humanModifications?: WorkspaceDiff & { notes?: string };
  maxRecentEvents?: number;
}): ContinuationContext {
  const { execution, recentEvents, decisions } = input;
  const recent = recentEvents.slice(-(input.maxRecentEvents ?? 40));

  const failedApproaches: FailedApproach[] = [];
  for (const evt of recent) {
    if (evt.type === 'test.failed') {
      const p = isRecord(evt.payload) ? evt.payload : {};
      failedApproaches.push({
        attempt: String(p.testName ?? p.command ?? 'test run'),
        error: String(p.error ?? 'test failure'),
        at: evt.timestamp,
      });
    } else if (evt.type === 'command.completed' && Number(p_of(evt).exitCode ?? 0) !== 0) {
      const p = p_of(evt);
      failedApproaches.push({
        attempt: String(p.command ?? 'command'),
        error: `exit code ${String(p.exitCode)}`,
        at: evt.timestamp,
      });
    } else if (evt.type === 'agent.blocked') {
      const p = p_of(evt);
      failedApproaches.push({
        attempt: String(p.attempt ?? 'current approach'),
        error: String(p.reason ?? 'agent blocked'),
        at: evt.timestamp,
      });
    }
  }
  failedApproaches.length = Math.min(failedApproaches.length, MAX_FAILED_APPROACHES);

  const importantDecisions: DecisionSummary[] = decisions
    .filter((d) => d.status !== 'expired' && d.status !== 'cancelled')
    .slice(-10)
    .map((d) => ({
      title: d.title,
      status: d.status,
      answer:
        d.resolution?.customValue ??
        d.resolution?.selectedOptionId ??
        (d.resolution ? d.resolution.status : undefined),
    }));

  const currentFiles = [
    ...execution.workspace.filesDeleted.map((f) => ({ path: f, kind: 'deleted' as const })),
    ...execution.workspace.filesModified.map((f) => ({ path: f, kind: 'modified' as const })),
    ...execution.workspace.filesCreated.map((f) => ({ path: f, kind: 'created' as const })),
  ]
    .slice(-MAX_CURRENT_FILES)
    .map((f) => `${f.kind}: ${f.path}`);

  const knownBlockers: string[] = [...execution.risks];
  const unresolved = decisions.filter((d) => d.status === 'pending');
  for (const d of unresolved) knownBlockers.push(`Awaiting human decision: ${d.title}`);
  if (execution.status === 'BLOCKED') {
    knownBlockers.push('Execution is BLOCKED — a human must decide how to proceed.');
  }

  const context: ContinuationContext = {
    generatedAt: Date.now(),
    executionId: execution.id,
    workspaceRoot: execution.workspace.root,
    originalGoal: execution.goal,
    constraints: [...execution.constraints],
    currentPhase: execution.currentPhase,
    progressSummary: execution.progressSummary,
    completedWork: [...execution.completedWork],
    currentFiles,
    importantDecisions,
    failedApproaches: failedApproaches.reverse(), // most recent first
    knownBlockers,
    pendingAction: execution.nextAction,
  };

  if (input.humanModifications) {
    const hm = input.humanModifications;
    context.humanModifications = {
      created: hm.created,
      modified: hm.modified,
      deleted: hm.deleted,
      notes: hm.notes,
    };
  }

  return context;
}

function p_of(evt: ConductorEvent): Record<string, unknown> {
  return isRecord(evt.payload) ? evt.payload : {};
}

/** Render the context as the resumption brief handed to the agent. */
export function renderContinuationBrief(ctx: ContinuationContext): string {
  const lines: string[] = [
    '# Continuation Brief',
    '',
    `You are resuming execution \`${ctx.executionId}\` in workspace \`${ctx.workspaceRoot}\`.`,
    'This brief replaces the transcript. Trust persisted state over memory.',
    '',
    '## Original goal',
    ctx.originalGoal,
    '',
  ];

  if (ctx.constraints.length > 0) {
    lines.push('## Constraints', ...ctx.constraints.map((c) => `- ${c}`), '');
  }

  lines.push('## Current phase', ctx.currentPhase, '', '## Progress', ctx.progressSummary, '');

  if (ctx.completedWork.length > 0) {
    lines.push(
      '## Completed work (do NOT redo)',
      ...ctx.completedWork.map((w) => `- ${w}`),
      '',
    );
  }

  if (ctx.currentFiles.length > 0) {
    lines.push('## Workspace files touched so far', ...ctx.currentFiles.map((f) => `- ${f}`), '');
  }

  if (ctx.importantDecisions.length > 0) {
    lines.push(
      '## Important decisions already made',
      ...ctx.importantDecisions.map(
        (d) => `- [${d.status}] ${d.title}${d.answer ? ` — answer: ${d.answer}` : ''}`,
      ),
      '',
    );
  }

  if (ctx.failedApproaches.length > 0) {
    lines.push(
      '## Failed approaches (do NOT retry these blindly)',
      ...ctx.failedApproaches.map((f) => `- ${f.attempt}: ${f.error}`),
      '',
    );
  }

  if (ctx.knownBlockers.length > 0) {
    lines.push('## Known blockers / risks', ...ctx.knownBlockers.map((b) => `- ${b}`), '');
  }

  if (ctx.humanModifications) {
    const hm = ctx.humanModifications;
    lines.push('## Human modifications made during take-over');
    lines.push(
      'A human edited the workspace while you were paused. The CURRENT workspace state is',
      'authoritative — reconcile with it, do not assume the old state.',
    );
    if (hm.created.length > 0) lines.push(`- created: ${hm.created.join(', ')}`);
    if (hm.modified.length > 0) lines.push(`- modified: ${hm.modified.join(', ')}`);
    if (hm.deleted.length > 0) lines.push(`- deleted: ${hm.deleted.join(', ')}`);
    if (hm.notes) lines.push(`- human notes: ${hm.notes}`);
    lines.push('');
  }

  if (ctx.pendingAction) {
    lines.push('## Pending action', ctx.pendingAction, '');
  }

  return lines.join('\n');
}
