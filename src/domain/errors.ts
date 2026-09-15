/**
 * Conductor Domain Errors
 */

import type { ExecutionStatus } from '../types/execution.js';

export class ConductorError extends Error {
  constructor(message: string, public readonly code: string = 'CONDUCTOR_ERROR') {
    super(message);
    this.name = 'ConductorError';
  }
}

export class InvalidStateTransitionError extends ConductorError {
  constructor(
    public readonly from: ExecutionStatus,
    public readonly to: ExecutionStatus,
    public readonly executionId?: string,
    message?: string,
  ) {
    const defaultMsg = `Invalid state transition from "${from}" to "${to}"${
      executionId ? ` for execution "${executionId}"` : ''
    }.`;
    super(message || defaultMsg, 'INVALID_STATE_TRANSITION');
    this.name = 'InvalidStateTransitionError';
  }
}

export class ExecutionNotFoundError extends ConductorError {
  constructor(public readonly executionId: string) {
    super(`Execution "${executionId}" not found.`, 'EXECUTION_NOT_FOUND');
    this.name = 'ExecutionNotFoundError';
  }
}

export class DecisionNotFoundError extends ConductorError {
  constructor(public readonly decisionId: string) {
    super(`Decision "${decisionId}" not found.`, 'DECISION_NOT_FOUND');
    this.name = 'DecisionNotFoundError';
  }
}

export class ExecutionAlreadyActiveError extends ConductorError {
  constructor(public readonly executionId: string, public readonly currentStatus: ExecutionStatus) {
    super(
      `Execution "${executionId}" is already active in state "${currentStatus}".`,
      'EXECUTION_ALREADY_ACTIVE',
    );
    this.name = 'ExecutionAlreadyActiveError';
  }
}

export class ExecutionTerminatedError extends ConductorError {
  constructor(public readonly executionId: string, public readonly terminalStatus: ExecutionStatus) {
    super(
      `Execution "${executionId}" is already terminated in state "${terminalStatus}". No further operations allowed.`,
      'EXECUTION_TERMINATED',
    );
    this.name = 'ExecutionTerminatedError';
  }
}

export class PolicyViolationError extends ConductorError {
  constructor(
    public readonly category: string,
    public readonly reason: string,
    public readonly ruleId?: string,
  ) {
    super(`Policy violation in "${category}": ${reason}`, 'POLICY_VIOLATION');
    this.name = 'PolicyViolationError';
  }
}

export class TakeoverError extends ConductorError {
  constructor(public readonly executionId: string, message: string) {
    super(`Takeover error for "${executionId}": ${message}`, 'TAKEOVER_ERROR');
    this.name = 'TakeoverError';
  }
}
