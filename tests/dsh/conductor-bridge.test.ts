import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { DecisionQueue } from '../../src/decision/decision-queue.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { ConductorBridge } from '../../src/dsh/conductor-bridge.js';
import type {
  ConductorHostBindings,
  HostApprovalOutcome,
  HostPreStepDecision,
  HostPreToolDecision,
  HostQuestionAnswer,
  HostQuestionRequest,
  HostSessionEvent,
  HostStepPayload,
  HostToolExecution,
  HostToolResult,
} from '../../src/dsh/host-surface.js';

type AnyHandler = (...args: never[]) => unknown;

/** Fake DSH host speaking the REAL extension-point contracts. */
class FakeHost implements ConductorHostBindings {
  private handlers = new Map<string, AnyHandler[]>();

  on(event: 'session/event', handler: (evt: HostSessionEvent) => void): () => void;
  on(event: 'tools/result', handler: (r: HostToolResult) => void): () => void;
  on(event: 'tools/pre-execute', handler: (e: HostToolExecution) => HostPreToolDecision | undefined): () => void;
  on(event: 'user-questions/request', handler: (q: HostQuestionRequest) => HostQuestionAnswer | undefined): () => void;
  on(event: 'agent/pre-step', handler: (p: HostStepPayload) => HostPreStepDecision | undefined): () => void;
  on(event: 'approval/request', handler: (a: { toolName: string; agentId?: string }) => HostApprovalOutcome | undefined): () => void;
  on(event: string, handler: AnyHandler): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((h) => h !== handler),
      );
    };
  }

  listenerCount(event: string): number {
    return (this.handlers.get(event) ?? []).length;
  }

  private fire(event: string, arg: unknown): unknown {
    let result: unknown;
    for (const h of this.handlers.get(event) ?? []) {
      result = (h as (a: unknown) => unknown)(arg);
      if (result !== undefined) return result; // first claim wins (waterfall-ish)
    }
    return result;
  }

  emit(event: 'session/event', evt: HostSessionEvent): void {
    for (const h of this.handlers.get(event) ?? []) (h as (a: HostSessionEvent) => void)(evt);
  }

  emitResult(r: HostToolResult): void {
    for (const h of this.handlers.get('tools/result') ?? []) (h as (a: HostToolResult) => void)(r);
  }

  dispatchTool(exec: HostToolExecution): HostPreToolDecision {
    const claimed = this.fire('tools/pre-execute', exec);
    return (claimed as HostPreToolDecision) ?? { kind: 'allow' };
  }

  askQuestion(req: HostQuestionRequest): HostQuestionAnswer | undefined {
    return this.fire('user-questions/request', req) as HostQuestionAnswer | undefined;
  }

  nextStep(payload: HostStepPayload): HostPreStepDecision {
    const claimed = this.fire('agent/pre-step', payload);
    return (claimed as HostPreStepDecision) ?? { kind: 'enter' };
  }

  requestApproval(req: { toolName: string; agentId?: string }): HostApprovalOutcome {
    const claimed = this.fire('approval/request', req);
    return (claimed as HostApprovalOutcome) ?? 'unavailable';
  }
}

function harness(autoAnswerRoutine = false) {
  const db = new ConductorDatabase({ path: ':memory:' });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  const bridge = new ConductorBridge({ manager, decisions, autoAnswerRoutine });
  const host = new FakeHost();
  const detach = bridge.attach(host);
  return { db, manager, decisions, bridge, host, detach, execRepo };
}

