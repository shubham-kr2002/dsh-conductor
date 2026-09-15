/**
 * Execution Manager
 *
 * Coordinates execution lifecycle, event processing, persistence, and state synchronization.
 */

import { Execution, type CreateExecutionOptions } from '../domain/execution.js';
import { ExecutionNotFoundError } from '../domain/errors.js';
import type { IExecutionRepository } from '../storage/execution-repository.js';
import type { IEventRepository } from '../storage/event-repository.js';
import type { ConductorEvent } from '../types/event.js';
import type { ExecutionState, ExecutionStatus } from '../types/execution.js';
import { PolicyEngine } from '../policy/policy-engine.js';
import { approvalSubject } from '../policy/approval-subject.js';
import { buildDecisionWhy } from '../attention/decision-why.js';
import type { PolicyEvaluationResult } from '../types/policy.js';
import {
  AttentionEngine,
  createAttentionContext,
  type AttentionContext,
} from '../attention/attention-engine.js';
import type { DecisionQueue, CreateDecisionInput } from '../decision/decision-queue.js';
import type {
  AttentionClassification,
  AttentionClassificationInput,
} from '../types/attention.js';
import { buildAwaySummary, type AwaySummary } from '../summary/away-mode.js';

export interface ExecutionStatusSummary {
  executionId: string;
  goal: string;
  status: ExecutionStatus;
  currentPhase: string;
  progressSummary: string;
  durationSeconds: number;
  toolCallCount: number;
  filesModifiedCount: number;
  pendingDecisionsCount: number;
  risksCount: number;
  completedWorkCount: number;
  updatedAt: number;
  pendingAttention: PendingAttentionItem[];
  attentionRequired: boolean;
}

export interface PendingAttentionItem {
  eventId: string;
  type: string;
  level: 'DECISION' | 'CRITICAL';
  action: string;
  rationale: string;
  timestamp: number;
}

export class ExecutionManager {
  private _activeExecutionId?: string;
  private readonly _subscribers: Array<(event: ConductorEvent) => void> = [];
  private readonly _attentionContexts: Map<string, AttentionContext> = new Map();
  private readonly _awayMarks: Map<string, number> = new Map();
  public decisions?: DecisionQueue;
  /** When true, PAUSE classifications transition the execution to PAUSED. */
  public enforceAttention = true;

  constructor(
    public readonly executionRepo: IExecutionRepository,
    public readonly eventRepo: IEventRepository,
    public readonly policyEngine: PolicyEngine = new PolicyEngine(),
    public readonly attentionEngine: AttentionEngine = new AttentionEngine(),
    decisions?: DecisionQueue,
  ) {
    this.decisions = decisions;
  }

  private attentionContext(executionId: string): AttentionContext {
    let ctx = this._attentionContexts.get(executionId);
    if (!ctx) {
      ctx = createAttentionContext();
      this._attentionContexts.set(executionId, ctx);
    }
    return ctx;
  }

  public get activeExecutionId(): string | undefined {
    return this._activeExecutionId;
  }

  public subscribe(handler: (event: ConductorEvent) => void): () => void {
    this._subscribers.push(handler);
    return () => {
      const idx = this._subscribers.indexOf(handler);
      if (idx >= 0) {
        this._subscribers.splice(idx, 1);
      }
    };
  }

  private notify(event: ConductorEvent): void {
    for (const sub of this._subscribers) {
      try {
        sub(event);
      } catch {
        // Observers must not break execution manager
      }
    }
  }

  public createExecution(options: CreateExecutionOptions): Execution {
    const execution = Execution.create(options);
    this.executionRepo.save(execution);
    this._activeExecutionId = execution.id;
    return execution;
  }

  public getExecution(executionId: string): Execution {
    const execution = this.executionRepo.findById(executionId);
    if (!execution) {
      throw new ExecutionNotFoundError(executionId);
    }
    return execution;
  }

  public getActiveExecution(): Execution | null {
    if (this._activeExecutionId) {
      const exec = this.executionRepo.findById(this._activeExecutionId);
      if (exec && exec.isActive()) {
        return exec;
      }
    }

    // Fallback to most recently updated active execution
    const activeList = this.executionRepo.list({ limit: 1 });
    const first = activeList[0];
    if (first && first.isActive()) {
      this._activeExecutionId = first.id;
      return first;
    }

    return null;
  }

