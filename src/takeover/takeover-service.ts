/**
 * Takeover Service
 *
 * The "Take Over" and "Continue" flows: freeze execution + capture the
 * observable workspace state + produce a continuation brief for the human;
 * then, on continue, detect what the human modified, reconcile it into the
 * execution state, and regenerate the brief for the agent.
 */

import { randomUUID } from 'node:crypto';
import type { Execution } from '../domain/execution.js';
import { ExecutionNotFoundError, TakeoverError } from '../domain/errors.js';
import type { IExecutionRepository } from '../storage/execution-repository.js';
import type { IEventRepository } from '../storage/event-repository.js';
import type { IDecisionRepository } from '../storage/decision-repository.js';
import type { ITakeoverRepository, TakeoverRecord } from '../storage/takeover-repository.js';
import {
  captureWorkspaceSnapshot,
  diffSnapshots,
  allChangedPaths,
  spawnGit,
  type GitRunner,
  type WorkspaceDiff,
} from './workspace-snapshot.js';
import {
  buildContinuationContext,
  renderContinuationBrief,
  type ContinuationContext,
} from './continuation-context.js';
import type { ConductorEvent } from '../types/event.js';

const STATUSES_ALLOWING_TAKEOVER = new Set([
  'STARTING',
  'RUNNING',
  'WAITING',
  'PAUSED',
  'BLOCKED',
]);

export interface TakeoverResult {
  execution: Execution;
  record: TakeoverRecord | null;
  context: ContinuationContext;
  brief: string;
}

export interface ContinueResult extends TakeoverResult {
  modifications: WorkspaceDiff;
}

export interface TakeoverServiceDeps {
  executionRepo: IExecutionRepository;
  eventRepo: IEventRepository;
  decisionRepo: IDecisionRepository;
  takeoverRepo: ITakeoverRepository;
  /** Override the git integration (e.g. in tests or sandboxes). */
  git?: GitRunner;
}

export class TakeoverService {
  private readonly git: GitRunner;

  constructor(private readonly deps: TakeoverServiceDeps) {
    this.git = deps.git ?? spawnGit;
  }

  /**
   * Freeze an execution, capture workspace state, and produce a
   * continuation context brief that the human can edit before continuing.
   */
  public takeOver(
    executionId: string,
    opts: { actor?: string; notes?: string } = {},
  ): TakeoverResult {
    const execution = this.getExecution(executionId);
    if (!STATUSES_ALLOWING_TAKEOVER.has(execution.status)) {
      throw new TakeoverError(
        executionId,
        `cannot take over while status is ${execution.status}`,
      );
    }

    const actor = opts.actor ?? 'developer';
    const snapshot = captureWorkspaceSnapshot(execution.workspace.root, this.git);
    const decisions = this.deps.decisionRepo.list({ executionId });
    const recentEvents = this.deps.eventRepo.listByExecution(executionId, { limit: 60 });

    execution.takeOver(actor, opts.notes);
    const context = buildContinuationContext({ execution, recentEvents, decisions });
    const brief = renderContinuationBrief(context);

    const record: TakeoverRecord = {
      id: `tov-${randomUUID()}`,
      executionId,
      actor,
      status: 'active',
      snapshot,
      continuation: context,
      notes: opts.notes,
      startedAt: Date.now(),
    };
    this.deps.takeoverRepo.save(record);
    this.deps.executionRepo.save(execution);
    this.deps.eventRepo.save(
      this.interventionEvent(executionId, 'take_over', actor, opts.notes, undefined),
    );

    return { execution, record, context, brief };
  }

  /**
   * Return control to the agent: detect the human's workspace edits,
   * reconcile them into the execution state, and regenerate the brief.
   * BLOCKED executions require an explicit decision first, not takeover.
   */
  public continue(
    executionId: string,
    opts: { actor?: string; notes?: string } = {},
  ): ContinueResult {
    const execution = this.getExecution(executionId);
    if (execution.status !== 'TAKEN_OVER') {
      throw new TakeoverError(
        executionId,
        `cannot continue — execution is not taken over (status: ${execution.status})`,
      );
    }

    const openRecord = this.deps.takeoverRepo.findActive(executionId);
    const after = captureWorkspaceSnapshot(execution.workspace.root, this.git);
    const modifications = openRecord
      ? diffSnapshots(openRecord.snapshot, after)
      : { created: [], modified: [], deleted: [], gitStatusAdded: [] };
    const changedFiles = allChangedPaths(modifications);

    const actor = opts.actor ?? 'developer';
    execution.continueFromTakeOver(actor, opts.notes, changedFiles);

    const decisions = this.deps.decisionRepo.list({ executionId });
    const recentEvents = this.deps.eventRepo.listByExecution(executionId, { limit: 60 });
    const context = buildContinuationContext({
      execution,
      recentEvents,
      decisions,
      humanModifications: { ...modifications, notes: opts.notes },
    });
    const brief = renderContinuationBrief(context);

    if (openRecord) {
      openRecord.status = 'returned';
      openRecord.humanModifications = modifications;
      openRecord.continuation = context;
      openRecord.returnedAt = Date.now();
      this.deps.takeoverRepo.save(openRecord);
    }

    this.deps.executionRepo.save(execution);
    this.deps.eventRepo.save(
      this.interventionEvent(executionId, 'continue', actor, opts.notes, changedFiles),
    );

    return { execution, record: openRecord, context, brief, modifications };
  }

  /** Read the latest continuation context for a taken-over execution. */
  public currentBrief(executionId: string): { context: ContinuationContext; brief: string } | null {
    const record = this.deps.takeoverRepo.findActive(executionId);
    if (!record) return null;
    return { context: record.continuation, brief: renderContinuationBrief(record.continuation) };
  }

  private getExecution(executionId: string): Execution {
    const execution = this.deps.executionRepo.findById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    return execution;
  }

  private interventionEvent(
    executionId: string,
    action: 'take_over' | 'continue',
    actor: string,
    notes: string | undefined,
    filesChanged: string[] | undefined,
  ): ConductorEvent {
    return {
      id: `evt-${randomUUID()}`,
      executionId,
      type: 'human.intervention',
      timestamp: Date.now(),
      payload: { action, actor, notes: notes ?? '', modifications: filesChanged ?? [] },
      source: 'human',
    };
  }
}
