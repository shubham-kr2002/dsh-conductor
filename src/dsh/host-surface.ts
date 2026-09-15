/**
 * Normalized DSH Host Surface
 *
 * Structural mirrors of the REAL DSH extension-point payloads and return
 * values (verified against dsh-tools, dsh-agent-loop, dsh-user-questions,
 * dsh-user-approval, dsh-session lib/types). Names and shapes match DSH so
 * the cordis mounting layer is a thin projection, and bridge logic stays
 * free of DSH imports while unit-testing against plain objects.
 */

/** Projection of dsh-tools `ToolExecution` (what Conductor reads). */
export interface HostToolExecution {
  callId: string;
  name: string;
  arguments: unknown; // parsed + deep-frozen by DSH
  agentId?: string;
}

/** dsh-tools PreToolDecision — exact union. */
export type HostPreToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason?: string };

/** Projection of the `tools/result` emit. */
export interface HostToolResult {
  callId: string;
  name: string;
  agentId?: string;
  isError: boolean;
  /** Concatenated text content blocks of the result. */
  text: string;
  /** Raw arguments from the originating call, when known. */
  arguments?: unknown;
}

/** Projection of dsh-user-questions AskUserQuestionRequestEvent. */
export interface HostQuestionRequest {
  questions: Array<{
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  agentId?: string;
}

/** dsh-user-questions AskUserQuestionAnswer — exact shape. */
export interface HostQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
}

/** Projection of the agent/pre-step payload + decision (dsh-agent-loop). */
export interface HostStepPayload {
  agentId?: string;
  turn: number;
  step: number;
  /** Inbox messages CLAIMED for this step. Must be re-injected if rejecting. */
  messages: unknown[];
}

export type HostPreStepDecision =
  | { kind: 'enter' }
  /**
   * reject closes the turn ('blocked') and CONSUMES claimed messages;
   * when `holdForHuman` the mount layer re-injects them with
   * agent.inject() (no wake) before rejecting, so nothing is lost.
   */
  | { kind: 'reject'; holdForHuman?: boolean };

/** Post-commit session-log entries Conductor ingests (dsh-session). */
export interface HostSessionEvent {
  type: string; // 'turn/start' | 'turn/end' | 'assistant/message' | ...
  seq?: number;
  time: number;
  data: Record<string, unknown>;
}

/** dsh-user-approval ApprovalOutcome. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/**
 * The extension-point surface the Conductor plugin binds to. Matches the
 * cordis waterfall listener signatures (returning a decision WITHOUT
 * calling next claims the interaction; returning undefined delegates).
 */
export interface ConductorHostBindings {
  on(event: 'session/event', handler: (evt: HostSessionEvent) => void): () => void;
  on(event: 'tools/result', handler: (result: HostToolResult) => void): () => void;
  on(
    event: 'tools/pre-execute',
    handler: (exec: HostToolExecution) => HostPreToolDecision | undefined,
  ): () => void;
  on(
    event: 'user-questions/request',
    handler: (req: HostQuestionRequest) => HostQuestionAnswer | undefined,
  ): () => void;
  on(
    event: 'agent/pre-step',
    handler: (payload: HostStepPayload) => HostPreStepDecision | undefined,
  ): () => void;
  on(
    event: 'approval/request',
    handler: (req: { toolName: string; agentId?: string; reason?: string }) => HostApprovalOutcome | undefined,
  ): () => void;
}
