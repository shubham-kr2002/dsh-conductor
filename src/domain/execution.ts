/**
 * Execution Entity
 *
 * Core aggregate representing an autonomous agent execution managed by Conductor.
 */

import { randomUUID } from 'node:crypto';
import type {
  ExecutionState,
  ExecutionStatus,
  WorkspaceState,
  AgentInfo,
  HumanInterventionRecord,
  ExecutionMetrics,
  ExecutionTimestamps,
  StateTransitionRecord,
} from '../types/execution.js';
import { ExecutionStateMachine } from './state-machine.js';
import { ExecutionTerminatedError } from './errors.js';

export interface CreateExecutionOptions {
  id?: string;
  goal: string;
  workspaceRoot: string;
  constraints?: string[];
  agent?: Partial<AgentInfo>;
  initialPhase?: string;
}

export class Execution {
  public readonly id: string;
  public readonly goal: string;
  public readonly constraints: string[];
  private readonly _stateMachine: ExecutionStateMachine;
  public readonly workspace: WorkspaceState;
  public readonly agent: AgentInfo;
  public currentPhase: string;
  public progressSummary: string;
  public readonly completedWork: string[];
  public nextAction?: string;
  public readonly decisions: string[];
  public readonly interventions: HumanInterventionRecord[];
  public readonly risks: string[];
  public readonly metrics: ExecutionMetrics;
  public readonly timestamps: ExecutionTimestamps;

  constructor(state: ExecutionState) {
    this.id = state.executionId;
    this.goal = state.goal;
    this.constraints = [...state.constraints];
    this._stateMachine = new ExecutionStateMachine(state.status, state.transitions);
    this.workspace = {
      root: state.workspace.root,
      initialCommit: state.workspace.initialCommit,
      currentCommit: state.workspace.currentCommit,
      branch: state.workspace.branch,
      filesModified: [...state.workspace.filesModified],
      filesCreated: [...state.workspace.filesCreated],
      filesDeleted: [...state.workspace.filesDeleted],
    };
    this.agent = { ...state.agent };
    this.currentPhase = state.currentPhase;
    this.progressSummary = state.progressSummary;
    this.completedWork = [...state.completedWork];
    this.nextAction = state.nextAction;
    this.decisions = [...state.decisions];
    this.interventions = [...state.interventions];
    this.risks = [...state.risks];
    this.metrics = { ...state.metrics };
    this.timestamps = { ...state.timestamps };
  }

  public static create(options: CreateExecutionOptions): Execution {
    const now = Date.now();
    const id = options.id ?? `exec-${randomUUID()}`;

    const initialState: ExecutionState = {
      executionId: id,
      goal: options.goal,
      constraints: options.constraints ? [...options.constraints] : [],
      status: 'STARTING',
      workspace: {
        root: options.workspaceRoot,
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
      },
      agent: {
        id: options.agent?.id ?? 'default-agent',
        provider: options.agent?.provider,
        model: options.agent?.model,
        preset: options.agent?.preset,
        delegationDepth: options.agent?.delegationDepth ?? 0,
      },
      currentPhase: options.initialPhase ?? 'initialization',
      progressSummary: 'Execution initialized',
      completedWork: [],
      nextAction: 'Start autonomous execution',
      decisions: [],
      interventions: [],
      risks: [],
      metrics: {
        durationMs: 0,
        toolCallCount: 0,
        decisionCount: 0,
        interventionCount: 0,
        commandsExecuted: 0,
        filesChangedCount: 0,
        testsRunCount: 0,
        testsFailedCount: 0,
      },
      timestamps: {
        createdAt: now,
        updatedAt: now,
      },
      transitions: [],
    };

    return new Execution(initialState);
  }

  public get status(): ExecutionStatus {
    return this._stateMachine.currentStatus;
  }

  /** Point this execution at the agent now responsible for it (handoff). */
  public reassignAgent(agentId: string): void {
    this.agent.id = agentId;
    this.recordTouch();
  }

  public get transitions(): ReadonlyArray<StateTransitionRecord> {
    return this._stateMachine.transitions;
  }

  public isTerminal(): boolean {
    return this._stateMachine.isTerminal();
  }

  public isActive(): boolean {
    return this._stateMachine.isActive();
  }

  private assertNotTerminated(actionName: string): void {
    if (this.isTerminal()) {
      throw new ExecutionTerminatedError(this.id, this.status);
    }
  }

