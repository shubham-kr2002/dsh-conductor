/**
 * Conductor Attention Engine
 *
 * Deterministic, rule-based classifier that decides how loudly (if at all)
 * an event should reach the developer. The engine exists to SUPPRESS
 * unnecessary interruptions: low-risk autonomous work must never ping the
 * developer, while high-consequence ambiguity and dangerous actions must.
 *
 * Rules are ordered data — the first matching rule wins. No LLM calls.
 * A classification with `needsLlmReview: true` signals that deterministic
 * rules could not confidently resolve the event, and a human (or optionally
 * an LLM pass, out of scope here) should look closer.
 */

import type {
  AttentionClassification,
  AttentionClassificationInput,
  AttentionLevel,
  AttentionAction,
} from '../types/attention.js';

export interface AttentionRule {
  id: string;
  description: string;
  /** Higher priority runs first. */
  priority: number;
  when(input: AttentionClassificationInput, context: AttentionContext): boolean;
  classify(input: AttentionClassificationInput, context: AttentionContext): Omit<AttentionClassification, 'ruleId'>;
}

/** Mutable context the manager maintains across events for one execution. */
export interface AttentionContext {
  consecutiveTestFailures: number;
  consecutiveCommandFailures: number;
  eventsSinceLastNotification: number;
}

export function createAttentionContext(): AttentionContext {
  return {
    consecutiveTestFailures: 0,
    consecutiveCommandFailures: 0,
    eventsSinceLastNotification: 0,
  };
}

const QUESTION_TYPES = new Set(['agent.question', 'agent.blocked']);
const TERMINAL_TYPES = new Set(['execution.completed', 'execution.failed', 'human.intervention']);

export const DEFAULT_ATTENTION_RULES: AttentionRule[] = [
  {
    id: 'policy-deny',
    description: 'Policy engine denied the action: always pause',
    priority: 1000,
    when: (i) => i.policyImpact === 'deny',
    classify: () => ({
      level: 'CRITICAL',
      action: 'PAUSE',
      rationale: 'Policy denied this action. Execution must pause before it proceeds.',
      confidence: 1,
    }),
  },
  {
    id: 'critical-consequence',
    description: 'Critical consequence: pause',
    priority: 900,
    when: (i) => i.consequence === 'critical',
    classify: () => ({
      level: 'CRITICAL',
      action: 'PAUSE',
      rationale: 'Event has critical consequence; developer control required before proceeding.',
      confidence: 1,
    }),
  },
  {
    id: 'policy-approval',
    description: 'Policy requires approval: queue a decision and pause',
    priority: 800,
    when: (i) => i.policyImpact === 'require_approval',
    classify: () => ({
      level: 'DECISION',
      action: 'PAUSE',
      rationale: 'Policy flagged this action as requiring explicit approval.',
      confidence: 1,
    }),
  },
  {
    id: 'human-sourced-silent',
    description: 'Human interventions are authoritative; never re-notify the developer',
    priority: 700,
    when: (i) => i.eventType === 'human.intervention',
    classify: () => ({
      level: 'SILENT',
      action: 'CONTINUE',
      rationale: 'Event originated from the developer.',
      confidence: 1,
    }),
  },
  {
    id: 'terminal-silent',
    description: 'Execution terminal events are recorded for summaries, not interruptions',
    priority: 650,
    when: (i) => TERMINAL_TYPES.has(i.eventType),
    classify: (i) => ({
      level: 'BACKGROUND',
      action: 'RECORD',
      rationale: `Terminal lifecycle event (${i.eventType}) recorded for the away-mode summary.`,
      confidence: 1,
    }),
  },
  {
    id: 'blocked-agent',
    description: 'Agent blocked on ambiguity: queue a decision',
    priority: 600,
    when: (i) => i.eventType === 'agent.blocked' || (i.eventType === 'agent.question' && i.consequence === 'high'),
    classify: () => ({
      level: 'DECISION',
      action: 'PAUSE',
      rationale: 'Agent cannot resolve this ambiguity safely on its own; human judgment required.',
      confidence: 0.9,
    }),
  },
  {
    id: 'low-risk-question-suppressed',
    description: 'Low-consequence agent question with a clear recommendation: auto-resolve, stay silent',
    priority: 550,
    when: (i) =>
      QUESTION_TYPES.has(i.eventType) &&
      i.consequence === 'low' &&
      i.taskAligned &&
      i.confidence >= 0.6,
    classify: () => ({
      level: 'SILENT',
      action: 'CONTINUE',
      rationale:
        'Low-consequence question aligned with the task; the agent should proceed with its recommendation without interrupting the developer.',
      confidence: 0.85,
    }),
  },
  {
    id: 'irreversible-high',
    description: 'High consequence that cannot be undone: decide before it happens',
    priority: 500,
    when: (i) => i.consequence === 'high' && i.reversibility === 'irreversible',
    classify: () => ({
      level: 'DECISION',
      action: 'PAUSE',
      rationale: 'Irreversible high-consequence action detected; requires explicit human approval.',
      confidence: 0.95,
    }),
  },
  {
    id: 'ambiguous-high',
    description: 'High consequence with uncertainty: surface a decision',
    priority: 450,
    when: (i) => i.consequence === 'high' && i.uncertainty > 0.5,
    classify: () => ({
      level: 'DECISION',
      action: 'PAUSE',
      rationale: 'High-consequence event that the agent could not confidently resolve.',
      confidence: 0.8,
    }),
  },
  {
    id: 'test-failure-streak',
    description: 'Repeated test failures signal the agent is stuck: surface it',
    priority: 400,
    when: (i, ctx) => i.eventType === 'test.failed' && ctx.consecutiveTestFailures >= 3,
    classify: (_i, ctx) => ({
      level: 'DECISION',
      action: 'NOTIFY',
      rationale: `${String(ctx.consecutiveTestFailures)} consecutive test failures; the agent may need help choosing a different approach.`,
      confidence: 0.85,
    }),
  },
  {
    id: 'command-failure-streak',
    description: 'Repeated command failures signal a possible environment blocker',
    priority: 390,
    when: (i, ctx) =>
      i.eventType === 'command.completed' &&
      ctx.consecutiveCommandFailures >= 3,
    classify: (_i, ctx) => ({
      level: 'DECISION',
      action: 'NOTIFY',
      rationale: `${String(ctx.consecutiveCommandFailures)} consecutive command failures; check for environment or permission issues.`,
      confidence: 0.8,
    }),
  },
  {
    id: 'test-failure-self-heal',
    description: 'A single test failure is the agent\'s problem, not the developer\'s',
    priority: 300,
    when: (i) => i.eventType === 'test.failed',
    classify: () => ({
      level: 'BACKGROUND',
      action: 'RECORD',
      rationale: 'Test failure recorded; the agent is expected to iterate and fix it autonomously.',
      confidence: 0.9,
    }),
  },
  {
    id: 'high-certain-taskaligned',
    description: 'High consequence, unambiguous, task-aligned, reversible: keep working, notify in background',
    priority: 250,
    when: (i) => i.consequence === 'high' && i.taskAligned && i.uncertainty <= 0.5,
    classify: () => ({
      level: 'BACKGROUND',
      action: 'RECORD',
      rationale: 'Important but well-understood, task-aligned action. Recorded for review, no interruption.',
      confidence: 0.9,
    }),
  },
  {
    id: 'medium-consequence',
    description: 'Medium consequence: record for the away summary',
    priority: 200,
    when: (i) => i.consequence === 'medium',
    classify: () => ({
      level: 'BACKGROUND',
      action: 'RECORD',
      rationale: 'Medium-consequence event recorded; reversible and task-relevant.',
      confidence: 0.9,
    }),
  },
  {
    id: 'off-task-medium-plus',
    description: 'Event that is not task-aligned at medium+ consequence: ask',
    priority: 150,
    when: (i) => !i.taskAligned && (i.consequence === 'high' || i.consequence === 'critical'),
    classify: () => ({
      level: 'DECISION',
      action: 'PAUSE',
      rationale: 'Action appears unrelated to the stated goal; confirm intent before continuing.',
      confidence: 0.75,
    }),
  },
  {
    id: 'low-consequence-silent',
    description: 'Low consequence + reversible + task-aligned: silent',
    priority: 100,
    when: (i) => i.consequence === 'low',
    classify: () => ({
      level: 'SILENT',
      action: 'CONTINUE',
      rationale: 'Routine low-risk autonomous work. No developer attention required.',
      confidence: 0.95,
    }),
  },
  {
    id: 'fallback-record',
    description: 'Fallback: record without interrupting',
    priority: 0,
    when: () => true,
    classify: () => ({
      level: 'BACKGROUND',
      action: 'RECORD',
      rationale: 'Event did not match an explicit rule; recorded for later review.',
      confidence: 0.5,
    }),
  },
];

