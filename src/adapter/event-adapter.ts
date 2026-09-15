/**
 * Event Adapter
 *
 * Normalizes DSH runtime, tool, and session events into canonical ConductorEvent instances.
 * Keeps all DSH-specific tool heuristics and event shapes decoupled from the Conductor core domain.
 */

import { randomUUID } from 'node:crypto';
import type {
  ConductorEvent,
  ConductorEventType,
  EventSource,
  ToolCalledPayload,
  FileChangedPayload,
  CommandStartedPayload,
  CommandCompletedPayload,
  TestPassedPayload,
  TestFailedPayload,
  AgentQuestionPayload,
  AgentBlockedPayload,
} from '../types/event.js';

export interface RawToolExecution {
  callId: string;
  name: string;
  arguments: unknown;
  agentId?: string;
  timestamp?: number;
}

export interface RawToolResult {
  callId: string;
  toolName: string;
  isError: boolean;
  value?: unknown;
  content?: Array<{ type: string; text?: string }>;
  error?: { name: string; code: string; message?: string };
  timestamp?: number;
}

export interface RawSessionEvent {
  type: string;
  seq?: number;
  time?: number;
  data: Record<string, unknown>;
}

export class EventAdapter {
  /**
   * Determine if a bash command represents a test execution
   */
  public static isTestCommand(command: string): boolean {
    const trimmed = command.trim().toLowerCase();
    return (
      trimmed.includes('test') ||
      trimmed.startsWith('jest') ||
      trimmed.startsWith('vitest') ||
      trimmed.startsWith('pytest') ||
      trimmed.startsWith('cargo test') ||
      trimmed.startsWith('go test') ||
      trimmed.includes('node --test') ||
      trimmed.includes('npm test') ||
      trimmed.includes('pnpm test') ||
      trimmed.includes('yarn test')
    );
  }

  /**
   * Create a ConductorEvent from raw input
   */
  public static createEvent<T extends Record<string, unknown>>(
    executionId: string,
    type: ConductorEventType,
    payload: T,
    source: EventSource = 'dsh',
    metadata?: Record<string, unknown>,
  ): ConductorEvent<T> {
    return {
      id: `evt-${randomUUID()}`,
      executionId,
      type,
      timestamp: Date.now(),
      payload,
      source,
      metadata,
    };
  }

  /**
   * Normalize a tool call into one or more ConductorEvents
   */
  public static adaptToolCall(
    executionId: string,
    toolExec: RawToolExecution,
  ): ConductorEvent[] {
    const events: ConductorEvent[] = [];
    const args = (toolExec.arguments && typeof toolExec.arguments === 'object'
      ? toolExec.arguments
      : {}) as Record<string, unknown>;

    // Generic tool.called event
    const toolPayload: ToolCalledPayload = {
      callId: toolExec.callId,
      toolName: toolExec.name,
      arguments: args,
      consequence: this.inferConsequence(toolExec.name, args),
      reversibility: this.inferReversibility(toolExec.name, args),
    };

    events.push(
      this.createEvent(executionId, 'tool.called', toolPayload, 'agent', {
        agentId: toolExec.agentId,
      }),
    );

    // Specific domain events
    if (toolExec.name === 'bash' || toolExec.name === 'pwsh') {
      const command = (args.command as string) ?? '';
      const cwd = (args.workdir as string) ?? (args.cwd as string) ?? process.cwd();
      const cmdPayload: CommandStartedPayload = {
        commandId: toolExec.callId,
        command,
        cwd,
      };
      events.push(this.createEvent(executionId, 'command.started', cmdPayload, 'agent'));
    } else if (toolExec.name === 'write' || toolExec.name === 'edit') {
      const filePath = (args.file_path as string) ?? (args.path as string) ?? 'unknown';
      const action = toolExec.name === 'write' ? 'created' : 'modified';
      const filePayload: FileChangedPayload = {
        filePath,
        action,
      };
      events.push(this.createEvent(executionId, 'file.changed', filePayload, 'agent'));
    } else if (toolExec.name === 'ask_user_question') {
      const questions = (args.questions as Array<{ question: string; options?: Array<{ label: string }> }>) ?? [];
      const first = questions[0];
      const qPayload: AgentQuestionPayload = {
        questionId: toolExec.callId,
        question: first ? first.question : 'Agent asked a question',
        options: first?.options,
      };
      events.push(this.createEvent(executionId, 'agent.question', qPayload, 'agent'));
    }

    return events;
  }