describe('ConductorBridge — real DSH contracts (fake host)', () => {
  test('routine tool calls are observed and delegated (undefined = allow)', () => {
    const { manager, bridge, host, db } = harness();
    const exec = bridge.startExecution('build api', { workspaceRoot: '/srv/api', hostKey: 'agent:alpha' });
    const decision = host.dispatchTool({
      callId: 'c1',
      name: 'read',
      arguments: { file_path: 'src/index.ts' },
      agentId: 'alpha',
    });
    assert.deepEqual(decision, { kind: 'allow' }, 'nothing claimed → DSH dispatches');
    assert.equal(manager.getStatus(exec.id).status, 'RUNNING');
    db.close();
  });

  test('dangerous tool: claimed with kind:deny, ONE decision per call (dedupe), step frozen', () => {
    const { manager, decisions, bridge, host, db } = harness();
    const exec = bridge.startExecution('ship it', { workspaceRoot: '/srv/x', hostKey: 'agent:a1' });

    const decision = host.dispatchTool({
      callId: 'call-42',
      name: 'bash',
      arguments: { command: 'git push --force origin main' },
      agentId: 'a1',
    });
    assert.equal(decision.kind, 'deny');

    assert.equal(manager.getStatus(exec.id).status, 'PAUSED');
    const pend = decisions.pending();
    assert.equal(pend.length, 1, 'tool.called + command.started collapse to ONE decision');
    assert.ok(pend[0].question.includes('git push --force'));
    assert.equal(pend[0].dedupeKey, `${exec.id}:call-42`);

    // While held: pre-step rejects AND holds claimed messages for reinjection
    const msgs = [{ content: [{ type: 'text', text: 'queued work' }], source: { kind: 'user' } }];
    const step = host.nextStep({ agentId: 'a1', turn: 2, step: 1, messages: msgs });
    assert.equal(step.kind, 'reject');
    assert.equal((step as { holdForHuman?: boolean }).holdForHuman, true);

    // Further tools while held are denied too
    const blocked = host.dispatchTool({ callId: 'c9', name: 'write', arguments: { file_path: 'a.ts' }, agentId: 'a1' });
    assert.equal(blocked.kind, 'deny');
    db.close();
  });

  test('human approves -> decision consumed -> retry passes once; second retry re-gated', () => {
    const { manager, decisions, bridge, host, db } = harness();
    const exec = bridge.startExecution('deploy prep', { workspaceRoot: '/srv/d', hostKey: 'agent:d1' });

    host.dispatchTool({ callId: 'c1', name: 'bash', arguments: { command: 'kubectl delete svc legacy-api' }, agentId: 'd1' });
    assert.equal(manager.getStatus(exec.id).status, 'PAUSED');
    const pend = decisions.pending()[0];

    // Human approves THIS action once (like the CLI's \`-o approve-once\`).
    decisions.resolve(pend.id, 'custom', { selectedOptionId: 'approve-once' });
    assert.equal(manager.getStatus(exec.id).status, 'RUNNING');

    const retry = host.dispatchTool({ callId: 'c2', name: 'bash', arguments: { command: 'kubectl delete svc legacy-api' }, agentId: 'd1' });
    assert.deepEqual(retry, { kind: 'allow' }, 'approved retry passes');

    const third = host.dispatchTool({ callId: 'c3', name: 'bash', arguments: { command: 'kubectl delete svc legacy-api' }, agentId: 'd1' });
    assert.equal(third.kind, 'deny', 'one-time approval consumed');
    db.close();
  });

  test('agent question: mirrors into queue and delegates to the human UI by default', () => {
    const { manager, decisions, bridge, host, db } = harness();
    const exec = bridge.startExecution('payments', { workspaceRoot: '/srv/p', hostKey: 'agent:p1' });

    const answer = host.askQuestion({
      agentId: 'p1',
      questions: [
        {
          id: 'q1',
          question: 'Charge the customer before or after saving the receipt?',
          options: [{ label: 'save then charge' }, { label: 'charge then save' }],
        },
      ],
    });
    assert.equal(answer, undefined, 'unclaimed: the human answers in the UI');

    const pend = decisions.pending();
    assert.equal(pend.length, 1);
    assert.match(pend[0].question, /Charge the customer/);
    assert.equal(manager.getStatus(exec.id).status, 'PAUSED');
    db.close();
  });

  test('auto-answer mode answers routine questions with the DSH exact shape', () => {
    const { decisions, bridge, host, db } = harness(true);
    bridge.startExecution('routine', { workspaceRoot: '/srv/r', hostKey: 'agent:r1' });
    const answer = host.askQuestion({
      agentId: 'r1',
      questions: [
        { id: 'q7', question: 'Which indentation should config files use?', options: [{ label: 'spaces' }, { label: 'tabs' }] },
      ],
    });
    assert.ok(answer, 'answered on the user’s behalf');
    assert.equal(answer.answers.length, 1);
    assert.equal(answer.answers[0].id, 'q7');
    assert.deepEqual(answer.answers[0].selected, ['spaces']);
    assert.equal(decisions.pending().length, 0, 'no interrupt queued');
    db.close();
  });

  test('approval/request is rejected while a human holds the run; delegated otherwise', () => {
    const { manager, bridge, host, db } = harness();
    const exec = bridge.startExecution('gated', { workspaceRoot: '/srv/g', hostKey: 'agent:g1' });
    void exec;
    // not held → delegate
    assert.equal(host.requestApproval({ toolName: 'bash', agentId: 'g1' }), 'unavailable');
    // hold it
    const stored = manager.executionRepo.findById(exec.id)!;
    stored.pause('testing', 'attention');
    manager.executionRepo.save(stored);
    assert.equal(host.requestApproval({ toolName: 'bash', agentId: 'g1' }), 'rejected');
    db.close();
  });

  test('tools/result feeds test outcomes into the pipeline', () => {
    const { manager, bridge, host, db } = harness();
    const exec = bridge.startExecution('tdd', { workspaceRoot: '/srv/t', hostKey: 'agent:t1' });
    host.emitResult({
      callId: 'tr1',
      name: 'bash',
      agentId: 't1',
      isError: true,
      text: 'FAIL tests/cart',
      arguments: { command: 'pnpm test cart' },
    });
    const history = manager.getHistory(exec.id, { limit: 50 });
    assert.ok(history.some((e) => e.type === 'test.failed'));
    db.close();
  });

  test('detach removes every subscription (no leaks after stop)', () => {
    const { bridge, host, detach, db } = harness();
    bridge.startExecution('x', { workspaceRoot: '/srv/x', hostKey: 'agent:d1' });
    const force = () =>
      host.dispatchTool({ callId: 'z', name: 'bash', arguments: { command: 'git push --force' }, agentId: 'd1' });
    assert.equal(force().kind, 'deny', 'mounted bridge gates dangerous calls');
    detach();
    assert.equal(host.listenerCount('tools/pre-execute'), 0);
    assert.deepEqual(force(), { kind: 'allow' }, 'after detach the host is untouched');
    db.close();
  });

  test('unmanaged agents are never gated (no active execution)', () => {
    const h = harness();
    const decision = h.host.dispatchTool({
      callId: 'free-1',
      name: 'bash',
      arguments: { command: 'git push --force' },
      agentId: 'nobody',
    });
    assert.deepEqual(decision, { kind: 'allow' });
    h.db.close();
  });
});