/** Below this confidence, deterministic rules are considered unable to resolve the event. */
export const LLM_REVIEW_CONFIDENCE_FLOOR = 0.55;

export class AttentionEngine {
  private readonly _rules: AttentionRule[];

  constructor(rules: AttentionRule[] = DEFAULT_ATTENTION_RULES) {
    this._rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  public getRules(): ReadonlyArray<AttentionRule> {
    return this._rules;
  }

  public addRule(rule: AttentionRule): void {
    this._rules.push(rule);
    this._rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Deterministically classify one event. Pure function of (input, context):
   * the same inputs always produce the same classification.
   */
  public classify(
    input: AttentionClassificationInput,
    context: AttentionContext = createAttentionContext(),
  ): AttentionClassification {
    for (const rule of this._rules) {
      if (rule.when(input, context)) {
        const base = rule.classify(input, context);
        return {
          ...base,
          ruleId: rule.id,
          needsLlmReview: base.confidence < LLM_REVIEW_CONFIDENCE_FLOOR,
        };
      }
    }

    // Unreachable: fallback rule always matches. Defensive for custom rule sets.
    return {
      level: 'BACKGROUND',
      action: 'RECORD',
      rationale: 'No rules matched; recorded conservatively.',
      ruleId: 'none',
      confidence: 0,
      needsLlmReview: true,
    };
  }

  /**
   * Convenience: derive a classification directly from an event payload shape
   * produced by the Event Adapter, folding counters into context.
   */
  public updateContextFromEvent(
    context: AttentionContext,
    eventType: string,
    isErrorLike: boolean,
  ): void {
    if (eventType === 'test.failed') {
      context.consecutiveTestFailures += 1;
    } else if (eventType === 'test.passed') {
      context.consecutiveTestFailures = 0;
    }

    if (eventType === 'command.completed' && isErrorLike) {
      context.consecutiveCommandFailures += 1;
    } else if (eventType === 'command.completed') {
      context.consecutiveCommandFailures = 0;
    }

    if (eventType !== 'tool.called' && eventType !== 'file.changed') {
      context.eventsSinceLastNotification += 1;
    }
  }
}

export function levelAtLeast(level: AttentionLevel, minimum: AttentionLevel): boolean {
  const order: Record<AttentionLevel, number> = {
    SILENT: 0,
    BACKGROUND: 1,
    DECISION: 2,
    CRITICAL: 3,
  };
  return order[level] >= order[minimum];
}

export function actionRequiresPause(action: AttentionAction): boolean {
  return action === 'PAUSE';
}