  private recordTouch(): void {
    const now = Date.now();
    this.timestamps.updatedAt = now;
    if (this.timestamps.startedAt && !this.isTerminal()) {
      this.metrics.durationMs = now - this.timestamps.startedAt;
    }
  }

  public start(actor: 'agent' | 'human' | 'system' = 'system'): StateTransitionRecord {
    const now = Date.now();
    if (!this.timestamps.startedAt) {
      this.timestamps.startedAt = now;
    }
    const transition = this._stateMachine.transition('RUNNING', {
      executionId: this.id,
      actor,
      reason: 'Execution started',
      timestamp: now,
    });
    this.recordTouch();
    return transition;
  }

  public pause(reason?: string, actor: 'human' | 'system' | 'policy' | 'attention' = 'system'): StateTransitionRecord {
    this.assertNotTerminated('pause');
    const transition = this._stateMachine.transition('PAUSED', {
      executionId: this.id,
      actor,
      reason: reason ?? 'Execution paused',
    });
    this.recordTouch();
    return transition;
  }

  public resume(reason?: string, actor: 'human' | 'system' = 'human'): StateTransitionRecord {
    this.assertNotTerminated('resume');
    const transition = this._stateMachine.transition('RUNNING', {
      executionId: this.id,
      actor,
      reason: reason ?? 'Execution resumed',
    });
    this.recordTouch();
    return transition;
  }

  public wait(reason?: string): StateTransitionRecord {
    this.assertNotTerminated('wait');
    const transition = this._stateMachine.transition('WAITING', {
      executionId: this.id,
      actor: 'system',
      reason: reason ?? 'Waiting for external input or event',
    });
    this.recordTouch();
    return transition;
  }

  public block(reason: string): StateTransitionRecord {
    this.assertNotTerminated('block');
    const transition = this._stateMachine.transition('BLOCKED', {
      executionId: this.id,
      actor: 'agent',
      reason,
    });
    this.recordTouch();
    return transition;
  }

  public takeOver(actor = 'developer', notes?: string): StateTransitionRecord {
    this.assertNotTerminated('take over');
    const now = Date.now();
    const transition = this._stateMachine.transition('TAKEN_OVER', {
      executionId: this.id,
      actor: 'human',
      reason: 'Human developer took over control',
      timestamp: now,
    });

    const intervention: HumanInterventionRecord = {
      id: `int-${randomUUID()}`,
      timestamp: now,
      type: 'take_over',
      summary: 'Human developer assumed direct execution control',
      actor,
      notes,
    };
    this.interventions.push(intervention);
    this.metrics.interventionCount += 1;
    this.recordTouch();
    return transition;
  }

  public continueFromTakeOver(
    actor = 'developer',
    notes?: string,
    filesChanged?: string[],
  ): StateTransitionRecord {
    this.assertNotTerminated('continue from take over');
    const now = Date.now();
    const transition = this._stateMachine.transition('RUNNING', {
      executionId: this.id,
      actor: 'human',
      reason: 'Human developer returned control to agent',
      timestamp: now,
    });

    const intervention: HumanInterventionRecord = {
      id: `int-${randomUUID()}`,
      timestamp: now,
      type: 'continue',
      summary: 'Execution returned to agent with updated workspace',
      actor,
      notes,
      filesChanged,
    };
    this.interventions.push(intervention);
    this.metrics.interventionCount += 1;

    if (filesChanged && filesChanged.length > 0) {
      for (const file of filesChanged) {
        if (!this.workspace.filesModified.includes(file)) {
          this.workspace.filesModified.push(file);
        }
      }
      this.metrics.filesChangedCount = this.workspace.filesModified.length;
    }

    this.recordTouch();
    return transition;
  }

  public requestHandoff(reason: string, toAgentId?: string): StateTransitionRecord {
    this.assertNotTerminated('request handoff');
    const transition = this._stateMachine.transition('HANDOFF_PENDING', {
      executionId: this.id,
      actor: 'agent',
      reason,
      metadata: toAgentId ? { toAgentId } : undefined,
    });
    this.recordTouch();
    return transition;
  }

