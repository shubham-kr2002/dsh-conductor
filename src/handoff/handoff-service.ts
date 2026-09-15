/**
 * Handoff Service
 *
 * Builds a complete, structured handoff state from persisted Conductor
 * state (never from raw transcripts), so a new agent — or the same agent
 * after a restart — can continue without redoing or forgetting anything.
 */

import { randomUUID } from 'node:crypto';
import type { Execution } from '../domain/execution.js';
import { ExecutionNotFoundError } from '../domain/errors.js';
import type { IExecutionRepository } from '../storage/execution-repository.js';
import type { IEventRepository } from '../storage/event-repository.js';
import type { IDecisionRepository } from '../storage/decision-repository.js';
import type { IHandoffRepository } from '../storage/handoff-repository.js';
import type { StructuredHandoffState } from '../types/handoff.js';
import type { ConductorEvent } from '../types/event.js';
import type { ConductorDecision } from '../types/decision.js';

export interface HandoffServiceDeps {
  executionRepo: IExecutionRepository;
  eventRepo: IEventRepository;
  decisionRepo: IDecisionRepository;
  handoffRepo: IHandoffRepository;
}

export interface CreateHandoffOptions {
  fromAgentId: string;
  toAgentId?: string;
  /** Record the handoff as an execution event + HANDOFF_PENDING transition. */
  markExecution?: boolean;
}

function p(evt: ConductorEvent): Record<string, unknown> {
  const v = evt.payload as unknown;
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export class HandoffService {
  constructor(private readonly deps: HandoffServiceDeps) {}

  /** Assemble the structured handoff state and persist it. */
  public createHandoff(
    executionId: string,
    opts: CreateHandoffOptions,
  ): StructuredHandoffState {
    const execution = this.deps.executionRepo.findById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);

    const events = this.deps.eventRepo.listByExecution(executionId);
    const decisions = this.deps.decisionRepo.list({ executionId });

    const passing = new Set<string>();
    const failing = new Set<string>();
    const failedAttempts: StructuredHandoffState['failedAttempts'] = [];

    for (const evt of events) {
      if (evt.type === 'test.passed') {
        const name = String(p(evt).testName ?? 'unnamed test');
        passing.add(name);
        failing.delete(name);
      } else if (evt.type === 'test.failed') {
        const name = String(p(evt).testName ?? 'unnamed test');
        failing.add(name);
        passing.delete(name);
        failedAttempts.push({
          approach: `make "${name}" pass`,
          error: String(p(evt).error ?? 'test failure'),
        });
      } else if (evt.type === 'agent.blocked') {
        failedAttempts.push({
          approach: String(p(evt).attempt ?? 'current approach'),
          error: String(p(evt).reason ?? 'blocked'),
        });
      } else if (evt.type === 'command.completed' && (Number(p(evt).exitCode ?? 0) !== 0)) {
        failedAttempts.push({
          approach: `run \`${String(p(evt).command ?? 'command')}\``,
          error: `exit code ${String(p(evt).exitCode)}`,
        });
      }
    }

    const pendingDecisions = decisions.filter((d) => d.status === 'pending');
    const handoff: StructuredHandoffState = {
      handoffId: `hov-${randomUUID()}`,
      executionId,
      timestamp: Date.now(),
      fromAgentId: opts.fromAgentId,
      toAgentId: opts.toAgentId,
      goal: execution.goal,
      constraints: [...execution.constraints],
      currentPhase: execution.currentPhase,
      completedWork: [...execution.completedWork],
      workspace: {
        root: execution.workspace.root,
        filesModified: [...execution.workspace.filesModified],
        filesCreated: [...execution.workspace.filesCreated],
        filesDeleted: [...execution.workspace.filesDeleted],
      },
      importantDecisions: decisions.filter((d) => d.status !== 'cancelled'),
      failedAttempts: failedAttempts.slice(-15),
      tests: {
        passing: [...passing],
        failing: [...failing],
        pending: pendingDecisions.map((d) => `decision open: ${d.title}`),
      },
      risks: [...execution.risks],
      recommendedNextAction:
        execution.nextAction ??
        (pendingDecisions.length > 0
          ? 'Resolve open decisions before advancing.'
          : 'Continue from the current phase.'),
      contextSummary: summarize(execution, decisions, failing.size),
    };

    this.deps.handoffRepo.save(handoff);

    if (opts.markExecution !== false && execution.status !== 'HANDOFF_PENDING' && !execution.isTerminal()) {
      try {
        execution.requestHandoff(`Handoff ${handoff.handoffId} created`, opts.toAgentId);
        this.deps.executionRepo.save(execution);
      } catch {
        // State machine may legitimately reject (e.g. terminal raced); handoff record stands.
      }
    }

    return handoff;
  }

  /** Load a persisted handoff for a new agent to adopt. */
  public loadHandoff(handoffId: string): StructuredHandoffState {
    const h = this.deps.handoffRepo.findById(handoffId);
    if (!h) throw new Error(`Handoff "${handoffId}" not found.`);
    return h;
  }

  /**
   * Adopt a handoff: returns a ready-to-use prompt brief and (optionally)
   * marks the execution RUNNING again under the new agent.
   */
  public adoptHandoff(
    handoffId: string,
    toAgentId: string,
    opts: { resumeExecution?: boolean } = {},
  ): { handoff: StructuredHandoffState; brief: string } {
    const handoff = this.loadHandoff(handoffId);
    handoff.toAgentId = toAgentId;
    this.deps.handoffRepo.save(handoff);

    if (opts.resumeExecution !== false) {
      const execution = this.deps.executionRepo.findById(handoff.executionId);
      if (execution && execution.status === 'HANDOFF_PENDING') {
        execution.resume(`Adopted handoff ${handoffId} as agent ${toAgentId}`, 'system');
        execution.reassignAgent(toAgentId);
        this.deps.executionRepo.save(execution);
      }
    }

    return { handoff, brief: renderHandoffBrief(handoff) };
  }
}

