/**
 * Phase-10 — seeded fuzz over the real pipeline.
 *
 * 120 independent event sequences, generated from a fixed seed, pushed through
 * the same EventAdapter → ExecutionManager → DecisionQueue → sqlite path the
 * product uses. After EVERY event the attention model is rebuilt from durable
 * rows and the fleet invariants are re-checked. Nothing here mocks: if a
 * sequence produces a contradiction, the seed and the exact op log are printed
 * so it can be replayed.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { compareAttention } from '../../src/attention/attention-priority.js';
import {
  T,
  claimKind,
  cleanTmpDirs,
  dispatchTool,
  gateCommand,
  modelFrom,
  openRuntime,
  orderDeviations,
  prng,
  startAgent,
  statusOf,
  tmpDir,
} from './helpers.js';
import type { Runtime } from './helpers.js';
import type { Execution } from '../../src/domain/execution.js';

after(() => cleanTmpDirs());

const HELD = new Set(['PAUSED', 'BLOCKED', 'TAKEN_OVER', 'HANDOFF_PENDING']);
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

const DANGER = [
  'rm -rf /var/lib/data',
  'git push --force origin main',
  'helm uninstall payments-prod',
  'kubectl delete ns staging',
  'terraform destroy -auto-approve',
  'sudo rm -rf /tmp/thing',
];
const ROUTINE = ['git status', 'pnpm test', 'ls -la', 'pwd', 'git diff', 'node --test'];
const QUESTIONS = [
  'Charge the customer card on file for the migration?',
  'Delete the customer records table before the backfill?',
  'Which region should the new queue live in?',
  'Reuse the legacy auth schema or migrate it?',
];

type Op =
  | 'danger'
  | 'routine'
  | 'question'
  | 'turnEndOk'
  | 'turnEndFail'
  | 'resolveAccept'
  | 'resolveDeny'
  | 'resolveCustom'
  | 'grant'
  | 'revoke'
  | 'redeliver'
  | 'toolResult';

const VOCAB: Op[] = [
  'danger',
  'danger',
  'routine',
  'question',
  'turnEndOk',
  'turnEndFail',
  'resolveAccept',
  'resolveDeny',
  'resolveCustom',
  'grant',
  'revoke',
  'redeliver',
  'toolResult',
];

interface Step {
  op: Op;
  agent: number;
  detail: string;
}

const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length) % xs.length] as T;

function runSequence(rt: Runtime, agentIds: string[], rng: () => number, seq: number): Step[] {
  const log: Step[] = [];
  const execOf = (i: number): string => rt.bridge.executionFor({ agentId: agentIds[i] })!.id;
  const agent = (): number => Math.floor(rng() * agentIds.length) % agentIds.length;
  // 3–7 hostile steps per sequence: enough to interleave gates, verdicts,
  // delegation churn and replays inside one run's lifetime.
  const steps = 3 + Math.floor(rng() * 5);

  for (let s = 0; s < steps; s++) {
    const op = pick(rng, VOCAB);
    const a = agent();
    const id = execOf(a);
    const callId = `s${String(seq)}-${String(s)}-${agentIds[a]}`;
    let detail = '';
    switch (op) {
      case 'danger': {
        const command = pick(rng, DANGER);
        detail = command;
        if (rng() < 0.6) {
          dispatchTool(rt, agentIds[a]!, callId, command);
        } else {
          gateCommand(rt, id, callId, command);
        }
        break;
      }
      case 'routine': {
        const command = pick(rng, ROUTINE);
        detail = command;
        claimKind(dispatchTool(rt, agentIds[a]!, callId, command));
        break;
      }
      case 'question': {
        const q = pick(rng, QUESTIONS);
        detail = q;
        rt.host.askQuestion({ questions: [{ id: callId, question: q }], agentId: agentIds[a] });
        break;
      }
      case 'turnEndOk':
      case 'turnEndFail': {
        detail = op;
        const exec = rt.execRepo.findById(id)!;
        if (!TERMINAL.has(exec.status) && !HELD.has(exec.status)) {
          for (const evt of [
            {
              id: `evt-${callId}`,
              executionId: id,
              type: op === 'turnEndOk' ? ('execution.completed' as const) : ('execution.failed' as const),
              timestamp: Date.now(),
              payload:
                op === 'turnEndOk'
                  ? { executionId: id, completedWork: [], summary: 'done', durationMs: 1 }
                  : { executionId: id, error: 'agent exploded' },
              source: 'dsh' as const,
              metadata: {},
            },
          ]) {
            rt.manager.processEvent(evt);
          }
        } else {
          detail += ' (skipped: held/terminal)';
        }
        break;
      }
      case 'resolveAccept':
      case 'resolveDeny':
      case 'resolveCustom': {
        const pending = rt.decisions.pending(id);
        if (pending.length === 0) {
          detail = 'nothing pending';
          break;
        }
        const target = pending[Math.floor(rng() * pending.length) % pending.length]!;
        detail = target.id;
        if (op === 'resolveAccept') {
          rt.decisions.resolve(target.id, 'accepted', {
            ...(rng() < 0.5 ? { selectedOptionId: 'approve-once' } : {}),
          });
        } else if (op === 'resolveDeny') {
          rt.decisions.resolve(target.id, 'rejected');
        } else {
          const opts = target.options.map((o) => o.id);
          rt.decisions.resolve(target.id, 'custom', {
            ...(opts.length > 0 ? { selectedOptionId: pick(rng, opts) } : {}),
            customValue: 'do it differently',
          });
        }
        break;
      }
      case 'grant': {
        const category = pick(rng, ['deployment', 'dependencies', 'shell', 'git', 'any'] as const);
        detail = category;
        rt.delegations.grant({ scope: 'workspace', category, grantedBy: 'fuzz' }, Date.now());
        break;
      }
      case 'revoke': {
        const active = rt.delegations.list({ active: true, now: Date.now() });
        if (active.length === 0) {
          detail = 'nothing to revoke';
          break;
        }
        const target = active[Math.floor(rng() * active.length) % active.length]!;
        detail = target.id;
        rt.delegations.revoke(target.id, 'fuzz', Date.now());
        break;
      }
      case 'redeliver': {
        // the same tool call, delivered twice more (network replay)
        const command = pick(rng, DANGER);
        detail = command;
        for (let k = 0; k < 3; k++) gateCommand(rt, id, callId, command);
        break;
      }
      case 'toolResult': {
        detail = 'result';
        rt.host.emitResult({
          callId: `s${String(seq)}-${String(s)}-res`,
          name: 'bash',
          agentId: agentIds[a],
          isError: rng() < 0.4,
          text: rng() < 0.5 ? 'tests failed' : 'ok',
        });
        break;
      }
    }
    log.push({ op, agent: a, detail });
    checkInvariants(rt, `${String(seq)}/${String(s)} ${op}`, log);
  }
  return log;
}

function checkInvariants(rt: Runtime, where: string, log: Step[]): void {
  const now = Date.now();
  const executions = rt.execRepo.list({});
  const decisions = rt.decisionRepo.list({});
  const model = modelFrom(rt, now, executions);
  const byId = new Map(executions.map((e) => [e.id, e] as const));
  const label = (id: string): string => byId.get(id)?.agent.id ?? id;

  const fail = (msg: string): never => {
    assert.fail(
      `invariant broken at ${where}: ${msg}\nrecent ops: ${JSON.stringify(log.slice(-8))}\nseeded replay: ${JSON.stringify(
        log.map((l) => `${l.op}@${String(l.agent)}:${l.detail}`),
      ).slice(0, 900)}`,
    );
  };

  // (1) the model is ordered (only the documented post-sort budget demotion may
  //     appear to break the comparator)
  const deviations = orderDeviations(model.items, now, model.budgetDemoted);
  if (deviations.length > 0) fail(`ordering: ${JSON.stringify(deviations.slice(0, 3))}`);
  const cmp = compareAttention(now);
  for (let i = 1; i < model.items.length; i++) {
    const a = model.items[i - 1]!;
    const b = model.items[i]!;
    if (cmp(a, b) > 0 && !(a.disposition === 'queue' && model.budgetDemoted.includes(a.id))) {
      fail(`compareAttention says ${a.id} trails ${b.id}`);
    }
  }

  // (2) needs-you slot: criticals + at most the budget of interrupts
  const criticals = model.items.filter((i) => i.disposition === 'critical').length;
  const interrupts = model.items.filter((i) => i.disposition === 'interrupt').length;
  if (model.map.needsYou !== criticals + interrupts) {
    fail(`needsYou ${String(model.map.needsYou)} != ${String(criticals)}+${String(interrupts)}`);
  }
  if (criticals === 0 && interrupts > 1) fail(`budget leaked ${String(interrupts)} interrupts`);
  if (criticals > 0 && interrupts > 0) fail('interrupts survived in front of a critical item');
  const perExec = new Map<string, number>();
  for (const i of model.items) {
    if (i.disposition !== 'interrupt') continue;
    const n = (perExec.get(i.executionId) ?? 0) + 1;
    perExec.set(i.executionId, n);
    if (n > 1) fail(`agent ${label(i.executionId)} claimed ${String(n)} interrupts`);
  }

  // (3) terminal runs are never presented as live work
  const active = executions.filter((e) => !TERMINAL.has(e.status));
  if (model.map.finished !== executions.length - active.length) fail('finished count');
  if (
    model.map.working !==
    active.filter(
      (e) => !HELD.has(e.status) && e.status !== 'TAKEN_OVER' && !decisions.some((d) => d.status === 'pending' && d.executionId === e.id),
    ).length
  ) {
    fail('working count disagrees with the rows');
  }
  for (const item of model.items) {
    const exec = byId.get(item.executionId);
    if (exec && TERMINAL.has(exec.status) && item.factors.blocking) {
      fail(`blocking item for terminal run ${label(exec.id)}`);
    }
  }

  // (4) every pending judgment is on the surface or its run is held/terminal
  const surfaced = new Set(model.items.flatMap((i) => i.refIds));
  for (const d of decisions.filter((x) => x.status === 'pending')) {
    const exec = byId.get(d.executionId);
    if (!exec) fail(`decision ${d.id} has no execution`);
    if (surfaced.has(d.id)) continue;
    if (exec && (TERMINAL.has(exec.status) || HELD.has(exec.status))) continue;
    fail(`pending decision ${d.id} is neither surfaced nor held (${String(exec?.status)})`);
  }

  // (5) aggregate truth: references and counters match the rows exactly
  for (const e of executions) {
    const rows = decisions.filter((d) => d.executionId === e.id);
    if (e.metrics.decisionCount !== rows.length) {
      fail(`${label(e.id)} decisionCount ${String(e.metrics.decisionCount)} != ${String(rows.length)} rows`);
    }
    if (e.decisions.length !== new Set(e.decisions).size) fail(`${label(e.id)} duplicated decision refs`);
    if (new Set(e.decisions).size !== rows.length) fail(`${label(e.id)} refs != rows`);
    for (const ref of e.decisions) {
      if (!rows.some((r) => r.id === ref)) fail(`${label(e.id)} references unknown decision ${ref}`);
    }
    if (TERMINAL.has(e.status) && rows.some((r) => r.status === 'pending') && e.status === 'COMPLETED') {
      // allowed (durable history) but it must never be presented as blocking
      for (const item of model.items.filter((i) => i.executionId === e.id)) {
        if (item.factors.blocking) fail(`completed run ${label(e.id)} shown as blocking`);
      }
    }
    const status = statusOf(rt, e.id);
    if (status !== e.status) fail('reload disagrees with the in-memory aggregate');
  }

  // (6) decisions are internally consistent rows
  for (const d of decisions) {
    if (d.status === 'pending') {
      if (d.resolution) fail(`pending decision ${d.id} carries a resolution`);
      if (d.consumedAt != null) fail(`pending decision ${d.id} was consumed`);
    } else if (d.status !== 'cancelled' && d.status !== 'expired') {
      if (!d.resolution) fail(`${d.status} decision ${d.id} has no resolution`);
      else if (d.resolution.status !== d.status) fail(`resolution/status mismatch on ${d.id}`);
    }
  }
}

test(
  'fuzz: 120 seeded sequences through the real pipeline hold every invariant at every step',
  // Heaviest file in the matrix: ~600 pipeline steps, each of which rebuilds
  // the whole model from durable rows. Real measured cost here is ~5 s.
  { timeout: 25_000 },
  () => {
    const dir = tmpDir('fuzz');
    const agents = ['fa', 'fb', 'fc', 'fd', 'fe'];
    // Twelve independent boards of ten sequences: the state a sequence grows
    // into stays bounded, so the per-step model rebuild stays a real check
    // rather than a sampling compromise.
    const BATCHES = 12;
    const PER_BATCH = 10;
    let totalSteps = 0;
    let totalEvents = 0;
    let lastBoard: ReturnType<typeof openRuntime> | null = null;

    for (let batch = 0; batch < BATCHES; batch++) {
      const rt = openRuntime(join(dir, `board-${String(batch)}.sqlite`));
      try {
        for (const a of agents) startAgent(rt, a, `fuzz slice ${a}`);
        for (let i = 0; i < PER_BATCH; i++) {
          const seq = batch * PER_BATCH + i;
          totalSteps += runSequence(rt, agents, prng(0x5eed + seq), seq).length;
        }
        totalEvents += rt.decisionRepo.list({}).length;

        // The board is reproducible from its own durable rows.
        const now = Date.now();
        const once = modelFrom(rt, now);
        const twice = modelFrom(rt, now);
        assert.deepEqual(
          twice.items.map((i) => `${i.id}|${i.disposition}|${i.category}`),
          once.items.map((i) => `${i.id}|${i.disposition}|${i.category}`),
          'same rows + same now = same model',
        );
        assert.deepEqual(twice.map, once.map);
        checkInvariants(rt, `board ${String(batch)} final`, []);
        for (const a of agents) {
          const exec = rt.bridge.executionFor({ agentId: a }) as Execution | undefined;
          assert.ok(exec, `${a} still exists`);
          assert.ok(
            [
              'STARTING',
              'RUNNING',
              'WAITING',
              'PAUSED',
              'BLOCKED',
              'TAKEN_OVER',
              'COMPLETED',
              'FAILED',
              'CANCELLED',
            ].includes(exec!.status),
            `unexpected status ${String(exec!.status)}`,
          );
          assert.ok(!TERMINAL.has(exec!.status) || exec!.timestamps.completedAt != null);
        }
        lastBoard = rt;
      } finally {
        rt.close();
      }
    }
    assert.ok(lastBoard, 'at least one board ran');
    assert.equal(totalSteps >= 120 * 3, true, `only ${String(totalSteps)} steps ran`);
    // Guard against a fuzz that quietly does nothing: the vocabulary must
    // actually produce durable judgments.
    assert.equal(totalEvents >= 80, true, `only ${String(totalEvents)} decisions were created`);
  },
);

test(
  'fuzz (replay): a recorded adversarial sequence rebuilds identically from a reopened database',
  { timeout: T.timeout },
  () => {
    const dir = tmpDir('fuzz-replay');
    const dbPath = join(dir, 'conductor.sqlite');
    const script: Array<[Op, string]> = [
      ['danger', 'git push --force origin main'],
      ['danger', 'helm uninstall payments-prod'],
      ['grant', 'deployment'],
      ['danger', 'kubectl delete ns staging'],
      ['question', 'Charge the customer card on file for the migration?'],
      ['redeliver', 'rm -rf /var/lib/data'],
      ['routine', 'pnpm test'],
      ['turnEndOk', ''],
    ];
    let rt = openRuntime(dbPath);
    try {
      startAgent(rt, 'replayer', 'reconcile the fleet');
      for (const [op, arg] of script) {
        const exec = rt.bridge.executionFor({ agentId: 'replayer' })!;
        if (op === 'danger') gateCommand(rt, exec.id, `rp-${op}-${arg.length}`, arg);
        else if (op === 'grant') rt.delegations.grant({ scope: 'workspace', category: 'deployment', grantedBy: 'dev' }, Date.now());
        else if (op === 'question') rt.host.askQuestion({ questions: [{ id: 'rp-q', question: arg }], agentId: 'replayer' });
        else if (op === 'redeliver') {
          for (let k = 0; k < 3; k++) gateCommand(rt, exec.id, 'rp-dup', arg);
        } else if (op === 'routine') claimKind(dispatchTool(rt, 'replayer', 'rp-routine', arg));
        else if (op === 'turnEndOk') {
          const held = rt.decisions.pending(exec.id);
          for (const d of held) rt.decisions.resolve(d.id, 'rejected');
          rt.host.emit('session/event', { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } });
        }
      }
      const stamp = Date.now();
      const before = modelFrom(rt, stamp);
      rt.close();

      rt = openRuntime(dbPath);
      const after = modelFrom(rt, stamp);
      assert.deepEqual(
        after.items.map((i) => `${i.id}|${i.disposition}`),
        before.items.map((i) => `${i.id}|${i.disposition}`),
        'replaying the same rows after a restart yields the same surface',
      );
      assert.deepEqual(after.map, before.map);
      checkInvariants(rt, 'replay', []);
    } finally {
      rt.close();
    }
  },
);