  /**
   * Ingest and process a ConductorEvent:
   * classify through policy + attention, persist, mutate execution state,
   * then enforce the attention action (pause for PAUSE classifications).
   */
  public processEvent(event: ConductorEvent): AttentionClassification | null {
    const execution = this.executionRepo.findById(event.executionId);

    // 1. Classify (deterministic)
    let classification: AttentionClassification | null = null;
    if (execution) {
      const ctx = this.attentionContext(event.executionId);
      const isErrorLike =
        event.type === 'test.failed' ||
        (event.type === 'command.completed' &&
          ((event.payload.exitCode as number | undefined) ?? 0) !== 0);
      this.attentionEngine.updateContextFromEvent(ctx, event.type, isErrorLike);
      classification = this.attentionEngine.classify(
        this.deriveAttentionInput(execution, event),
        ctx,
      );
    }

    // 2. Persist the event (classification travels in metadata)
    const enriched: ConductorEvent = classification
      ? {
          ...event,
          metadata: {
            ...event.metadata,
            attention: {
              level: classification.level,
              action: classification.action,
              ruleId: classification.ruleId,
              rationale: classification.rationale,
              needsLlmReview: classification.needsLlmReview === true,
            },
          },
        }
      : event;
    this.eventRepo.save(enriched);

    // 3. Apply event and attention action to execution state
    if (execution && classification) {
      this.applyEventToExecution(execution, enriched);
      this.applyAttentionAction(execution, classification, enriched);
      this.executionRepo.save(execution);
    }

    // 4. Notify subscribers
    this.notify(enriched);
    return classification;
  }

  /** Map an event to attention-engine input using execution state + policy engine. */
  private deriveAttentionInput(
    execution: Execution,
    event: ConductorEvent,
  ): AttentionClassificationInput {
    const payload = event.payload as Record<string, unknown>;
    let consequence: AttentionClassificationInput['consequence'] = 'low';
    let reversibility: AttentionClassificationInput['reversibility'] = 'reversible';
    let uncertainty = 0.1;
    let policyImpact: AttentionClassificationInput['policyImpact'];

    switch (event.type) {
      case 'tool.called': {
        consequence = (payload.consequence as AttentionClassificationInput['consequence']) ?? 'medium';
        reversibility = (payload.reversibility as AttentionClassificationInput['reversibility']) ?? 'unknown';
        const evalResult = this.policyEngine.evaluateToolExecution(
          String(payload.toolName ?? ''),
          (payload.arguments as Record<string, unknown>) ?? {},
        );
        policyImpact = evalResult.action;
        if (evalResult.action === 'deny') {
          consequence = 'critical';
        } else if (evalResult.action === 'require_approval' && consequence !== 'critical') {
          consequence = 'high';
        }
        break;
      }
      case 'command.started': {
        const evalResult = this.policyEngine.evaluateShellCommand(String(payload.command ?? ''));
        policyImpact = evalResult.action;
        if (evalResult.action === 'deny') {
          consequence = 'critical';
        } else if (evalResult.action === 'require_approval') {
          consequence = 'high';
        } else {
          consequence = 'medium';
        }
        reversibility = 'unknown';
        break;
      }
      case 'command.completed': {
        const exitCode = (payload.exitCode as number | undefined) ?? 0;
        consequence = exitCode === 0 ? 'low' : 'medium';
        uncertainty = exitCode === 0 ? 0.1 : 0.3;
        break;
      }
      case 'file.changed': {
        const action = String(payload.action ?? 'modified');
        consequence = action === 'deleted' ? 'high' : 'medium';
        reversibility = action === 'deleted' ? 'unknown' : 'reversible';
        break;
      }
      case 'test.failed': {
        consequence = 'medium';
        uncertainty = 0.3;
        break;
      }
      case 'agent.question': {
        consequence = (payload.consequence as AttentionClassificationInput['consequence']) ?? 'medium';
        uncertainty = payload.recommendation ? 0.3 : 0.7;
        break;
      }
      case 'agent.blocked': {
        consequence = 'high';
        uncertainty = 0.8;
        break;
      }
      default:
        break;
    }

    const taskAligned = this.isTaskAligned(execution, event);

    return {
      eventType: event.type,
      consequence,
      reversibility,
      taskAligned,
      uncertainty,
      policyImpact,
      confidence: event.source === 'agent' ? 0.9 : 1,
    };
  }

  /** Heuristic task alignment: paths within the workspace root or goal keywords. */
  private isTaskAligned(execution: Execution, event: ConductorEvent): boolean {
    const payload = event.payload as Record<string, unknown>;
    const filePath = (payload.filePath as string) ?? (payload.file_path as string);
    if (filePath) {
      return (
        filePath.startsWith(execution.workspace.root) || !filePath.startsWith('/')
      );
    }
    const command = (payload.command as string) ?? '';
    const goalWords = execution.goal.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    if (command && goalWords.some((w) => command.toLowerCase().includes(w))) {
      return true;
    }
    return true;
  }

