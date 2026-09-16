/**
 * Phase 10 — attention history derivation (pure unit)
 *
 * buildAttentionHistory must answer "where did my attention go / what did
 * Conductor suppress?" strictly from the rows given: every entry traces to
 * an input row, the output is deterministic (same rows → deepEqual), and
 * "attention saved" is never a number because it was never measured.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Execution } from '../../src/domain/execution.js';
import {
  buildAttentionHistory,
  renderAttentionHistory,
} from '../../src/summary/attention-history.js';
import type { DecisionWhy, ConductorDecision } from '../../src/types/decision.js';
import type { ConductorEvent, ConductorEventType } from '../../src/types/event.js';
import type { ExecutionState } from '../../src/types/execution.js';

const T0 = 1_700_000_000_000;
const M = 60_000;

function state(id: string, over: Partial<ExecutionState> = {}): ExecutionState {
  return {
    executionId: id,
    goal: `goal ${id}`,
    constraints: [],
    status: 'RUNNING',
    workspace: { root: '/srv', filesModified: [], filesCreated: [], filesDeleted: [] },
    agent: { id },
    currentPhase: 'impl',
    progressSummary: 'working',
    completedWork: [],
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
    timestamps: { createdAt: T0, updatedAt: T0 + 60 * M },
    transitions: [],
    ...over,
  };
}

function why(ruleIds: string[]): DecisionWhy {
  return {
    what: 'run something',
    whyNow: 'policy requires approval',
    impact: 'major',
    reversibility: 'unknown',
    evidence: {
      eventIds: [],
      ruleIds,
      affectedResources: [],
      blastRadius: 'workspace',
      ambiguity: 0.2,
      taskAligned: true,
    },
    consequences: { approve: 'yes', reject: 'no' },
  };
}

function dec(id: string, over: Partial<ConductorDecision> = {}): ConductorDecision {
  return {
    id,
    executionId: 'e1',
    title: `t-${id}`,
    question: 'q',
    context: 'c',
    options: [],
    impact: 'major',
    urgency: 'high',
    confidence: 0.8,
    status: 'pending',
    createdAt: T0 + 10 * M,
    updatedAt: T0 + 10 * M,
    ...over,
  };
}

function ev(
  id: string,
  type: ConductorEventType,
  timestamp: number,
  payload: Record<string, unknown> = {},
  metadata?: Record<string, unknown>,
): ConductorEvent {
  return {
    id,
    executionId: 'e1',
    type,
    timestamp,
    payload,
    source: 'conductor',
    ...(metadata ? { metadata } : {}),
  };
}

const EXEC1 = new Execution(state('e1'));

describe('buildAttentionHistory — window', () => {
  test('rows outside [since, until] are excluded from every section', () => {
    const input = {
      executions: [EXEC1],
      decisions: [
        dec('d-before', { createdAt: T0 + M, status: 'accepted', resolution: { status: 'accepted' as const, resolvedAt: T0 + 2 * M, resolvedBy: 'dev' } }),
        dec('d-in', { createdAt: T0 + 12 * M, status: 'rejected', resolution: { status: 'rejected' as const, resolvedAt: T0 + 13 * M, resolvedBy: 'dev' } }),
        dec('d-after', { createdAt: T0 + 40 * M }),
      ],
      events: [
        ev('e-in', 'policy.delegated', T0 + 15 * M, { command: 'pnpm add a', category: 'dependencies', delegationId: 'dl-1', grantedBy: 'dev' }),
        ev('e-out', 'policy.delegated', T0 + 45 * M, { command: 'pnpm add z', category: 'dependencies', delegationId: 'dl-1', grantedBy: 'dev' }),
      ],
      since: T0 + 10 * M,
      until: T0 + 20 * M,
    };
    const h = buildAttentionHistory(input);
    assert.deepEqual(h.window, { since: T0 + 10 * M, until: T0 + 20 * M });
    assert.deepEqual(h.interrupted.map((i) => i.decisionId), ['d-in']);
    assert.deepEqual(h.delegated.map((d) => d.command), ['pnpm add a']);
    assert.equal(h.totals.decisions, 1);
  });

  test('window.until defaults to the newest row timestamp (no clock)', () => {
    const quietExec = new Execution(state('e1', { timestamps: { createdAt: T0, updatedAt: T0 + M } }));
    const h = buildAttentionHistory({
      executions: [quietExec],
      decisions: [dec('d1', { createdAt: T0 + 5 * M, updatedAt: T0 + 5 * M })],
      events: [ev('e1', 'policy.delegated', T0 + 7 * M, {})],
      since: T0,
    });
    assert.equal(h.window.until, T0 + 7 * M);
  });
});

describe('buildAttentionHistory — every entry traces to a row', () => {
  const decisions = [
    dec('d-answered', {
      status: 'accepted',
      createdAt: T0 + M,
      subject: 'bash:pnpm add zod',
      why: why(['attn-policy-approval', 'require-approval-dependency-install']),
      resolution: { status: 'accepted', resolvedAt: T0 + 4 * M, resolvedBy: 'dev' },
    }),
    dec('d-refused', {
      status: 'rejected',
      createdAt: T0 + 2 * M,
      why: why(['require-approval-git-force']),
      resolution: { status: 'rejected', resolvedAt: T0 + 6 * M, resolvedBy: 'dev' },
    }),
    dec('d-closed', {
      status: 'expired',
      createdAt: T0 + 3 * M,
    }),
    dec('d-quiet-pending', { status: 'pending', createdAt: T0 + 9 * M }),
    dec('d-shown-pending', { status: 'pending', createdAt: T0 + 9 * M, quality: { presentedAt: T0 + 10 * M } }),
  ];
  const events = [
    ev('ev-dl', 'policy.delegated', T0 + 11 * M, {
      command: 'pnpm add ioredis',
      category: 'dependencies',
      delegationId: 'dl-77',
      grantedBy: 'shubham',
    }),
    ev('ev-testfail-bg', 'test.failed', T0 + 12 * M, { testName: 'repo test', error: 'x' }, {
      attention: { level: 'BACKGROUND', action: 'RECORD' },
    }),
    ev('ev-cmdfail-bg', 'command.completed', T0 + 13 * M, { command: 'make', exitCode: 2 }, {
      attention: { level: 'BACKGROUND', action: 'RECORD' },
    }),
    ev('ev-testfail-pause', 'test.failed', T0 + 14 * M, { testName: 'suite', error: 'y' }, {
      attention: { level: 'DECISION', action: 'PAUSE' },
    }),
    ev('ev-tool-continue', 'tool.called', T0 + 15 * M, { toolName: 'read' }, {
      attention: { level: 'SILENT', action: 'CONTINUE' },
    }),
    ev('ev-takeover', 'human.intervention', T0 + 16 * M, { action: 'take_over', actor: 'dev' }),
  ];
  const base = { executions: [EXEC1], decisions, events, since: T0 };

  test('interrupted outcomes map accepted/custom→answered, rejected→refused, closed→unanswered', () => {
    const h = buildAttentionHistory(base);
    const byId = new Map(h.interrupted.map((i) => [i.decisionId, i]));
    assert.equal(byId.get('d-answered')!.outcome, 'answered');
    assert.equal(byId.get('d-answered')!.responseMs, 3 * M);
    assert.equal(byId.get('d-refused')!.outcome, 'refused');
    assert.equal(byId.get('d-closed')!.outcome, 'unanswered');
    assert.equal(byId.get('d-closed')!.responseMs, null);
    assert.equal(byId.get('d-shown-pending')!.outcome, 'unanswered', 'shown but still open');
    assert.ok(!byId.has('d-quiet-pending'), 'never surfaced → not an interruption');
    // the title is the stored decision's title verbatim
    assert.equal(byId.get('d-answered')!.title, 't-d-answered');
  });

  test('delegated rows carry exactly the policy.delegated payload fields', () => {
    const h = buildAttentionHistory(base);
    assert.deepEqual(h.delegated, [
      { command: 'pnpm add ioredis', category: 'dependencies', delegationId: 'dl-77', grantedBy: 'shubham' },
    ]);
  });

  test('observations only include BACKGROUND/RECORD-classified notable events', () => {
    const h = buildAttentionHistory(base);
    assert.deepEqual(h.observations.map((o) => o.kind), ['test.failed', 'command.failed']);
    assert.match(h.observations[0]!.summary, /repo test/);
    assert.match(h.observations[1]!.summary, /exit 2.*make/);
  });

  test('totals: decisions in window, take_over count, delegated + CONTINUE tools', () => {
    const h = buildAttentionHistory(base);
    assert.equal(h.totals.decisions, 5);
    assert.equal(h.totals.takeovers, 1);
    assert.equal(h.totals.autonomousActions, 2, 'policy.delegated + CONTINUE tool.called');
  });

  test('categories rollup uses DEFAULT_POLICY_RULES ids only', () => {
    const h = buildAttentionHistory(base);
    assert.deepEqual(h.categories.dependencies, { accepted: 1, rejected: 0, pending: 0 });
    assert.deepEqual(h.categories.git, { accepted: 0, rejected: 1, pending: 0 });
    assert.equal(Object.keys(h.categories).includes('shell'), false, 'unmapped rule ids produce nothing');
  });
});

describe('buildAttentionHistory — deferral reasons', () => {
  test('budgetDemoted from the caller marks reason "budget" (by candidate id)', () => {
    const h = buildAttentionHistory({
      executions: [EXEC1],
      decisions: [dec('d-demoted', { createdAt: T0 + 50 * M })],
      events: [],
      since: T0,
      budgetDemoted: ['cand:decision:d-demoted', 'cand:blocked:other'],
    });
    assert.deepEqual(h.deferred, [{ decisionId: 'd-demoted', title: 't-d-demoted', reason: 'budget' }]);
  });

  test('pending older than newest resolved defers as "queue"; during-away marks "away"', () => {
    const resolved = dec('d-res', {
      status: 'accepted',
      createdAt: T0 + 20 * M,
      resolution: { status: 'accepted', resolvedAt: T0 + 21 * M, resolvedBy: 'dev' },
    });
    const plain = buildAttentionHistory({
      executions: [EXEC1],
      decisions: [dec('d-old', { createdAt: T0 + 5 * M }), resolved],
      events: [],
      since: T0,
    });
    assert.deepEqual(plain.deferred, [{ decisionId: 'd-old', title: 't-d-old', reason: 'queue' }]);

    const away = buildAttentionHistory({
      executions: [EXEC1],
      decisions: [dec('d-old', { createdAt: T0 + 5 * M }), resolved],
      events: [ev('e-away', 'human.intervention', T0 + M, { action: 'mark_away', actor: 'dev' })],
      since: T0,
    });
    assert.equal(away.deferred[0]!.reason, 'away', 'went pending while the developer was away');

    const none = buildAttentionHistory({
      executions: [EXEC1],
      decisions: [dec('d-old', { createdAt: T0 + 5 * M })],
      events: [],
      since: T0,
    });
    assert.equal(none.deferred.length, 0, 'nothing resolved yet → nothing was passed over');
  });
});

describe('buildAttentionHistory — recurrence and determinism', () => {
  const decisions = [
    dec('d-1', { subject: 'bash:rm -rf build', createdAt: T0 + M }),
    dec('d-2', { subject: 'bash:rm -rf build', createdAt: T0 + 2 * M }),
    dec('d-3', { subject: 'bash:rm -rf build', createdAt: T0 + 3 * M }),
    dec('d-solo', { subject: 'bash:echo hi', createdAt: T0 + 4 * M }),
    dec('d-nosubject', { createdAt: T0 + 5 * M }),
  ];
  const input = { executions: [EXEC1], decisions, events: [], since: T0 };

  test('recurringSubjects counts subjects appearing at least twice', () => {
    const h = buildAttentionHistory(input);
    assert.deepEqual(h.recurringSubjects, [{ subject: 'bash:rm -rf build', count: 3 }]);
  });

  test('recurred on an interrupted row derives from the later same-subject row', () => {
    const withRes = {
      ...input,
      decisions: [
        { ...decisions[0]!, status: 'accepted' as const, resolution: { status: 'accepted' as const, resolvedAt: T0 + 2 * M - 1, resolvedBy: 'dev' } },
        ...decisions.slice(1),
      ],
    };
    const h = buildAttentionHistory(withRes);
    const first = h.interrupted.find((i) => i.decisionId === 'd-1')!;
    assert.equal(first.recurred, true);
  });

  test('idempotent: same input twice → deepEqual; reordered input → deepEqual; inputs untouched', () => {
    const before = JSON.stringify({ d: decisions, e: [] });
    const h1 = buildAttentionHistory(input);
    const h2 = buildAttentionHistory(input);
    assert.deepEqual(h1, h2);
    const h3 = buildAttentionHistory({
      ...input,
      decisions: [...decisions].reverse(),
      events: [],
    });
    assert.deepEqual(h1, h3);
    assert.equal(JSON.stringify({ d: decisions, e: [] }), before);
    assert.equal(renderAttentionHistory(h1), renderAttentionHistory(h2));
  });
});

describe('renderAttentionHistory', () => {
  test('shows every section and never a numeric "attention saved"', () => {
    const h = buildAttentionHistory({
      executions: [EXEC1],
      decisions: [
        dec('d1', {
          subject: 'bash:pnpm add x',
          createdAt: T0 + M,
          status: 'accepted',
          why: why(['require-approval-dependency-install']),
          resolution: { status: 'accepted', resolvedAt: T0 + 2 * M, resolvedBy: 'dev' },
        }),
        dec('d2', { subject: 'bash:pnpm add x', createdAt: T0 + 3 * M }),
      ],
      events: [
        ev('e1', 'policy.delegated', T0 + 4 * M, { command: 'pnpm add y', category: 'dependencies', delegationId: 'dl-1', grantedBy: 'dev' }),
        ev('e2', 'test.failed', T0 + 5 * M, { testName: 't' }, { attention: { level: 'BACKGROUND', action: 'RECORD' } }),
      ],
      since: T0,
      budgetDemoted: ['cand:decision:d2'],
    });
    const text = renderAttentionHistory(h);
    for (const header of ['NEEDS YOUR REVIEW', 'INTERRUPTED YOU', 'DELEGATED', 'SUPPRESSED (observed)', 'RECURRING', 'BY CATEGORY', 'totals:']) {
      assert.ok(text.includes(header), `section header missing: ${header}`);
    }
    assert.match(text, /→ answered \(took 1m\)/);
    assert.match(text, /pnpm add y/);
    assert.match(text, /\[budget\] t-d2/);
    assert.match(text, /bash:pnpm add x ×2/);
    assert.match(text, /attention saved: not measured/);
    assert.doesNotMatch(text, /saved[:\s]+\d/, 'attention saved is never rendered as a number');
    assert.doesNotMatch(JSON.stringify(h), /"attentionSaved(?:Ms)?":\s*\d/);
  });

  test('empty window renders honest empties, not fake numbers', () => {
    const text = renderAttentionHistory(
      buildAttentionHistory({ executions: [EXEC1], decisions: [], events: [], since: T0, until: T0 + M }),
    );
    assert.match(text, /NEEDS YOUR REVIEW\n  none needed/);
    assert.match(text, /INTERRUPTED YOU\n  none/);
    assert.match(text, /RECURRING\n  nothing repeated/);
  });
});
