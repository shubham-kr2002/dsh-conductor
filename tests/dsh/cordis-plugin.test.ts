import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mountConductor } from '../../src/dsh/mount.js';
import type { CordisCtx } from '../../src/dsh/cordis-plugin.js';
import type { ConductorMount } from '../../src/dsh/mount.js';

/**
 * Fake cordis Context implementing the REAL waterfall dispatch rules:
 * listener returns next()'s value to delegate; returning a value claims.
 */
class FakeCtx implements CordisCtx {
  listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  effects: Array<() => void> = [];
  services = new Map<string, unknown>();
  disposed = false;

  on(name: string, listener: (...args: unknown[]) => unknown): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
    return () => {
      this.listeners.set(name, (this.listeners.get(name) ?? []).filter((l) => l !== listener));
    };
  }

  effect(execute: () => void | (() => void)): void {
    const disposer = execute();
    if (typeof disposer === 'function') this.effects.push(disposer);
  }

  provide(name: string, value: unknown): () => void {
    this.services.set(name, value);
    return () => this.services.delete(name);
  }

  /** Waterfall dispatch: last arg is the built-in marker; next() yields it. */
  async waterfall(name: string, ...args: unknown[]): Promise<unknown> {
    const marker = Symbol.for('built-in');
    const builtIn = args.length > 0 && args[args.length - 1] === marker;
    const core = builtIn ? args.slice(0, -1) : args;
    const list = this.listeners.get(name) ?? [];

    let next: () => Promise<unknown> = async () => marker; // built-in behavior
    for (let i = list.length - 1; i >= 0; i--) {
      const listener = list[i]!;
      const nxt = next;
      next = async () => (await listener(...core, nxt)) as unknown;
    }
    return next();
  }

  emit(name: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(name) ?? []) l(...args);
  }

  dispose(): void {
    for (const d of this.effects.reverse()) d();
    this.effects = [];
    this.listeners.clear();
    this.disposed = true;
  }
}

function mount(): { ctx: FakeCtx; m: ConductorMount } {
  const m = mountConductor({
    goal: 'migrate payments service',
    workspaceRoot: '/srv/payments',
    dbPath: ':memory:',
    constraints: ['no schema changes without approval'],
  });
  const ctx = new FakeCtx();
  m.plugin.apply(ctx as unknown as CordisCtx);
  return { ctx, m };
}

const ALLOW = Symbol.for('built-in');

