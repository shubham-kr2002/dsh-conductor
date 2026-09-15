/**
 * Status language
 *
 * The developer should never have to learn a state machine. Each internal
 * ExecutionStatus gets exactly one primary human phrase answering "do I
 * need to care right now?" — the technical name remains available as
 * secondary detail (Part 13 of the product spec).
 */

import type { ExecutionStatus } from '../types/execution.js';

export interface StatusLanguage {
  /** Primary label shown in the UI. */
  label: string;
  /** One short line of meaning, for tooltips / detail views. */
  meaning: string;
  /** Visual tone: calm = no action, wait = human is busy elsewhere, alert = human needed, bad = broke, done = over. */
  tone: 'calm' | 'wait' | 'alert' | 'bad' | 'done';
  /** Does a human need to act for this run to move forward? */
  needsYou: boolean;
}

const LANGUAGE: Record<ExecutionStatus, StatusLanguage> = {
  STARTING: { label: 'Starting up', meaning: 'The agent is coming online.', tone: 'calm', needsYou: false },
  RUNNING: { label: 'Working autonomously', meaning: 'The agent is making progress on its own.', tone: 'calm', needsYou: false },
  WAITING: { label: 'Still working', meaning: 'The agent is mid-step, waiting on tool output.', tone: 'calm', needsYou: false },
  PAUSED: { label: 'Waiting for your judgment', meaning: 'A decision was raised; the run will not continue without you.', tone: 'alert', needsYou: true },
  BLOCKED: { label: 'Cannot continue safely', meaning: 'The agent hit something it should not pass through on its own.', tone: 'bad', needsYou: true },
  TAKEN_OVER: { label: 'You are in control', meaning: 'The agent is paused while you work in the workspace.', tone: 'wait', needsYou: true },
  HANDOFF_PENDING: { label: 'Handing over to a new agent', meaning: 'A structured handoff was prepared; adoption is pending.', tone: 'wait', needsYou: false },
  COMPLETED: { label: 'Done', meaning: 'The execution finished.', tone: 'done', needsYou: false },
  FAILED: { label: 'Failed', meaning: 'The execution ended in failure.', tone: 'bad', needsYou: false },
  CANCELLED: { label: 'Cancelled', meaning: 'The execution was cancelled.', tone: 'done', needsYou: false },
};

export function statusLanguage(status: ExecutionStatus): StatusLanguage {
  return LANGUAGE[status] ?? LANGUAGE.RUNNING;
}

/** Decision status as a human phrase. */
export function decisionStatusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'awaiting you';
    case 'accepted': return 'approved';
    case 'rejected': return 'rejected';
    case 'custom': return 'answered';
    case 'expired': return 'expired';
    case 'cancelled': return 'cancelled';
    default: return status;
  }
}