function summarize(
  execution: Execution,
  decisions: ConductorDecision[],
  failingTests: number,
): string {
  const done = execution.completedWork.length;
  const open = decisions.filter((d) => d.status === 'pending').length;
  const settled = decisions.filter((d) => d.status !== 'pending' && d.status !== 'cancelled');
  const parts = [
    `Phase "${execution.currentPhase}" — ${execution.progressSummary}`,
    `Completed ${String(done)} unit(s) of work, ${String(settled.length)} decision(s) settled, ` +
      `${String(open)} decision(s) still open`,
  ];
  const latest = settled[settled.length - 1];
  if (latest) {
    const answer =
      latest.resolution?.customValue ?? latest.resolution?.selectedOptionId ?? latest.status;
    parts.push(`Latest settled decision: "${latest.title}" -> ${String(answer)}`);
  }
  if (failingTests > 0) parts.push(`${String(failingTests)} test(s) currently failing`);
  return parts.join('. ') + '.';
}

/** Markdown brief consumed by the incoming agent (replaces its transcript need). */
export function renderHandoffBrief(h: StructuredHandoffState): string {
  const lines: string[] = [
    '# Handoff Brief',
    '',
    `Execution \`${h.executionId}\` is being handed from \`${h.fromAgentId}\`` +
      (h.toAgentId ? ` to \`${h.toAgentId}\`` : '') +
      `. Trust this brief over any memory.`,
    '',
    '## Goal',
    h.goal,
    '',
  ];

  if (h.constraints.length > 0) {
    lines.push('## Constraints', ...h.constraints.map((c) => `- ${c}`), '');
  }
  lines.push('## Where things stand', h.contextSummary, '');
  if (h.completedWork.length > 0) {
    lines.push('## Completed (do NOT redo)', ...h.completedWork.map((w) => `- ${w}`), '');
  }
  const files = [
    ...h.workspace.filesCreated.map((f) => `created: ${f}`),
    ...h.workspace.filesModified.map((f) => `modified: ${f}`),
    ...h.workspace.filesDeleted.map((f) => `deleted: ${f}`),
  ];
  if (files.length > 0) {
    lines.push('## Workspace state', ...files.slice(0, 25), '');
  }
  if (h.importantDecisions.length > 0) {
    lines.push('## Decisions made (binding)');
    for (const d of h.importantDecisions) {
      const answer =
        d.resolution?.customValue ?? d.resolution?.selectedOptionId ?? d.status;
      lines.push(`- [${d.status}] ${d.title} — ${String(answer)}`);
    }
    lines.push('');
  }
  if (h.failedAttempts.length > 0) {
    lines.push('## Failed approaches (do NOT retry blindly)');
    for (const f of h.failedAttempts.slice(-8)) {
      lines.push(`- ${f.approach}: ${f.error}`);
    }
    lines.push('');
  }
  if (h.tests.passing.length > 0 || h.tests.failing.length > 0) {
    lines.push(
      '## Tests',
      `- passing: ${String(h.tests.passing.length)} (${h.tests.passing.slice(0, 5).join(', ')})`,
      `- failing: ${String(h.tests.failing.length)} (${h.tests.failing.slice(0, 5).join(', ')})`,
      '',
    );
  }
  if (h.risks.length > 0) {
    lines.push('## Risks', ...h.risks.map((r) => `- ${r}`), '');
  }
  lines.push('## Recommended next action', h.recommendedNextAction);
  return lines.join('\n');
}
