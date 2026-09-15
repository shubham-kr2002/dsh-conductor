/**
 * Decision Queue
 *
 * Persistent queue of human decisions, prioritized by consequence and
 * urgency. The developer resolves decisions with accept / reject / custom
 * answers, without ever reading the execution transcript.
 */

import { randomUUID } from 'node:crypto';
import type { IDecisionRepository } from '../storage/decision-repository.js';
import type {
  ConductorDecision,
  DecisionImpact,
  DecisionOption,
  DecisionUrgency,
} from '../types/decision.js';
import type { IExecutionRepository } from '../storage/execution-repository.js';
import { DecisionNotFoundError } from '../domain/errors.js';

export interface CreateDecisionInput {
  executionId: string;
  title: string;
  question: string;
  context: string;
  options?: DecisionOption[];
  recommendation?: string;
  impact: DecisionImpact;
  urgency: DecisionUrgency;
  confidence: number;
  /** Link back to the ConductorEvent that triggered this decision. */
  sourceEventId?: string;
  ttlMs?: number;
}

const IMPACT_WEIGHT: Record<DecisionImpact, number> = {
  minor: 0,
  moderate: 1,
  major: 2,
  critical: 3,
};

const URGENCY_WEIGHT: Record<DecisionUrgency, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Deterministic priority score: consequence dominates, urgency breaks ties,
 * then lower confidence (more ambiguity needing judgment) ranks higher,
 * then FIFO on age.
 */
export function decisionPriority(d: ConductorDecision): number {
  return (
    IMPACT_WEIGHT[d.impact] * 1_000_000 +
    URGENCY_WEIGHT[d.urgency] * 1_000 +
    Math.round((1 - d.confidence) * 100)
  );
}

export class DecisionQueue {
  constructor(
    private readonly decisionRepo: IDecisionRepository,
    private readonly executionRepo: IExecutionRepository,
  ) {}

  public create(input: CreateDecisionInput): ConductorDecision {
    const now = Date.now();
    const decision: ConductorDecision = {
      id: `dec-${randomUUID()}`,
      executionId: input.executionId,
      title: input.title,
      question: input.question,
      context: input.context,
      options: input.options ?? [],
      recommendation: input.recommendation,
      impact: input.impact,
      urgency: input.urgency,
      confidence: input.confidence,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt: input.ttlMs ? now + input.ttlMs : undefined,
    };
    this.decisionRepo.save(decision);

    const execution = this.executionRepo.findById(input.executionId);
    if (execution) {
      execution.addDecision(decision.id);
      this.executionRepo.save(execution);
    }
    return decision;
  }

  /** Pending decisions, highest priority first. */
  public pending(executionId?: string): ConductorDecision[] {
    this.expireStale(executionId);
    return this.decisionRepo
      .list({ status: 'pending', ...(executionId ? { executionId } : {}) })
      .sort((a, b) => {
        const pa = decisionPriority(a);
        const pb = decisionPriority(b);
        if (pb !== pa) return pb - pa;
        return a.createdAt - b.createdAt; // FIFO tie-break
      });
  }

  public get(id: string): ConductorDecision {
    const d = this.decisionRepo.findById(id);
    if (!d) throw new DecisionNotFoundError(id);
    return d;
  }

  /** All decisions (any status) for an execution, in priority order. */
  public list(executionId?: string): ConductorDecision[] {
    return this.decisionRepo
      .list(executionId ? { executionId } : {})
      .sort((a, b) => {
        const pa = decisionPriority(a);
        const pb = decisionPriority(b);
        if (pb !== pa) return pb - pa;
        return a.createdAt - b.createdAt;
      });
  }

  /**
   * Resolve a decision. `accept` picks the recommended/first option,
   * `reject` declines, `custom` supplies developer text (optionally
   * naming an option). Returns the updated decision.
   */
  public resolve(
    id: string,
    outcome: 'accepted' | 'rejected' | 'custom',
    opts: {
      answerBy?: string;
      selectedOptionId?: string;
      customValue?: string;
      feedback?: string;
      resumeExecution?: boolean;
    } = {},
  ): ConductorDecision {
    const decision = this.get(id);
    if (decision.status !== 'pending') {
      // Idempotent: already resolved decisions keep their first resolution.
      return decision;
    }

    if (outcome === 'custom' && !opts.customValue && !opts.selectedOptionId) {
      throw new Error('Custom resolution requires customValue and/or selectedOptionId');
    }
    if (opts.selectedOptionId && decision.options.length > 0) {
      if (!decision.options.some((o) => o.id === opts.selectedOptionId)) {
        throw new Error(
          `Option "${opts.selectedOptionId}" does not exist on decision "${id}"`,
        );
      }
    }

    const now = Date.now();
    decision.status = outcome;
    decision.resolution = {
      status: outcome,
      selectedOptionId: opts.selectedOptionId,
      customValue: opts.customValue,
      feedback: opts.feedback,
      resolvedAt: now,
      resolvedBy: opts.answerBy ?? 'developer',
    };
    decision.updatedAt = now;
    this.decisionRepo.save(decision);

    if (opts.resumeExecution !== false) {
      this.maybeResume(decision.executionId);
    }
    return decision;
  }

  public cancel(id: string, reason = 'Cancelled'): ConductorDecision {
    const decision = this.get(id);
    if (decision.status !== 'pending') return decision;
    decision.status = 'cancelled';
    decision.updatedAt = Date.now();
    decision.resolution = undefined;
    this.decisionRepo.save(decision);
    this.maybeResume(decision.executionId);
    void reason;
    return decision;
  }

  /**
   * Resume the execution once no pending decision remains. BLOCKED keeps its
   * distinct semantics (explicit take-over/continue) and is never resumed by
   * decision resolution.
   */
  private maybeResume(executionId: string): void {
    const execution = this.executionRepo.findById(executionId);
    if (!execution) return;
    if (execution.isTerminal()) return;
    if (execution.status !== 'PAUSED') return;

    const remaining = this.decisionRepo.list({ status: 'pending', executionId });
    if (remaining.length > 0) return;

    execution.resume('All pending decisions resolved', 'human');
    this.executionRepo.save(execution);
  }

  /** Mark expired pending decisions; returns how many expired. */
  public expireStale(executionId?: string): number {
    const now = Date.now();
    const pend = this.decisionRepo.list({ status: 'pending', ...(executionId ? { executionId } : {}) });
    let count = 0;
    for (const d of pend) {
      if (d.expiresAt !== undefined && d.expiresAt <= now) {
        d.status = 'expired';
        d.updatedAt = now;
        this.decisionRepo.save(d);
        count += 1;
      }
    }
    return count;
  }
}