  /** Enforce the attention action on execution lifecycle. */
  private applyAttentionAction(
    execution: Execution,
    classification: AttentionClassification,
    event: ConductorEvent,
  ): void {
    if (!this.enforceAttention) return;
    if (classification.action !== 'PAUSE') return;
    if (execution.isTerminal()) return;

    const alreadyHeld =
      execution.status === 'PAUSED' || execution.status === 'BLOCKED';

    if (!alreadyHeld) {
      if (execution.status === 'RUNNING' || execution.status === 'STARTING') {
        execution.pause(classification.rationale, 'attention');
      } else if (execution.status === 'WAITING') {
        execution.pause(`Attention required: ${classification.rationale}`, 'attention');
      }
    }

    // Queue a durable, human-resolvable decision for every pause-worthy
    // event — even ones that arrive while the execution is already held.
    const created = this.decisions?.create(
      this.decisionInputFromEvent(execution, event, classification),
    );
    // create() records the decision reference on its own reloaded copy, but
    // the caller persists THIS in-memory aggregate next; without threading the
    // id back, the final save would clobber the reference and the count.
    if (created) execution.addDecision(created.id);
  }

  /** Build the developer-facing decision for a paused classification. */
  private decisionInputFromEvent(
    execution: Execution,
    event: ConductorEvent,
    classification: AttentionClassification,
  ): CreateDecisionInput {
    const payload = event.payload as Record<string, unknown>;
    const isCritical = classification.level === 'CRITICAL';

    let title = 'Execution paused — your judgment required';
    let question = classification.rationale;
    let context = `${event.type} at phase "${execution.currentPhase}"`;
    const options: Array<{ id: string; label: string; description?: string; isRecommended?: boolean }> = [];
    let recommendation = 'Reject and keep the workspace as-is';

    if (event.type === 'agent.question') {
      question = String(payload.question ?? question);
      context = String(payload.context ?? context);
      const rawOptions = Array.isArray(payload.options)
        ? (payload.options as Array<{ label: string; description?: string }>)
        : [];
      rawOptions.forEach((opt, idx) => {
        const recommended =
          payload.recommendedOption != null &&
          String(payload.recommendedOption) === opt.label;
        options.push({
          id: `opt-${String(idx)}`,
          label: opt.label,
          description: opt.description,
          isRecommended: recommended,
        });
      });
      if (payload.recommendedOption) {
        recommendation = String(payload.recommendedOption);
      }
    } else {
      const toolName = String(payload.toolName ?? '');
      const toolArgs = (payload.arguments as Record<string, unknown> | undefined) ?? {};
      const command = String(payload.command ?? toolArgs.command ?? '');
      const subject = command !== '' ? `command \`${command}\`` : `tool \`${toolName}\``;
      title = `${isCritical ? 'Dangerous' : 'Consequential'} ${subject}`;
      question = `The agent wants to run ${subject}. ${classification.rationale}`;
      const filePath =
        payload.filePath ?? toolArgs.file_path ?? toolArgs.path ?? '';
      context = [
        `Execution: ${execution.id}`,
        `Goal: ${execution.goal}`,
        `Event: ${event.id} (${event.type})`,
        String(filePath) !== '' ? `Path: ${String(filePath)}` : '',
      ]
        .filter((line) => line !== '')
        .join('\n');
      options.push(
        { id: 'approve-once', label: 'Approve once', description: 'Allow this action only', isRecommended: false },
        { id: 'deny', label: 'Reject', description: 'Do not run it; let the agent find another way', isRecommended: true },
      );
      recommendation = 'Reject and keep the workspace as-is';
    }

    return {
      executionId: execution.id,
      title,
      question,
      context,
      options,
      recommendation,
      impact: isCritical ? 'critical' : 'major',
      urgency: isCritical ? 'critical' : 'high',
      confidence: classification.confidence,
      sourceEventId: event.id,
      dedupeKey: dedupeKeyForEvent(event),
      subject: subjectForEvent(event),
      why: this.buildWhy(execution, event, classification, {
        impact: isCritical ? 'critical' : 'major',
        recommendation,
      }),
    };
  }

