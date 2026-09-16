/**
 * Conductor Event Types
 *
 * Normalized internal event model for Conductor.
 * Conductor's core domain does not depend on specific DSH tools or internal types.
 */

export type ConductorEventType =
  | 'execution.started'
  | 'execution.completed'
  | 'execution.failed'
  | 'tool.called'
  | 'file.changed'
  | 'command.started'
  | 'command.completed'
  | 'test.failed'
  | 'test.passed'
  | 'agent.blocked'
  | 'agent.question'
  | 'agent.handoff'
  | 'human.intervention'
  | 'policy.delegated';

export type EventSource = 'dsh' | 'agent' | 'human' | 'conductor';

export interface BaseEventPayload {
  [key: string]: unknown;
}

export interface ExecutionStartedPayload extends BaseEventPayload {
  executionId: string;
  goal: string;
  workspaceRoot: string;
  constraints?: string[];
  agentId?: string;
  model?: string;
}

export interface ExecutionCompletedPayload extends BaseEventPayload {
  executionId: string;
  durationMs: number;
  completedWork: string[];
  summary: string;
}

export interface ExecutionFailedPayload extends BaseEventPayload {
  executionId: string;
  error: string;
  stack?: string;
  lastAction?: string;
}

export interface ToolCalledPayload extends BaseEventPayload {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  consequence?: 'low' | 'medium' | 'high' | 'critical';
  reversibility?: 'reversible' | 'irreversible';
}

export interface FileChangedPayload extends BaseEventPayload {
  filePath: string;
  action: 'created' | 'modified' | 'deleted';
  /** Underlying tool-call id (collapses related events into one decision). */
  callId?: string;
  diff?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface CommandStartedPayload extends BaseEventPayload {
  commandId: string;
  command: string;
  cwd: string;
}

export interface CommandCompletedPayload extends BaseEventPayload {
  commandId: string;
  command: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
}

export interface TestFailedPayload extends BaseEventPayload {
  testSuite?: string;
  testName: string;
  error: string;
  command?: string;
}

export interface TestPassedPayload extends BaseEventPayload {
  testSuite?: string;
  testName?: string;
  durationMs?: number;
  command?: string;
}

export interface AgentBlockedPayload extends BaseEventPayload {
  reason: string;
  blockerType: 'ambiguity' | 'permission' | 'error' | 'rate_limit' | 'unknown';
  attemptedAction?: string;
}

export interface AgentQuestionPayload extends BaseEventPayload {
  questionId: string;
  question: string;
  context?: string;
  options?: Array<{ label: string; description?: string }>;
  recommendedOption?: string;
}

export interface AgentHandoffPayload extends BaseEventPayload {
  fromAgentId: string;
  toAgentId?: string;
  handoffStateId: string;
  reason: string;
}

export interface HumanInterventionPayload extends BaseEventPayload {
  action:
    | 'take_over'
    | 'continue'
    | 'cancel'
    | 'pause'
    | 'resume'
    | 'decision_resolved'
    | 'mark_away'
    | 'message';
  actor: string;
  notes?: string;
  decisionId?: string;
  modifications?: string[];
}

export interface ConductorEvent<T = BaseEventPayload> {
  readonly id: string;
  readonly executionId: string;
  readonly type: ConductorEventType;
  readonly timestamp: number;
  readonly payload: T;
  readonly source: EventSource;
  readonly metadata?: Record<string, unknown>;
}
