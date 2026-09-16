/**
 * Human delegation
 *
 * What this human has explicitly entrusted to the agent — a distinct
 * concept from Policy (what Conductor is configured to allow), Decision
 * (what the human answered for one event), and Intent (what the human is
 * trying to accomplish). Delegations are scoped, expiring, revocable,
 * audited, and ALWAYS subordinate to an explicit current denial.
 */

import type { PolicyCategory } from './policy.js';

export type DelegationScope = 'execution' | 'workspace';

/** v1 has one authority: the action may proceed without interrupting. */
export type DelegationAuthority = 'allow-autonomously';

export type DelegationOrigin =
  /** Granted deliberately via CLI/UI. */
  | 'developer'
  /** Granted by accepting a recurrence offer built from decision memory. */
  | 'recurrence-offer';

export interface Delegation {
  id: string;
  /** 'execution' binds one run; 'workspace' binds every run on this plane. */
  scope: DelegationScope;
  /** Required when scope === 'execution'. */
  executionId: string | null;
  /** Which policy category this carries; 'any' is deliberately rare. */
  category: PolicyCategory | 'any';
  /**
   * Optional narrowing: case-insensitive substring of the command or file
   * path actually affected. None means the whole category is covered.
   */
  resourcePattern: string | null;
  authority: DelegationAuthority;
  origin: DelegationOrigin;
  grantedBy: string;
  grantedAt: number;
  /** Explicit expiry or null = until revoked (audited either way). */
  expiresAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  /** Human sentence recorded at grant time ("why"), for the audit trail. */
  note?: string;
}

export interface DelegationIsCovered {
  executionId: string;
  /** Policy category of the action being evaluated. */
  category: PolicyCategory | 'any';
  ruleId?: string;
  /** Command text / file path, used for resourcePattern narrowing. */
  resource?: string;
  /** approvalSubject() of the action, used for the denial-shadow check. */
  subject?: string;
  now: number;
}