  /** Structured interruption explanation, from real pipeline inputs only. */
  private buildWhy(
    execution: Execution,
    event: ConductorEvent,
    classification: AttentionClassification,
    decided: { impact: 'major' | 'critical'; recommendation?: string },
  ): import('../types/decision.js').DecisionWhy {
    const derived = this.deriveAttentionInput(execution, event);
    const payload = event.payload as Record<string, unknown>;
    let policy: PolicyEvaluationResult | undefined;
    if (event.type === 'tool.called' && typeof payload.toolName === 'string') {
      policy = this.policyEngine.evaluateToolExecution(
        payload.toolName,
        (payload.arguments as Record<string, unknown>) ?? {},
      );
    } else if (event.type === 'command.started' && typeof payload.command === 'string') {
      policy = this.policyEngine.evaluateShellCommand(payload.command);
    }
    return buildDecisionWhy({
      event,
      classification,
      policy,
      ambiguity: derived.uncertainty,
      taskAligned: derived.taskAligned,
      impact: decided.impact,
      ...(decided.recommendation ? { recommendation: decided.recommendation } : {}),
    });
  }

  private applyEventToExecution(execution: Execution, event: ConductorEvent): void {
    switch (event.type) {
      case 'execution.started': {
        if (execution.status === 'STARTING') {
          execution.start(event.source === 'human' ? 'human' : 'system');
        }
        break;
      }

      case 'execution.completed': {
        // Only states that legally reach COMPLETED. Held states (PAUSED,
        // BLOCKED, TAKEN_OVER) must NOT be completed by a turn-end: the
        // event is recorded, the run keeps waiting for the human, who may
        // resolve and let the next turn finish it. STARTING cannot complete.
        if (execution.status === 'RUNNING' || execution.status === 'WAITING' || execution.status === 'HANDOFF_PENDING') {
          const summary = (event.payload.summary as string) || 'Execution completed';
          execution.complete(summary);
        }
        break;
      }

      case 'execution.failed': {
        if (
          execution.status === 'STARTING' ||
          execution.status === 'RUNNING' ||
          execution.status === 'WAITING' ||
          execution.status === 'TAKEN_OVER' ||
          execution.status === 'BLOCKED' ||
          execution.status === 'HANDOFF_PENDING'
        ) {
          const err = (event.payload.error as string) || 'Execution failed';
          execution.fail(err);
        }
        break;
      }

      case 'tool.called': {
        execution.recordToolCall();
        break;
      }

      case 'command.completed': {
        const exitCode = (event.payload.exitCode as number) ?? 0;
        execution.recordCommand(exitCode);
        break;
      }

      case 'file.changed': {
        const filePath = (event.payload.filePath as string) ?? '';
        const action = (event.payload.action as 'created' | 'modified' | 'deleted') ?? 'modified';
        if (filePath) {
          execution.recordFileChange(filePath, action);
        }
        break;
      }

      case 'test.passed': {
        execution.recordTestRun(true);
        break;
      }

      case 'test.failed': {
        execution.recordTestRun(false);
        break;
      }

      case 'agent.blocked': {
        if (execution.isActive() && execution.status !== 'BLOCKED') {
          const reason = (event.payload.reason as string) || 'Agent blocked';
          execution.block(reason);
        }
        break;
      }

      default:
        break;
    }
  }

  public getStatus(executionId?: string): ExecutionStatusSummary {
    const exec = executionId
      ? this.getExecution(executionId)
      : this.getActiveExecution();

    if (!exec) {
      throw new Error(
        executionId
          ? `Execution "${executionId}" not found`
          : 'No active execution found',
      );
    }

    const state = exec.toState();
    const durationSeconds = Math.round(
      (state.metrics.durationMs || (Date.now() - state.timestamps.createdAt)) / 1000,
    );
    const pendingAttention = this.getPendingAttention(state.executionId);

    return {
      executionId: state.executionId,
      goal: state.goal,
      status: state.status,
      currentPhase: state.currentPhase,
      progressSummary: state.progressSummary,
      durationSeconds,
      toolCallCount: state.metrics.toolCallCount,
      filesModifiedCount: state.metrics.filesChangedCount,
      pendingDecisionsCount: state.decisions.length,
      risksCount: state.risks.length,
      completedWorkCount: state.completedWork.length,
      updatedAt: state.timestamps.updatedAt,
      pendingAttention,
      attentionRequired:
        pendingAttention.length > 0 ||
        state.status === 'PAUSED' ||
        state.status === 'BLOCKED' ||
        state.status === 'WAITING',
    };
  }

