/**
 * Conductor Attention Types
 *
 * Classification output of the Attention Engine: how loudly (if at all)
 * an event should reach the developer, and what the system should do.
 */

/** How much developer attention an event warrants. */
export type AttentionLevel = 'SILENT' | 'BACKGROUND' | 'DECISION' | 'CRITICAL';

/** What the conductor should do with the event. */
export type AttentionAction = 'CONTINUE' | 'RECORD' | 'NOTIFY' | 'PAUSE';

export type Consequence = 'low' | 'medium' | 'high' | 'critical';
export type Reversibility = 'reversible' | 'irreversible' | 'unknown';

export interface AttentionClassificationInput {
  /** Canonical event type being classified. */
  eventType: string;
  /** Estimated consequence of the underlying action or question. */
  consequence: Consequence;
  /** Whether the action can be cheaply undone. */
  reversibility: Reversibility;
  /** Whether the event is aligned with the current execution goal/phase. */
  taskAligned: boolean;
  /** Ambiguity/uncertainty in the event (0.0 = fully certain, 1.0 = fully ambiguous). */
  uncertainty: number;
  /** Result of the Policy Engine for this event, if applicable. */
  policyImpact?: 'allow' | 'deny' | 'require_approval';
  /** Confidence of the classification itself (0.0 - 1.0). */
  confidence: number;
}

export interface AttentionClassification {
  level: AttentionLevel;
  action: AttentionAction;
  /** Human-readable explanation of why this classification was chosen. */
  rationale: string;
  /** Deterministic rule id that produced this classification. */
  ruleId: string;
  confidence: number;
  /**
   * True when deterministic rules could not confidently resolve the event.
   * Consumers may escalate to an LLM pass or conservative handling; the
   * classification itself remains fully deterministic.
   */
  needsLlmReview?: boolean;
}
