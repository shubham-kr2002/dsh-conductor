/**
 * Conductor CLI Commands Implementation
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConductorDatabase } from '../storage/database.js';
import { SqliteExecutionRepository } from '../storage/execution-repository.js';
import { SqliteEventRepository } from '../storage/event-repository.js';
import { ExecutionManager } from '../manager/execution-manager.js';
import type { ConductorEvent } from '../types/event.js';

export function resolveDbPath(): string {
  if (process.env.CONDUCTOR_DB_PATH) {
    return process.env.CONDUCTOR_DB_PATH;
  }
  // Try local workspace .conductor/ directory
  const localDb = resolve(process.cwd(), '.conductor', 'conductor.db');
  return localDb;
}

export function createManager(dbPath?: string): {
  manager: ExecutionManager;
  db: ConductorDatabase;
} {
  const path = dbPath ?? resolveDbPath();
  const db = new ConductorDatabase({ path });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const manager = new ExecutionManager(execRepo, eventRepo);
  return { manager, db };
}

export function renderStatus(summary: ReturnType<ExecutionManager['getStatus']>): string {
  const lines: string[] = [
    '=================================================================',
    '                   CONDUCTOR EXECUTION STATUS                    ',
    '=================================================================',
    `Execution ID:        ${summary.executionId}`,
    `Goal:                ${summary.goal}`,
    `Status:              [${summary.status}]`,
    `Current Phase:       ${summary.currentPhase}`,
    `Progress Summary:    ${summary.progressSummary}`,
    `Duration:            ${summary.durationSeconds}s`,
    '-----------------------------------------------------------------',
    `Metrics:             Tools: ${summary.toolCallCount} | Files: ${summary.filesModifiedCount} | Completed Tasks: ${summary.completedWorkCount}`,
    `Pending Decisions:   ${summary.pendingDecisionsCount}`,
    `Known Risks:         ${summary.risksCount}`,
    `Needs You:           ${summary.attentionRequired ? 'YES — see pending items below' : 'no'}`,
  ];

  if (summary.pendingAttention.length > 0) {
    lines.push('-----------------------------------------------------------------');
    lines.push('ITEMS REQUIRING YOUR JUDGMENT:');
    for (const item of summary.pendingAttention) {
      lines.push(`  [${item.level}] ${item.type} — ${item.rationale}`);
    }
  }

  lines.push('=================================================================');
  return lines.join('\n');
}

export function renderHistory(events: ConductorEvent[]): string {
  if (events.length === 0) {
    return 'No events recorded for this execution.';
  }

  const lines: string[] = [
    '=================================================================',
    '                   CONDUCTOR EXECUTION HISTORY                   ',
    '=================================================================',
  ];

  for (const evt of events) {
    const timeStr = new Date(evt.timestamp).toISOString().slice(11, 19);
    let detail = '';

    switch (evt.type) {
      case 'execution.started':
        detail = (evt.payload.goal as string) || '';
        break;
      case 'tool.called':
        detail = `${evt.payload.toolName} (${JSON.stringify(evt.payload.arguments || {})})`;
        break;
      case 'file.changed':
        detail = `${evt.payload.filePath} (${evt.payload.action})`;
        break;
      case 'command.started':
        detail = (evt.payload.command as string) || '';
        break;
      case 'command.completed':
        detail = `exitCode=${evt.payload.exitCode} (${evt.payload.command || ''})`;
        break;
      case 'test.passed':
        detail = `PASS: ${evt.payload.testName || ''}`;
        break;
      case 'test.failed':
        detail = `FAIL: ${evt.payload.testName || ''} - ${evt.payload.error || ''}`;
        break;
      case 'agent.blocked':
        detail = (evt.payload.reason as string) || '';
        break;
      case 'agent.question':
        detail = (evt.payload.question as string) || '';
        break;
      case 'human.intervention':
        detail = `${evt.payload.action} by ${evt.payload.actor}: ${evt.payload.notes || ''}`;
        break;
      default:
        detail = JSON.stringify(evt.payload);
        break;
    }

    const attention = evt.metadata?.attention as { level?: string } | undefined;
    const tag = attention
      ? ` {${attention.level === 'SILENT' ? '·' : attention.level === 'BACKGROUND' ? '•' : attention.level === 'DECISION' ? '!' : '✱'}}`
      : '';
    lines.push(`[${timeStr}] ${evt.type.padEnd(20)} ${detail}${tag}`);
  }

  lines.push('=================================================================');
  return lines.join('\n');
}
