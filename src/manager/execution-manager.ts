/**
 * Execution Manager
 *
 * Coordinates execution lifecycle, event processing, persistence, and state synchronization.
 */

import { Execution, type CreateExecutionOptions } from '../domain/execution.js';
import { ExecutionNotFoundError } from '../domain/errors.js';
import type { IExecutionRepository } from '../storage/execution-repository.js';
import type { IEventRepository } from '../storage/event-repository.js';
import type { ConductorEvent } from '../types/event.js';
import type { ExecutionState, ExecutionStatus } from '../types/execution.js';

export interface ExecutionStatusSummary {
  executionId: string;
  goal: string;
  status: ExecutionStatus;
  currentPhase: string;
  progressSummary: string;
  durationSeconds: number;
  toolCallCount: number;
  filesModifiedCount: number;
  pendingDecisionsCount: number;
  risksCount: number;
  completedWorkCount: number;
  updatedAt: number;
}

export class ExecutionManager {
  private _activeExecutionId?: string;
  private readonly _subscribers: Array<(event: ConductorEvent) => void> = [];

  constructor(
    public readonly executionRepo: IExecutionRepository,
    public readonly eventRepo: IEventRepository,
  ) {}

  public get activeExecutionId(): string | undefined {
    return this._activeExecutionId;
  }

  public subscribe(handler: (event: ConductorEvent) => void): () => void {
    this._subscribers.push(handler);
    return () => {
      const idx = this._subscribers.indexOf(handler);
      if (idx >= 0) {
        this._subscribers.splice(idx, 1);
      }
    };
  }

  private notify(event: ConductorEvent): void {
    for (const sub of this._subscribers) {
      try {
        sub(event);
      } catch {
        // Observers must not break execution manager
      }
    }
  }

  public createExecution(options: CreateExecutionOptions): Execution {
    const execution = Execution.create(options);
    this.executionRepo.save(execution);
    this._activeExecutionId = execution.id;
    return execution;
  }

  public getExecution(executionId: string): Execution {
    const execution = this.executionRepo.findById(executionId);
    if (!execution) {
      throw new ExecutionNotFoundError(executionId);
    }
    return execution;
  }

  public getActiveExecution(): Execution | null {
    if (this._activeExecutionId) {
      const exec = this.executionRepo.findById(this._activeExecutionId);
      if (exec && exec.isActive()) {
        return exec;
      }
    }

    // Fallback to most recently updated active execution
    const activeList = this.executionRepo.list({ limit: 1 });
    const first = activeList[0];
    if (first && first.isActive()) {
      this._activeExecutionId = first.id;
      return first;
    }

    return null;
  }

  /**
   * Ingest and process a ConductorEvent
   */
  public processEvent(event: ConductorEvent): void {
    // 1. Persist the event
    this.eventRepo.save(event);

    // 2. Fetch execution and apply updates
    const execution = this.executionRepo.findById(event.executionId);
    if (execution) {
      this.applyEventToExecution(execution, event);
      this.executionRepo.save(execution);
    }

    // 3. Notify subscribers
    this.notify(event);
  }

  private applyEventToExecution(execution: Execution, event: ConductorEvent): void {
    switch (event.type) {
      case 'execution.started': {
        if (execution.status === 'STARTING') {
          execution.start(event.source === 'human' ? 'human' : 'system');
        }
        break;
      }

      case 'execution.completed': {
        if (execution.isActive()) {
          const summary = (event.payload.summary as string) || 'Execution completed';
          execution.complete(summary);
        }
        break;
      }

      case 'execution.failed': {
        if (execution.isActive()) {
          const err = (event.payload.error as string) || 'Execution failed';
          execution.fail(err);
        }
        break;
      }

      case 'tool.called': {
        execution.recordToolCall();
        break;
      }

      case 'command.completed': {
        const exitCode = (event.payload.exitCode as number) ?? 0;
        execution.recordCommand(exitCode);
        break;
      }

      case 'file.changed': {
        const filePath = (event.payload.filePath as string) ?? '';
        const action = (event.payload.action as 'created' | 'modified' | 'deleted') ?? 'modified';
        if (filePath) {
          execution.recordFileChange(filePath, action);
        }
        break;
      }

      case 'test.passed': {
        execution.recordTestRun(true);
        break;
      }

      case 'test.failed': {
        execution.recordTestRun(false);
        break;
      }

      case 'agent.blocked': {
        if (execution.isActive() && execution.status !== 'BLOCKED') {
          const reason = (event.payload.reason as string) || 'Agent blocked';
          execution.block(reason);
        }
        break;
      }

      default:
        break;
    }
  }

  public getStatus(executionId?: string): ExecutionStatusSummary {
    const exec = executionId
      ? this.getExecution(executionId)
      : this.getActiveExecution();

    if (!exec) {
      throw new Error(
        executionId
          ? `Execution "${executionId}" not found`
          : 'No active execution found',
      );
    }

    const state = exec.toState();
    const durationSeconds = Math.round(
      (state.metrics.durationMs || (Date.now() - state.timestamps.createdAt)) / 1000,
    );

    return {
      executionId: state.executionId,
      goal: state.goal,
      status: state.status,
      currentPhase: state.currentPhase,
      progressSummary: state.progressSummary,
      durationSeconds,
      toolCallCount: state.metrics.toolCallCount,
      filesModifiedCount: state.metrics.filesChangedCount,
      pendingDecisionsCount: state.decisions.length,
      risksCount: state.risks.length,
      completedWorkCount: state.completedWork.length,
      updatedAt: state.timestamps.updatedAt,
    };
  }

  public getHistory(
    executionId?: string,
    options: { limit?: number; offset?: number } = {},
  ): ConductorEvent[] {
    const id = executionId ?? this.getActiveExecution()?.id;
    if (!id) {
      return [];
    }
    return this.eventRepo.listByExecution(id, options);
  }
}
