/**
 * Conductor Execution State Types
 *
 * Defines the complete lifecycle states, state transitions, and persistent
 * state representation for an autonomous execution.
 */

export type ExecutionStatus =
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING'
  | 'PAUSED'
  | 'TAKEN_OVER'
  | 'BLOCKED'
  | 'HANDOFF_PENDING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface WorkspaceState {
  root: string;
  initialCommit?: string;
  currentCommit?: string;
  branch?: string;
  filesModified: string[];
  filesCreated: string[];
  filesDeleted: string[];
}

export interface AgentInfo {
  id: string;
  provider?: string;
  model?: string;
  preset?: string;
  delegationDepth?: number;
}

export interface HumanInterventionRecord {
  id: string;
  timestamp: number;
  type: 'take_over' | 'continue' | 'decision_resolved' | 'pause' | 'resume' | 'manual_edit';
  summary: string;
  actor: string;
  filesChanged?: string[];
  notes?: string;
}

export interface ExecutionMetrics {
  durationMs: number;
  toolCallCount: number;
  decisionCount: number;
  interventionCount: number;
  commandsExecuted: number;
  filesChangedCount: number;
  testsRunCount: number;
  testsFailedCount: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ExecutionTimestamps {
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
}

export interface StateTransitionRecord {
  from: ExecutionStatus;
  to: ExecutionStatus;
  timestamp: number;
  reason?: string;
  actor?: 'agent' | 'human' | 'system' | 'policy' | 'attention';
  metadata?: Record<string, unknown>;
}

export interface ExecutionState {
  executionId: string;
  goal: string;
  constraints: string[];
  status: ExecutionStatus;
  workspace: WorkspaceState;
  agent: AgentInfo;
  currentPhase: string;
  progressSummary: string;
  completedWork: string[];
  nextAction?: string;
  decisions: string[]; // references to Decision IDs
  interventions: HumanInterventionRecord[];
  risks: string[];
  metrics: ExecutionMetrics;
  timestamps: ExecutionTimestamps;
  transitions: StateTransitionRecord[];
}