  /**
   * Normalize a tool execution result into ConductorEvents
   */
  public static adaptToolResult(
    executionId: string,
    result: RawToolResult,
    originalArgs?: Record<string, unknown>,
  ): ConductorEvent[] {
    const events: ConductorEvent[] = [];

    if (result.toolName === 'bash' || result.toolName === 'pwsh') {
      const command = (originalArgs?.command as string) ?? 'shell command';
      const isTest = this.isTestCommand(command);

      const cmdPayload: CommandCompletedPayload = {
        commandId: result.callId,
        command,
        exitCode: result.isError ? 1 : 0,
        stdout: typeof result.value === 'string' ? result.value : undefined,
        durationMs: 0,
      };
      events.push(this.createEvent(executionId, 'command.completed', cmdPayload, 'agent'));

      if (isTest) {
        if (result.isError) {
          const testFailPayload: TestFailedPayload = {
            testName: command,
            error: result.error?.message ?? 'Test command failed',
            command,
          };
          events.push(this.createEvent(executionId, 'test.failed', testFailPayload, 'agent'));
        } else {
          const testPassPayload: TestPassedPayload = {
            testName: command,
            command,
          };
          events.push(this.createEvent(executionId, 'test.passed', testPassPayload, 'agent'));
        }
      }
    }

    return events;
  }

  /**
   * Normalize DSH session log events into ConductorEvents
   */
  public static adaptSessionEvent(
    executionId: string,
    event: RawSessionEvent,
  ): ConductorEvent[] {
    const events: ConductorEvent[] = [];

    switch (event.type) {
      case 'turn/start': {
        const turn = (event.data.turn as number) ?? 1;
        if (turn === 1) {
          events.push(
            this.createEvent(
              executionId,
              'execution.started',
              { executionId, goal: 'DSH Session Turn' },
              'dsh',
            ),
          );
        }
        break;
      }

      case 'turn/end': {
        const reason = (event.data.reason as { kind: string; error?: { message: string } }) ?? {
          kind: 'completed',
        };
        if (reason.kind === 'completed') {
          events.push(
            this.createEvent(
              executionId,
              'execution.completed',
              { executionId, completedWork: [], summary: 'Turn completed', durationMs: 0 },
              'dsh',
            ),
          );
        } else if (reason.kind === 'error' || reason.kind === 'aborted') {
          events.push(
            this.createEvent(
              executionId,
              'execution.failed',
              { executionId, error: reason.error?.message ?? `Turn ended with ${reason.kind}` },
              'dsh',
            ),
          );
        } else if (reason.kind === 'blocked') {
          const blockedPayload: AgentBlockedPayload = {
            reason: 'Agent turn blocked',
            blockerType: 'ambiguity',
          };
          events.push(this.createEvent(executionId, 'agent.blocked', blockedPayload, 'dsh'));
        }
        break;
      }

      case 'tool/call': {
        const callId = (event.data.callId as string) ?? `call-${randomUUID()}`;
        const name = (event.data.name as string) ?? 'unknown';
        let args: unknown = {};
        try {
          args = typeof event.data.arguments === 'string'
            ? JSON.parse(event.data.arguments)
            : event.data.arguments;
        } catch {
          args = {};
        }

        events.push(
          ...this.adaptToolCall(executionId, {
            callId,
            name,
            arguments: args,
          }),
        );
        break;
      }

      default:
        break;
    }

    return events;
  }

  private static inferConsequence(
    toolName: string,
    args: Record<string, unknown>,
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (toolName === 'read' || toolName === 'glob' || toolName === 'grep') {
      return 'low';
    }
    if (toolName === 'write' || toolName === 'edit') {
      return 'medium';
    }
    if (toolName === 'bash' || toolName === 'pwsh') {
      const cmd = ((args.command as string) ?? '').toLowerCase();
      if (cmd.includes('rm -rf') || cmd.includes('drop database') || cmd.includes('git push --force')) {
        return 'critical';
      }
      if (cmd.includes('npm install') || cmd.includes('pnpm add') || cmd.includes('git commit')) {
        return 'medium';
      }
      if (cmd.startsWith('git status') || cmd.startsWith('ls') || cmd.startsWith('pwd')) {
        return 'low';
      }
      return 'high';
    }
    return 'medium';
  }

  private static inferReversibility(
    toolName: string,
    args: Record<string, unknown>,
  ): 'reversible' | 'irreversible' {
    if (toolName === 'read' || toolName === 'glob' || toolName === 'grep') {
      return 'reversible';
    }
    if (toolName === 'bash' || toolName === 'pwsh') {
      const cmd = ((args.command as string) ?? '').toLowerCase();
      if (cmd.includes('rm ') || cmd.includes('git push') || cmd.includes('publish')) {
        return 'irreversible';
      }
    }
    return 'reversible';
  }
}