  /**
   * Scan persisted event classifications for unresolved DECISION/CRITICAL items.
   * An item counts as pending when it is not older than the execution's last
   * resume/continue transition.
   */
  public getPendingAttention(executionId?: string): PendingAttentionItem[] {
    const id = executionId ?? this.getActiveExecution()?.id;
    if (!id) return [];
    const exec = this.executionRepo.findById(id);
    if (!exec) return [];

    const lastResume = exec.transitions
      .filter(
        (t) =>
          t.to === 'RUNNING' &&
          (t.actor === 'human' || t.metadata?.attentionResolved === true),
      )
      .reduce((max, t) => Math.max(max, t.timestamp), 0);

    const events = this.eventRepo.listByExecution(id);
    const pending: PendingAttentionItem[] = [];
    for (const evt of events) {
      const attention = evt.metadata?.attention as
        | { level?: string; action?: string; rationale?: string }
        | undefined;
      if (!attention) continue;
      if (attention.level !== 'DECISION' && attention.level !== 'CRITICAL') continue;
      if (evt.timestamp <= lastResume) continue;
      pending.push({
        eventId: evt.id,
        type: evt.type,
        level: attention.level as 'DECISION' | 'CRITICAL',
        action: attention.action ?? 'PAUSE',
        rationale: attention.rationale ?? '',
        timestamp: evt.timestamp,
      });
    }
    return pending;
  }

  public getHistory(
    executionId?: string,
    options: { limit?: number; offset?: number } = {},
  ): ConductorEvent[] {
    const id = executionId ?? this.getActiveExecution()?.id;
    if (!id) {
      return [];
    }
    return this.eventRepo.listByExecution(id, options);
  }

  // ---------------------------------------------------------------------------
  // Away mode
  // ---------------------------------------------------------------------------

  /** Mark "the developer stepped away" — persisted as a human-sourced event. */
  public markAway(executionId?: string, actor = 'developer'): number {
    const id = executionId ?? this.getActiveExecution()?.id;
    if (!id) throw new ExecutionNotFoundError(id ?? '<none>');
    const now = Date.now();
    const evt: ConductorEvent = {
      id: `evt-away-${now.toString(36)}`,
      executionId: id,
      type: 'human.intervention',
      timestamp: now,
      payload: { action: 'mark_away', actor, notes: 'Developer stepped away' },
      source: 'human',
    };
    this.eventRepo.save(evt);
    this._awayMarks.set(id, now);
    return now;
  }

  /**
   * Build the "while you were away" summary. The window starts at the last
   * explicit away-mark (persisted), else at the last human resume/continue,
   * else at execution start.
   */
  public getAwaySummary(executionId?: string, now = Date.now()): AwaySummary {
    const id = executionId ?? this.getActiveExecution()?.id;
    if (!id) throw new ExecutionNotFoundError(id ?? '<none>');
    const execution = this.executionRepo.findById(id);
    if (!execution) throw new ExecutionNotFoundError(id);

    const events = this.eventRepo.listByExecution(id);

    let since =
      this._awayMarks.get(id) ??
      events
        .filter(
          (e) =>
            e.type === 'human.intervention' &&
            (e.payload as Record<string, unknown>).action === 'mark_away',
        )
        .reduce((max, e) => Math.max(max, e.timestamp), 0);

    if (since === 0) {
      since = execution.transitions
        .filter((t) => t.actor === 'human' && (t.to === 'RUNNING' || t.to === 'TAKEN_OVER'))
        .reduce((max, t) => Math.max(max, t.timestamp), 0);
    }
    if (since === 0) since = execution.timestamps.createdAt;

    const decisions = this.decisions ? this.decisions.list(id) : [];
    return buildAwaySummary({ execution, events, decisions, since, now });
  }
}

/**
 * Collapse all events produced by ONE underlying tool call (tool.called +
 * command.started / file.changed / agent.question) into a single human-facing
 * decision via the shared call id.
 */
/**
 * Normalized identity of the action a decision is about — the mounted gate
 * matches an accepted decision's subject against the agent's retried call.
 */
function subjectForEvent(event: ConductorEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === 'tool.called' && typeof payload.toolName === 'string') {
    return approvalSubject(payload.toolName, (payload.arguments as Record<string, unknown>) ?? {});
  }
  if (event.type === 'command.started' && typeof payload.command === 'string') {
    return approvalSubject('bash', { command: payload.command });
  }
  return undefined;
}

function dedupeKeyForEvent(event: ConductorEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['callId', 'commandId', 'questionId'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return `${event.executionId}:${value}`;
    }
  }
  return undefined;
}
