/**
 * Conductor Decision Types
 *
 * Persistent representation of human decisions requiring developer judgment.
 */

export type DecisionStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'custom'
  | 'expired'
  | 'cancelled';

export type DecisionUrgency = 'low' | 'medium' | 'high' | 'critical';
export type DecisionImpact = 'minor' | 'moderate' | 'major' | 'critical';

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  isRecommended?: boolean;
}

export interface DecisionResolution {
  status: 'accepted' | 'rejected' | 'custom';
  selectedOptionId?: string;
  customValue?: string;
  feedback?: string;
  resolvedAt: number;
  resolvedBy: string;
}

export interface ConductorDecision {
  id: string;
  executionId: string;
  title: string;
  question: string;
  context: string;
  options: DecisionOption[];
  recommendation?: string;
  impact: DecisionImpact;
  urgency: DecisionUrgency;
  confidence: number; // 0.0 - 1.0
  status: DecisionStatus;
  resolution?: DecisionResolution;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  /** ConductorEvent that produced this decision. */
  sourceEventId?: string;
  /** Coalescing key: pending decisions with the same key are not duplicated. */
  dedupeKey?: string;
  /** Normalized identity of the approved action (retry-matching across processes). */
  subject?: string;
  /** When a mounted gate consumed this approval for one retry (one-time token). */
  consumedAt?: number;
}