  public complete(summary?: string): StateTransitionRecord {
    this.assertNotTerminated('complete');
    const now = Date.now();
    this.timestamps.completedAt = now;
    if (this.timestamps.startedAt) {
      this.metrics.durationMs = now - this.timestamps.startedAt;
    }
    if (summary) {
      this.progressSummary = summary;
    }
    const transition = this._stateMachine.transition('COMPLETED', {
      executionId: this.id,
      actor: 'agent',
      reason: summary ?? 'Task completed successfully',
      timestamp: now,
    });
    this.recordTouch();
    return transition;
  }

  public fail(error: string): StateTransitionRecord {
    this.assertNotTerminated('fail');
    const now = Date.now();
    this.timestamps.completedAt = now;
    if (this.timestamps.startedAt) {
      this.metrics.durationMs = now - this.timestamps.startedAt;
    }
    const transition = this._stateMachine.transition('FAILED', {
      executionId: this.id,
      actor: 'system',
      reason: error,
      timestamp: now,
    });
    this.recordTouch();
    return transition;
  }

  public cancel(reason = 'Execution cancelled', actor: 'human' | 'system' = 'human'): StateTransitionRecord {
    this.assertNotTerminated('cancel');
    const now = Date.now();
    this.timestamps.completedAt = now;
    if (this.timestamps.startedAt) {
      this.metrics.durationMs = now - this.timestamps.startedAt;
    }
    const transition = this._stateMachine.transition('CANCELLED', {
      executionId: this.id,
      actor,
      reason,
      timestamp: now,
    });
    this.recordTouch();
    return transition;
  }

  public recordFileChange(filePath: string, action: 'created' | 'modified' | 'deleted'): void {
    if (action === 'created' && !this.workspace.filesCreated.includes(filePath)) {
      this.workspace.filesCreated.push(filePath);
    } else if (action === 'deleted' && !this.workspace.filesDeleted.includes(filePath)) {
      this.workspace.filesDeleted.push(filePath);
    } else if (!this.workspace.filesModified.includes(filePath)) {
      this.workspace.filesModified.push(filePath);
    }
    this.metrics.filesChangedCount =
      this.workspace.filesModified.length +
      this.workspace.filesCreated.length +
      this.workspace.filesDeleted.length;
    this.recordTouch();
  }

  public recordToolCall(): void {
    this.metrics.toolCallCount += 1;
    this.recordTouch();
  }

  public recordCommand(exitCode: number): void {
    this.metrics.commandsExecuted += 1;
    this.recordTouch();
  }

  public recordTestRun(passed: boolean): void {
    this.metrics.testsRunCount += 1;
    if (!passed) {
      this.metrics.testsFailedCount += 1;
    }
    this.recordTouch();
  }

  public addDecision(decisionId: string): void {
    if (!this.decisions.includes(decisionId)) {
      this.decisions.push(decisionId);
      this.metrics.decisionCount = this.decisions.length;
      this.recordTouch();
    }
  }

  public addCompletedWork(work: string): void {
    if (!this.completedWork.includes(work)) {
      this.completedWork.push(work);
      this.recordTouch();
    }
  }

  public addRisk(risk: string): void {
    if (!this.risks.includes(risk)) {
      this.risks.push(risk);
      this.recordTouch();
    }
  }

  public setPhase(phase: string): void {
    this.currentPhase = phase;
    this.recordTouch();
  }

  public setProgressSummary(summary: string): void {
    this.progressSummary = summary;
    this.recordTouch();
  }

  public setNextAction(action: string): void {
    this.nextAction = action;
    this.recordTouch();
  }

  public toState(): ExecutionState {
    return {
      executionId: this.id,
      goal: this.goal,
      constraints: [...this.constraints],
      status: this.status,
      workspace: {
        root: this.workspace.root,
        initialCommit: this.workspace.initialCommit,
        currentCommit: this.workspace.currentCommit,
        branch: this.workspace.branch,
        filesModified: [...this.workspace.filesModified],
        filesCreated: [...this.workspace.filesCreated],
        filesDeleted: [...this.workspace.filesDeleted],
      },
      agent: { ...this.agent },
      currentPhase: this.currentPhase,
      progressSummary: this.progressSummary,
      completedWork: [...this.completedWork],
      nextAction: this.nextAction,
      decisions: [...this.decisions],
      interventions: [...this.interventions],
      risks: [...this.risks],
      metrics: { ...this.metrics },
      timestamps: { ...this.timestamps },
      transitions: [...this.transitions],
    };
  }
}
