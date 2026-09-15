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
  /** Coalescing key: one pending decision per key (e.g. per tool-call id). */
  dedupeKey?: string;
  /** Normalized identity of the action awaiting this decision. */
  subject?: string;
  /** Structured explanation for the developer (built once at creation). */
  why?: import('../types/decision.js').DecisionWhy;
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

    if (input.dedupeKey) {
      const existing = this.decisionRepo
        .list({ status: 'pending', executionId: input.executionId })
        .find((d) => d.dedupeKey === input.dedupeKey);
      if (existing) {
        // Keep the loudest signal for the same underlying action.
        const candidate = decisionPriority(existing);
        const incoming = decisionPriority({
          ...existing,
          impact: input.impact,
          urgency: input.urgency,
          confidence: input.confidence,
        });
        if (incoming > candidate) {
          existing.impact = input.impact;
          existing.urgency = input.urgency;
          existing.confidence = input.confidence;
          existing.updatedAt = now;
          this.decisionRepo.save(existing);
        }
        return existing;
      }
    }

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
      sourceEventId: input.sourceEventId,
      dedupeKey: input.dedupeKey,
      subject: input.subject,
      why: input.why,
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

  /**
   * Record that a surface showed this decision to the human (observable
   * 'presented' fact, set once). Cheap no-op on already-presented/resolved.
   */
  public present(id: string): void {
    const d = this.decisionRepo.findById(id);
    if (!d || d.status !== 'pending' || d.quality?.presentedAt != null) return;
    d.quality = { ...d.quality, presentedAt: Date.now() };
    this.decisionRepo.save(d);
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
   * Resolve a decision. `accepted` approves the action (granting a
   * one-time retry token when the decision carries a `subject`),
   * `rejected` declines, `custom` supplies developer text (optionally
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

  /**
   * Cross-process approval token: consume one RESOLVED-APPROVED decision
   * whose subject matches the agent's retried action. Written by whichever
   * process resolved it (e.g. the CLI), read by the mounted plugin gate.
   * Approve-once semantics: returns true at most once per decision.
   */
  public consumeApproval(executionId: string, subject: string): boolean {
    const approved = this.decisionRepo
      .list({ executionId })
      .filter((d) => {
        if (d.subject !== subject || d.consumedAt != null) return false;
        if (d.status !== 'accepted' && d.status !== 'custom') return false;
        const res = d.resolution;
        if (!res) return false;
        // `accepted` = the human approved the action (the CLI's --accept and
        // any explicit approve option). Only an explicit deny pick fails to
        // grant the retry token.
        return res.selectedOptionId !== 'deny';
      })
      .sort((a, b) => (a.resolution?.resolvedAt ?? 0) - (b.resolution?.resolvedAt ?? 0));
    for (const token of approved) {
      // Atomic conditional claim: exactly one process wins even when both
      // read the row as unspent at the same time.
      if (this.decisionRepo.tryConsume(token.id, Date.now())) return true;
    }
    return false;
  }

  public cancel(id: string, reason = 'Cancelled'): ConductorDecision {    const decision = this.get(id);
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
