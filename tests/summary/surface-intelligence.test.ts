import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Execution } from '../../src/domain/execution.js';
import type { ExecutionState, StateTransitionRecord } from '../../src/types/execution.js';
import { computeAttentionMetrics, formatDuration } from '../../src/summary/attention-metrics.js';
import { statusLanguage, decisionStatusLabel } from '../../src/summary/status-language.js';
import { condenseTimeline } from '../../src/summary/timeline.js';
import type { ConductorEvent } from '../../src/types/event.js';
import type { ConductorDecision } from '../../src/types/decision.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function syntheticExec(
  status: ExecutionState['status'],
  transitions: StateTransitionRecord[],
  over: Partial<ExecutionState> = {},
): Execution {
  const state: ExecutionState = {
    executionId: 'exec-m1',
    goal: 'ship payments',
    constraints: [],
    status,
    workspace: { root: '/srv', filesModified: [], filesCreated: [], filesDeleted: [] },
    agent: { id: 'a1' },
    currentPhase: 'migrate',
    progressSummary: '',
    completedWork: [],
    decisions: [],
    interventions: [],
    risks: [],
    metrics: {
      durationMs: 0, toolCallCount: 0, decisionCount: 0, interventionCount: 0,
      commandsExecuted: 0, filesChangedCount: 0, testsRunCount: 0, testsFailedCount: 0,
    },
    timestamps: { createdAt: T0, updatedAt: T0 },
    transitions,
    ...over,
  };
  return new Execution(state);
}

function decision(over: Partial<ConductorDecision> = {}): ConductorDecision {
  return {
    id: `dec-${Math.random().toString(36).slice(2)}`,
    executionId: 'exec-m1',
    title: 't', question: 'q', context: 'c', options: [],
    impact: 'major', urgency: 'high', confidence: 0.9,
    status: 'pending',
    createdAt: T0 + MIN, updatedAt: T0 + MIN,
    ...over,
  };
}

describe('Attention metrics — derived from the transition log', () => {
  test('held, human-control and autonomous time split exactly; terminal cuts the clock', () => {
    const exec = syntheticExec('COMPLETED', [
      { from: 'STARTING', to: 'RUNNING', timestamp: T0 + MIN },
      { from: 'RUNNING', to: 'PAUSED', timestamp: T0 + 10 * MIN, reason: 'judgment', actor: 'attention' },
      { from: 'PAUSED', to: 'RUNNING', timestamp: T0 + 14 * MIN, actor: 'human' },
      { from: 'RUNNING', to: 'TAKEN_OVER', timestamp: T0 + 30 * MIN, actor: 'human' },
      { from: 'TAKEN_OVER', to: 'RUNNING', timestamp: T0 + 34 * MIN, actor: 'human' },
      { from: 'RUNNING', to: 'COMPLETED', timestamp: T0 + 42 * MIN },
    ]);
    const decisions = [
      decision({ status: 'accepted', createdAt: T0 + 10 * MIN, resolution: { status: 'accepted', resolvedAt: T0 + 14 * MIN, resolvedBy: 'dev' } }),
    ];
    const m = computeAttentionMetrics(exec, decisions, { now: T0 + 999 * MIN, takeoverCount: 1 });

    assert.equal(m.totalMs, 42 * MIN, 'ends at completion, not now');
    assert.equal(m.heldMs, 4 * MIN, 'PAUSED span');
    assert.equal(m.humanControlMs, 4 * MIN, 'TAKEN_OVER span');
    assert.equal(m.autonomousMs, 34 * MIN, 'everything else');
    assert.ok(Math.abs(m.attentionRatio - 8 / 42) < 1e-9);
    assert.equal(m.interruptions, 2, '1 decision + 1 takeover — never double-counted');
    assert.equal(m.decisionsResolved, 1);
  });

  test('a run held right now accrues held time up to now', () => {
    const exec = syntheticExec('PAUSED', [
      { from: 'STARTING', to: 'RUNNING', timestamp: T0 + MIN },
      { from: 'RUNNING', to: 'PAUSED', timestamp: T0 + 3 * MIN, actor: 'attention' },
    ]);
    const m = computeAttentionMetrics(exec, [decision({ createdAt: T0 + 3 * MIN })], { now: T0 + 8 * MIN });
    assert.equal(m.heldMs, 5 * MIN);
    assert.equal(m.autonomousMs, 3 * MIN, 'STARTING + RUNNING time is autonomous');
    assert.equal(m.decisionsPending, 1);
    assert.ok(m.attentionRatio > 0.6);
  });

  test('formatDuration reads naturally', () => {
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(38 * MIN), '38m');
    assert.equal(formatDuration(4 * MIN + 12_000), '4m12s');
    assert.equal(formatDuration(75 * MIN), '1h15m');
  });
});

