/**
 * Delegation service
 *
 * The single place that answers "may this action proceed without the
 * human, on the human's own standing authority?" and offers (never
 * creates) delegations from decision-memory recurrence. Explicit current
 * human denial always outranks historical delegation.
 */

import { randomUUID } from 'node:crypto';
import type { Delegation, DelegationIsCovered, DelegationOrigin } from '../types/delegation.js';
import type { PolicyCategory } from '../types/policy.js';
import type { IDelegationRepository } from '../storage/delegation-repository.js';
import type { IDecisionRepository } from '../storage/decision-repository.js';
import type { ConductorDecision } from '../types/decision.js';

export interface GrantDelegationInput {
  scope: Delegation['scope'];
  executionId?: string;
  category: PolicyCategory | 'any';
  resourcePattern?: string;
  grantedBy: string;
  origin?: DelegationOrigin;
  /** Milliseconds from now; omit for no expiry. */
  ttlMs?: number;
  note?: string;
}

export interface CoverResult {
  delegation: Delegation;
  reason: string;
}

export interface DelegationServiceDeps {
  delegationRepo: IDelegationRepository;
  decisionRepo: IDecisionRepository;
}

export class DelegationError extends Error {}

export class DelegationService {
  constructor(private readonly deps: DelegationServiceDeps) {}

  /** Grant a delegation. Explicit, scoped, audited; never from an agent. */
  public grant(input: GrantDelegationInput, now = Date.now()): Delegation {
    if (!input.grantedBy || input.grantedBy === '') throw new DelegationError('grantedBy is required');
    if (input.scope === 'execution' && !input.executionId) {
      throw new DelegationError('execution scope requires executionId');
    }
    const delegation: Delegation = {
      id: `dl-${randomUUID()}`,
      scope: input.scope,
      executionId: input.scope === 'execution' ? input.executionId ?? null : null,
      category: input.category,
      resourcePattern: input.resourcePattern ? input.resourcePattern.toLowerCase() : null,
      authority: 'allow-autonomously',
      origin: input.origin ?? 'developer',
      grantedBy: input.grantedBy,
      grantedAt: now,
      expiresAt: input.ttlMs ? now + input.ttlMs : null,
      revokedAt: null,
      revokedBy: null,
      ...(input.note ? { note: input.note } : {}),
    };
    this.deps.delegationRepo.save(delegation);
    return delegation;
  }

  public revoke(id: string, by: string, now = Date.now()): Delegation {
    const d = this.deps.delegationRepo.findById(id);
    if (!d) throw new DelegationError(`delegation not found: ${id}`);
    if (d.revokedAt != null) return d; // idempotent
    d.revokedAt = now;
    d.revokedBy = by;
    this.deps.delegationRepo.save(d);
    return d;
  }

  public list(opts: { active?: boolean; now?: number } = {}): Delegation[] {
    if (opts.active) return this.deps.delegationRepo.listActive(opts.now ?? Date.now());
    return this.deps.delegationRepo.listAll();
  }

  /**
   * Is `action` covered by a standing delegation right now?
   * Denial-shadow rule: if the most recent human verdict on the SAME
   * subject (in the same execution) was a rejection that came after the
   * delegation was granted, the delegation does NOT apply — explicit
   * human authority beats historical entrustment.
   */
  public covers(input: DelegationIsCovered): CoverResult | null {
    const active = this.deps.delegationRepo.listActive(input.now, input.executionId);
    const resource = input.resource?.toLowerCase() ?? '';
    for (const d of active) {
      if (d.category !== 'any' && d.category !== input.category) continue;
      if (d.resourcePattern && resource !== '' && !resource.includes(d.resourcePattern)) continue;
      if (d.scope === 'execution' && d.executionId !== input.executionId) continue;
      if (this.denialShadows(d, input)) continue;
      return {
        delegation: d,
        reason: `covered by delegation ${d.id} (${d.category}${d.resourcePattern ? ` ~${d.resourcePattern}` : ''}, granted by ${d.grantedBy})`,
      };
    }
    return null;
  }

  private denialShadows(d: Delegation, input: DelegationIsCovered): boolean {
    if (!input.subject) return false;
    const sameSubject = this.deps.decisionRepo
      .list({ executionId: input.executionId })
      .filter((x) => x.subject === input.subject && x.resolution != null);
    if (sameSubject.length === 0) return false;
    const latest = sameSubject.reduce((a, b) =>
      (b.resolution as { resolvedAt: number }).resolvedAt > (a.resolution as { resolvedAt: number }).resolvedAt ? b : a,
    );
    const res = latest.resolution as NonNullable<ConductorDecision['resolution']>;
    return latest.status === 'rejected' && res.resolvedAt > d.grantedAt;
  }

  /**
   * Decision memory: recurring accepted categories, surfaced as offers.
   * This NEVER grants anything — the human decides (Part 14).
   */
  public suggestions(opts: {
    decisions: ConductorDecision[];
    /** Map a policy rule id to its category (from PolicyEngine.getRules). */
    ruleCategory: (ruleId: string) => PolicyCategory | undefined;
    minCount?: number;
    now?: number;
  }): Array<{
    category: PolicyCategory;
    accepted: number;
    rejected: number;
    sampleTitles: string[];
    offer: string;
  }> {
    const min = opts.minCount ?? 2;
    const now = opts.now ?? Date.now();
    const byCat = new Map<PolicyCategory, ConductorDecision[]>();
    for (const d of opts.decisions) {
      const cat = d.why?.evidence.ruleIds
        .map((r) => opts.ruleCategory(r))
        .find((x): x is PolicyCategory => x !== undefined);
      if (!cat) continue;
      const list = byCat.get(cat) ?? [];
      list.push(d);
      byCat.set(cat, list);
    }
    const out: ReturnType<DelegationService['suggestions']> = [];
    const activeCats = new Set(
      this.deps.delegationRepo.listActive(now).filter((dl) => dl.scope === 'workspace').map((dl) => dl.category),
    );
    for (const [category, list] of byCat) {
      if (activeCats.has(category)) continue;
      const accepted = list.filter((d) => d.status === 'accepted' || d.status === 'custom');
      const rejected = list.filter((d) => d.status === 'rejected');
      if (accepted.length >= min && rejected.length === 0) {
        out.push({
          category,
          accepted: accepted.length,
          rejected: rejected.length,
          sampleTitles: accepted.slice(0, 3).map((d) => d.title),
          offer: `You have approved this category ${String(accepted.length)} times. Delegate future ${category} actions? (conductor delegate ${category})`,
        });
      }
    }
    return out.sort((a, b) => b.accepted - a.accepted);
  }
}
