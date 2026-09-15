/**
 * Conductor Handoff Types
 *
 * Structured state transferred between agents without dumping raw transcripts.
 */

import type { WorkspaceState } from './execution.js';
import type { ConductorDecision } from './decision.js';

export interface StructuredHandoffState {
  handoffId: string;
  executionId: string;
  timestamp: number;
  fromAgentId: string;
  toAgentId?: string;
  goal: string;
  constraints: string[];
  currentPhase: string;
  completedWork: string[];
  workspace: WorkspaceState;
  importantDecisions: ConductorDecision[];
  failedAttempts: Array<{ approach: string; error: string; lessonsLearned?: string }>;
  tests: { passing: string[]; failing: string[]; pending: string[] };
  risks: string[];
  recommendedNextAction: string;
  contextSummary: string;
}