describe('Status language', () => {
  test('held states speak human; technical names stay secondary', () => {
    assert.equal(statusLanguage('PAUSED').label, 'Waiting for your judgment');
    assert.equal(statusLanguage('PAUSED').needsYou, true);
    assert.equal(statusLanguage('BLOCKED').label, 'Cannot continue safely');
    assert.equal(statusLanguage('BLOCKED').needsYou, true);
    assert.equal(statusLanguage('TAKEN_OVER').label, 'You are in control');
    assert.equal(statusLanguage('RUNNING').needsYou, false);
    assert.equal(statusLanguage('RUNNING').label, 'Working autonomously');
    assert.equal(statusLanguage('COMPLETED').tone, 'done');
    assert.equal(statusLanguage('HANDOFF_PENDING').needsYou, false);
    assert.equal(decisionStatusLabel('pending'), 'awaiting you');
    assert.equal(decisionStatusLabel('custom'), 'answered');
  });
});

describe('Semantic timeline — collapse the noise', () => {
  function evt(id: string, at: number, type: ConductorEvent['type'], payload: Record<string, unknown>, source: ConductorEvent['source'] = 'agent'): ConductorEvent {
    return { id, executionId: 'exec-m1', type, timestamp: at, payload, source };
  }

  test('raw tool chatter collapses into narrated activities', () => {
    const events: ConductorEvent[] = [
      evt('e1', T0, 'execution.started', { goal: 'ship payments' }),
      evt('e2', T0 + MIN, 'tool.called', { callId: 'c1', toolName: 'read', arguments: { file_path: 'src/app.ts' } }),
      evt('e3', T0 + 2 * MIN, 'tool.called', { callId: 'c2', toolName: 'bash', arguments: { command: 'pnpm test' } }),
      evt('e4', T0 + 2 * MIN + 1, 'command.started', { commandId: 'c2', command: 'pnpm test', cwd: '/srv' }),
      evt('e5', T0 + 3 * MIN, 'command.completed', { commandId: 'c2', command: 'pnpm test', exitCode: 1 }),
      evt('e6', T0 + 4 * MIN, 'file.changed', { callId: 'c3', filePath: 'src/a.ts', action: 'modified' }),
      evt('e7', T0 + 4 * MIN + 2, 'file.changed', { callId: 'c4', filePath: 'src/b.ts', action: 'modified' }),
      evt('e8', T0 + 4 * MIN + 3, 'file.changed', { callId: 'c5', filePath: 'src/c.ts', action: 'created' }),
      evt('e9', T0 + 5 * MIN, 'tool.called', { callId: 'c6', toolName: 'bash', arguments: { command: 'pnpm test' } }),
      evt('e10', T0 + 5 * MIN + 1, 'command.started', { commandId: 'c6', command: 'pnpm test', cwd: '/srv' }),
      evt('e11', T0 + 5 * MIN + 2, 'command.completed', { commandId: 'c6', command: 'pnpm test', exitCode: 0 }),
      evt('e12', T0 + 6 * MIN, 'tool.called', { callId: 'q1', toolName: 'ask_user_question', arguments: {} }),
      evt('e13', T0 + 6 * MIN + 1, 'agent.question', { questionId: 'q1', question: 'Add Redis?' }),
    ];
    const decisions: ConductorDecision[] = [
      decision({ id: 'dec-1', createdAt: T0 + 6 * MIN + 2, title: 'Agent question: Add Redis?', question: 'Add Redis?' }),
    ];

    const t = condenseTimeline(events, decisions);
    const texts = t.map((e) => e.text);

    // 14 raw events collapse to <= 7 narrated entries
    assert.ok(t.length <= 7, `too many entries: ${String(t.length)}`);
    assert.ok(texts.some((x) => x.startsWith('Started:')));
    assert.ok(texts.some((x) => x.includes('read') && x.includes('app.ts')));
    const firstRun = t.find((e) => e.text === 'ran `pnpm test`')!;
    assert.equal(firstRun.tone, 'bad', 'failing run shown red');
    assert.equal(firstRun.count, 2, 'started+completed merged into ONE entry');
    const edit = t.find((e) => e.kind === 'files')!;
    assert.equal(edit.count, 3, 'three file changes grouped');
    assert.equal(edit.text, 'edited 3 files', 'verb follows first change');
    assert.ok(t.filter((e) => e.text === 'ran `pnpm test`').length === 2, 'two separate test runs');
    assert.ok(texts.some((x) => x.startsWith('needs decision:')), 'decision surfaced');
    // question raw event itself never duplicates the decision entry
    assert.equal(texts.filter((x) => x.includes('Add Redis')).length, 1);
  });

  test('limit keeps the most recent activities', () => {
    const events: ConductorEvent[] = Array.from({ length: 30 }, (_, i) =>
      evt(`x${String(i)}`, T0 + i * 1000, 'command.started', { commandId: `x${String(i)}`, command: `cmd${String(i)}`, cwd: '/' }),
    );
    const t = condenseTimeline(events, [], { limit: 5 });
    assert.equal(t.length, 5);
    assert.equal(t[4]!.text, 'ran `cmd29`');
  });
});
