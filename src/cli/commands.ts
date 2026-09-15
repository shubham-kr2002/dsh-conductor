/**
 * Conductor CLI Commands Implementation
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConductorDatabase } from '../storage/database.js';
import { SqliteExecutionRepository } from '../storage/execution-repository.js';
import { SqliteEventRepository } from '../storage/event-repository.js';
import { SqliteDecisionRepository } from '../storage/decision-repository.js';
import { SqliteTakeoverRepository } from '../storage/takeover-repository.js';
import { DecisionQueue } from '../decision/decision-queue.js';
import { TakeoverService } from '../takeover/takeover-service.js';
import { ExecutionManager } from '../manager/execution-manager.js';
import type { ConductorEvent } from '../types/event.js';
import type { ConductorDecision } from '../types/decision.js';

export function resolveDbPath(): string {
  if (process.env.CONDUCTOR_DB_PATH) {
    return process.env.CONDUCTOR_DB_PATH;
  }
  // Try local workspace .conductor/ directory
  const localDb = resolve(process.cwd(), '.conductor', 'conductor.db');
  return localDb;
}

export interface ConductorRuntime {
  manager: ExecutionManager;
  decisions: DecisionQueue;
  takeover: TakeoverService;
  execRepo: SqliteExecutionRepository;
  eventRepo: SqliteEventRepository;
  decisionRepo: SqliteDecisionRepository;
  takeoverRepo: SqliteTakeoverRepository;
  db: ConductorDatabase;
}

export function createRuntime(dbPath?: string): ConductorRuntime {
  const path = dbPath ?? resolveDbPath();
  const db = new ConductorDatabase({ path });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const takeoverRepo = new SqliteTakeoverRepository(db);
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  const takeover = new TakeoverService({
    executionRepo: execRepo,
    eventRepo,
    decisionRepo,
    takeoverRepo,
  });
  return {
    manager,
    decisions,
    takeover,
    execRepo,
    eventRepo,
    decisionRepo,
    takeoverRepo,
    db,
  };
}

/** Backwards-compatible alias used by the CLI. */
export const createManager = createRuntime;

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

/** Render the pending decision queue, highest priority first. */
export function renderDecisions(decisions: ConductorDecision[]): string {
  const lines: string[] = [
    '=================================================================',
    '                      CONDUCTOR DECISIONS                      ',
    '=================================================================',
  ];

  if (decisions.length === 0) {
    lines.push('Nothing needs you. The agent is working autonomously.');
    lines.push('=================================================================');
    return lines.join('\n');
  }

  lines.push(`${String(decisions.length)} decision(s) require your judgment:`);
  lines.push('');
  decisions.forEach((d, idx) => {
    const age = Math.round((Date.now() - d.createdAt) / 60000);
    lines.push(`${String(idx + 1)}. [${d.impact}/${d.urgency}] ${d.title}`);
    lines.push(`   ${d.question}`);
    if (d.recommendation) lines.push(`   Agent recommends: ${d.recommendation}`);
    if (d.options.length > 0) {
      for (const opt of d.options) {
        const rec = opt.isRecommended ? ' <= recommended' : '';
        lines.push(`     (${opt.id}) ${opt.label}${opt.description ? ` — ${opt.description}` : ''}${rec}`);
      }
    }
    lines.push(`   id: ${d.id} | execution: ${d.executionId} | ${String(age)}m ago`);
    lines.push('');
  });
  lines.push('Resolve with:  conductor resolve <decision-id> --accept | --reject | --custom "<answer>"');
  lines.push('=================================================================');
  return lines.join('\n');
}

export function renderDecisionDetail(d: ConductorDecision): string {
  const lines = [
    `Decision ${d.id}`,
    `  Title:   ${d.title}`,
    `  Status:  ${d.status}`,
    `  Impact:  ${d.impact} | Urgency: ${d.urgency} | Confidence: ${String(d.confidence)}`,
    `  Question: ${d.question}`,
    '  Context:',
    ...d.context.split('\n').map((l) => `    ${l}`),
  ];
  if (d.options.length > 0) {
    lines.push('  Options:');
    for (const opt of d.options) {
      lines.push(`    (${opt.id}) ${opt.label}${opt.isRecommended ? ' <= recommended' : ''}`);
    }
  }
  if (d.resolution) {
    lines.push(`  Resolved by ${d.resolution.resolvedBy} as ${d.resolution.status}`);
    if (d.resolution.customValue) lines.push(`  Answer: ${d.resolution.customValue}`);
  }
  return lines.join('\n');
}
