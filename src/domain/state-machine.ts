/**
 * Execution State Machine
 *
 * Enforces valid state transitions and lifecycle rules for Conductor executions.
 */

import type { ExecutionStatus, StateTransitionRecord } from '../types/execution.js';
import { InvalidStateTransitionError } from './errors.js';

export const TERMINAL_STATES: ReadonlySet<ExecutionStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export const ACTIVE_STATES: ReadonlySet<ExecutionStatus> = new Set([
  'STARTING',
  'RUNNING',
  'WAITING',
  'PAUSED',
  'TAKEN_OVER',
  'BLOCKED',
  'HANDOFF_PENDING',
]);

export const VALID_TRANSITIONS: Readonly<Record<ExecutionStatus, ReadonlySet<ExecutionStatus>>> = {
  STARTING: new Set<ExecutionStatus>(['RUNNING', 'FAILED', 'CANCELLED']),
  RUNNING: new Set<ExecutionStatus>([
    'WAITING',
    'PAUSED',
    'TAKEN_OVER',
    'BLOCKED',
    'HANDOFF_PENDING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ]),
  WAITING: new Set<ExecutionStatus>([
    'RUNNING',
    'PAUSED',
    'TAKEN_OVER',
    'BLOCKED',
    'FAILED',
    'CANCELLED',
  ]),
  PAUSED: new Set<ExecutionStatus>(['RUNNING', 'TAKEN_OVER', 'CANCELLED']),
  TAKEN_OVER: new Set<ExecutionStatus>(['RUNNING', 'CANCELLED', 'FAILED']),
  BLOCKED: new Set<ExecutionStatus>([
    'RUNNING',
    'PAUSED',
    'TAKEN_OVER',
    'FAILED',
    'CANCELLED',
  ]),
  HANDOFF_PENDING: new Set<ExecutionStatus>([
    'COMPLETED',
    'RUNNING',
    'FAILED',
    'CANCELLED',
  ]),
  COMPLETED: new Set<ExecutionStatus>(),
  FAILED: new Set<ExecutionStatus>(),
  CANCELLED: new Set<ExecutionStatus>(),
};

export class ExecutionStateMachine {
  private _status: ExecutionStatus;
  private readonly _transitions: StateTransitionRecord[] = [];

  constructor(
    initialStatus: ExecutionStatus = 'STARTING',
    initialTransitions: StateTransitionRecord[] = [],
  ) {
    this._status = initialStatus;
    this._transitions = [...initialTransitions];
  }

  public get currentStatus(): ExecutionStatus {
    return this._status;
  }

  public get transitions(): ReadonlyArray<StateTransitionRecord> {
    return this._transitions;
  }

  public isTerminal(): boolean {
    return TERMINAL_STATES.has(this._status);
  }

  public isActive(): boolean {
    return ACTIVE_STATES.has(this._status);
  }

  public canTransitionTo(target: ExecutionStatus): boolean {
    const validTargets = VALID_TRANSITIONS[this._status];
    return validTargets !== undefined && validTargets.has(target);
  }

  public getValidNextStates(): ExecutionStatus[] {
    const validTargets = VALID_TRANSITIONS[this._status];
    return validTargets ? Array.from(validTargets) : [];
  }

  public transition(
    to: ExecutionStatus,
    options: {
      executionId?: string;
      reason?: string;
      actor?: 'agent' | 'human' | 'system' | 'policy' | 'attention';
      timestamp?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): StateTransitionRecord {
    if (!this.canTransitionTo(to)) {
      throw new InvalidStateTransitionError(this._status, to, options.executionId);
    }

    const record: StateTransitionRecord = {
      from: this._status,
      to,
      timestamp: options.timestamp ?? Date.now(),
      reason: options.reason,
      actor: options.actor ?? 'system',
      metadata: options.metadata,
    };

    this._status = to;
    this._transitions.push(record);
    return record;
  }
}