describe('cordis-plugin mounting (real waterfall semantics)', () => {
  test('routine call delegates: listener returns next() result (built-in allow)', async () => {
    const { ctx, m } = mount();
    const result = await ctx.waterfall('tools/pre-execute', {
      callId: 'r1',
      name: 'read',
      arguments: { file_path: 'README.md' },
      agent: { id: 'ag1' },
    }, ALLOW);
    assert.equal(result, ALLOW, 'delegated through to built-in dispatch');
    m.close();
  });

  test('dangerous call claims with {kind:"deny"} and pauses the execution', async () => {
    const { ctx, m } = mount();
    const result = (await ctx.waterfall('tools/pre-execute', {
      callId: 'd1',
      name: 'bash',
      arguments: { command: 'git push --force origin main' },
      agent: { id: 'ag1' },
    }, ALLOW)) as { kind: string; reason?: string };
    assert.equal(result.kind, 'deny');
    assert.match(String(result.reason), /conductor decisions/i);
    assert.equal(m.manager.getStatus(m.executionId).status, 'PAUSED');
    assert.equal(m.decisions.pending().length, 1, 'one decision for the whole bash call');
    m.close();
  });

  test('freeze re-injects claimed messages and rejects the step', async () => {
    const { ctx, m } = mount();
    const injected: unknown[] = [];
    const agent = { id: 'ag1', inject: (msg: unknown) => injected.push(msg) };

    await ctx.waterfall('tools/pre-execute', {
      callId: 'd2',
      name: 'bash',
      arguments: { command: 'terraform destroy -auto-approve' },
      agent,
    }, ALLOW);

    const claimedMessages = [{ content: [{ type: 'text', text: 'next task' }], source: { kind: 'user' } }];
    const step = (await ctx.waterfall('agent/pre-step', {
      agent,
      messages: claimedMessages,
      turn: 3,
      step: 1,
    }, ALLOW)) as { kind: string };
    assert.equal(step.kind, 'reject');
    assert.deepEqual(injected, claimedMessages, 'claimed work was re-injected, not dropped');
    m.close();
  });

  test('released run enters again: pre-step delegates to next()', async () => {
    const { ctx, m } = mount();
    await ctx.waterfall('tools/pre-execute', {
      callId: 'd3',
      name: 'bash',
      arguments: { command: 'git push --force' },
      agent: { id: 'ag1' },
    }, ALLOW);
    const pend = m.decisions.pending()[0]!;
    m.decisions.resolve(pend.id, 'rejected', { answerBy: 'dev' }); // deny → stays resolved, resumes
    assert.equal(m.manager.getStatus(m.executionId).status, 'RUNNING');

    const step = await ctx.waterfall('agent/pre-step', {
      agent: { id: 'ag1' }, messages: [], turn: 4, step: 1,
    }, ALLOW);
    assert.equal(step, ALLOW, 'delegated — the loop proceeds');
    m.close();
  });

  test('questions delegate to the human by default and land in the queue', async () => {
    const { ctx, m } = mount();
    const answer = await ctx.waterfall('user-questions/request', {
      questions: [{ id: 'qq1', question: 'Drop the legacy payments table and recreate it?', options: [{ label: 'yes, drop' }, { label: 'migrate in place' }] }],
      agent: { id: 'ag1' },
    }, ALLOW);
    assert.equal(answer, ALLOW, 'not claimed — the UI answerer handles it');
    const pend = m.decisions.pending();
    assert.equal(pend.length, 1);
    assert.match(pend[0]!.question, /Drop the legacy payments table/);
    m.close();
  });

  test('auto-answer mode claims questions with a structured DSH answer', async () => {
    const m = mountConductor({
      goal: 'routine work',
      workspaceRoot: '/srv/r',
      dbPath: ':memory:',
      autoAnswerRoutine: true,
    });
    const ctx = new FakeCtx();
    m.plugin.apply(ctx);
    const answer = (await ctx.waterfall('user-questions/request', {
      questions: [{ id: 'qq2', question: 'Which formatting style should generated configs use?', options: [{ label: 'prettier' }, { label: 'dprint' }] }],
      agent: { id: 'ag1' },
    }, ALLOW)) as { answers: Array<{ id: string; selected: string[] }> };
    assert.equal(answer.answers[0]!.id, 'qq2');
    assert.deepEqual(answer.answers[0]!.selected, ['prettier']);
    m.close();
  });

  test('session/event: results join gated calls; idle turn completes the run', async () => {
    const { ctx, m } = mount();
    const seen = () => m.manager.getHistory(m.executionId, { limit: 100 }).map((e) => e.type);

    // The gate observes the call first (as DSH dispatch would)…
    await ctx.waterfall('tools/pre-execute', {
      callId: 'ok1',
      name: 'bash',
      arguments: { command: 'echo done' },
      agent: { id: 'ag1' },
    }, ALLOW);
    // …then the durable log reports its outcome post-commit.
    ctx.emit('session/event', { id: 'sess1' }, {
      type: 'tool/result',
      time: Date.now(),
      data: {
        turn: 1, step: 1,
        message: {
          id: 'ok1', role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'ok1', content: [{ type: 'text', text: 'done' }] }],
          source: { kind: 'tool', callId: 'ok1' },
        },
      },
    });
    assert.ok(seen().includes('command.completed'));
    assert.equal(m.manager.getStatus(m.executionId).status, 'RUNNING');

    ctx.emit('session/event', { id: 'sess1' }, {
      type: 'turn/end',
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    assert.equal(m.manager.getStatus(m.executionId).status, 'COMPLETED');
    m.close();
  });

  test('dispose unwinds every subscription', () => {
    const { ctx, m } = mount();
    assert.ok(ctx.listeners.get('tools/pre-execute')?.length === 1);
    ctx.dispose();
    assert.equal(ctx.listeners.size, 0);
    assert.equal(ctx.effects.length, 0);
    m.close();
  });

  test('mount exposes conductor as a service for other plugins', () => {
    const { ctx, m } = mount();
    const svc = ctx.services.get('conductor') as { bridge: unknown } | undefined;
    assert.ok(svc?.bridge, 'provided');
    m.close();
  });
});
