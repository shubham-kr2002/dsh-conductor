/**
 * Phase-10 — concurrent resolution races.
 *
 * #2   two independent DecisionQueue instances (two connections, one FILE db)
 *      resolving the SAME decision id: first verdict wins, the second is a
 *      no-op, and the retry token is handed out exactly once.
 * #2b  the same "exactly one token" guarantee under REAL simultaneity
 *      (separate threads ⇒ separate sqlite connections ⇒ separate OS processes
 *      from sqlite's point of view).
 * #10  stale-surface safety: a second connection reading mid-resolve never sees
 *      a half-resolved decision.
 * #12  adversarial resolve inputs (custom/'deny', accepted/'deny', verdict order).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  T,
  cleanTmpDirs,
  dispatchTool,
  gateCommand,
  openRuntime,
  rowsFor,
  runWorkerOps,
  startAgent,
  statusOf,
  subjectOf,
  tick,
  tmpDir,
} from './helpers.js';

after(() => cleanTmpDirs());

interface RawRow {
  id: string;
  status: string;
  resolution_json: string | null;
  consumed_at: number | null;
}

/** A row is "half-resolved" if its verdict columns disagree with each other. */
function violation(row: RawRow): string | null {
  const { status, resolution_json: res, consumed_at: consumed } = row;
  if (status === 'pending') {
    if (res !== null) return `${row.id}: pending row carries a resolution`;
    if (consumed !== null) return `${row.id}: pending row marked as consumed`;
    return null;
  }
  if (status === 'cancelled' || status === 'expired') return null;
  if (res === null) return `${row.id}: status ${status} with no resolution payload`;
  let parsed: { status?: string };
  try {
    parsed = JSON.parse(res) as { status?: string };
  } catch {
    return `${row.id}: unparseable resolution_json`;
  }
  if (parsed.status !== status) {
    return `${row.id}: resolution.status ${String(parsed.status)} != row status ${status}`;
  }
  return null;
}

test(
  '#2 two queues on one file: the second verdict is a no-op and the retry token is minted once',
  { timeout: T.timeout },
  async () => {
    const dbPath = join(tmpDir('s2'), 'conductor.sqlite');
    const A = openRuntime(dbPath);
    const B = openRuntime(dbPath);
    try {
      const exec = startAgent(A, 'twin');
      const command = 'helm uninstall legacy';
      dispatchTool(A, 'twin', 't1', command);
      assert.equal(statusOf(A, exec.id), 'PAUSED');
      const id = rowsFor(A, exec.id)[0]!.id;
      const subject = subjectOf(command);

      // B is a completely separate runtime (own connection, own queue, own
      // manager) that simply happens to look at the same file.
      assert.equal(B.decisionRepo.findById(id)!.status, 'pending', 'B sees it pending');

      const first = await A.decisions.resolve(id, 'accepted', {
        selectedOptionId: 'approve-once',
        answerBy: 'dev-one',
      });
      await tick();
      const second = await B.decisions.resolve(id, 'custom', {
        selectedOptionId: 'approve-once',
        answerBy: 'dev-two',
      });

      assert.equal(first.status, 'accepted');
      assert.equal(second.status, 'accepted', 'the loser gets the winner\'s decision back');
      assert.equal(second.resolution?.resolvedBy, 'dev-one', 'the loser wrote nothing');
      assert.equal(B.decisionRepo.findById(id)!.status, 'accepted', 'persisted = first verdict');
      assert.equal(
        B.decisionRepo.findById(id)!.resolution?.customValue,
        undefined,
        'the rejected late verdict left no trace',
      );

      // Exactly one retry token across BOTH queues.
      const tokens = [
        A.decisions.consumeApproval(exec.id, subject),
        B.decisions.consumeApproval(exec.id, subject),
        A.decisions.consumeApproval(exec.id, subject),
        B.decisions.consumeApproval(exec.id, subject),
      ];
      assert.equal(
        tokens.filter((t) => t).length,
        1,
        `exactly one true, got ${JSON.stringify(tokens)}`,
      );

      // …and the run actually resumed (both queues agree on the same truth).
      assert.equal(statusOf(A, exec.id), 'RUNNING');
      assert.equal(statusOf(B, exec.id), 'RUNNING');
    } finally {
      A.close();
      B.close();
    }
  },
);

test(
  '#2b the reverse ordering also holds: whichever verdict lands first is the durable one',
  { timeout: T.timeout },
  async () => {
    const dbPath = join(tmpDir('s2rev'), 'conductor.sqlite');
    const A = openRuntime(dbPath);
    const B = openRuntime(dbPath);
    try {
      const exec = startAgent(A, 'twin');
      const command = 'helm uninstall legacy';
      dispatchTool(A, 'twin', 't1', command);
      const id = rowsFor(A, exec.id)[0]!.id;

      const winner = await B.decisions.resolve(id, 'custom', {
        selectedOptionId: 'approve-once',
        customValue: 'ship it once only',
        answerBy: 'dev-two',
      });
      await tick();
      const loser = await A.decisions.resolve(id, 'accepted', { answerBy: 'dev-one' });

      assert.equal(winner.status, 'custom');
      assert.equal(loser.status, 'custom', 'the late A-verdict lost silently');
      const row = B.decisionRepo.findById(id)!;
      assert.equal(row.status, 'custom');
      assert.equal(row.resolution?.resolvedBy, 'dev-two');
      assert.equal(row.resolution?.customValue, 'ship it once only');
      assert.equal(
        A.decisions.consumeApproval(exec.id, subjectOf(command)),
        true,
        'custom + approve-once mints the token exactly once',
      );
      assert.equal(A.decisions.consumeApproval(exec.id, subjectOf(command)), false);
      assert.equal(B.decisions.consumeApproval(exec.id, subjectOf(command)), false);
    } finally {
      A.close();
      B.close();
    }
  },
);

test(
  '#2b2 true simultaneity: four threads race for ONE approval token, exactly one wins',
  { timeout: T.timeout },
  async () => {
    const dbPath = join(tmpDir('s2race'), 'conductor.sqlite');
    const rt = openRuntime(dbPath);
    try {
      const exec = startAgent(rt, 'racer');
      const command = 'helm uninstall legacy';
      dispatchTool(rt, 'racer', 'r1', command);
      const id = rowsFor(rt, exec.id)[0]!.id;
      const subject = subjectOf(command);
      rt.decisions.resolve(id, 'accepted', { selectedOptionId: 'approve-once' });

      // Release all four threads at the same instant.
      const ops = (n: number) => [
        { kind: 'yield' as const, ms: 30 * n },
        { kind: 'token' as const, execId: exec.id, subject },
        { kind: 'token' as const, execId: exec.id, subject },
      ];
      const reports = await Promise.all([0, 1, 2, 3].map((n) => runWorkerOps(dbPath, ops(n))));
      const perWorker = reports.map((r) => r.results.filter((x) => x.token === true).length);
      assert.equal(
        perWorker.reduce((a, b) => a + b, 0),
        1,
        `exactly one thread may obtain the token, got ${JSON.stringify(perWorker)}`,
      );
      for (const r of reports) assert.ok(r.ok, `worker failed: ${r.error ?? ''}`);
      assert.equal(
        rt.decisions.consumeApproval(exec.id, subject),
        false,
        'the token is gone for the parent too',
      );
      const row = rt.decisionRepo.findById(id)!;
      assert.ok(row.consumedAt != null, 'the consumption is stamped durably');
      assert.equal(rt.decisionRepo.list({}).filter((d) => d.consumedAt != null).length, 1);
    } finally {
      rt.close();
    }
  },
);

test(
  '#2c REAL simultaneity: two processes that both start from a pending row must still mint only one token',
  {
    // The lost-update hazard that made this a `todo` is fixed in P10: the
    // decision upsert is guarded (status/resolution frozen once settled,
    // consumed_at never rewound by a stale save), so racing resolvers can
    // never mint two retry tokens from one approval.
    timeout: T.timeout,
  },
  async () => {
    const dbPath = join(tmpDir('s2c'), 'conductor.sqlite');
    const rt = openRuntime(dbPath);
    try {
      const exec = startAgent(rt, 'clobber');
      const command = 'helm uninstall legacy';
      dispatchTool(rt, 'clobber', 'k1', command);
      const id = rowsFor(rt, exec.id)[0]!.id;
      const subject = subjectOf(command);

      // Two independent resolver processes. Each loads the row (still pending),
      // pauses, then resolves + retries.
      const racer = (outcome: 'accepted' | 'custom', optionId?: string) => [
        { kind: 'peek' as const, id },
        { kind: 'yield' as const, ms: 40 },
        { kind: 'resolve' as const, id, outcome, ...(optionId ? { optionId } : {}) },
        { kind: 'token' as const, execId: exec.id, subject },
      ];
      const [a, b] = await Promise.all([
        runWorkerOps(dbPath, racer('accepted')),
        runWorkerOps(dbPath, racer('custom', 'approve-once')),
      ]);
      const readA = a.results[0]?.status;
      const readB = b.results[0]?.status;
      assert.equal(readA, 'pending', 'both racers started from a pending row');
      assert.equal(readB, 'pending', 'both racers started from a pending row');

      const tokens =
        (a.results[3]?.token === true ? 1 : 0) + (b.results[3]?.token === true ? 1 : 0);
      assert.equal(
        tokens,
        1,
        `exactly one retry token for one approval — got ${String(tokens)} (a=${String(
          a.results[3]?.token,
        )} b=${String(b.results[3]?.token)})`,
      );
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false, 'and nothing left to leak');
    } finally {
      rt.close();
    }
  },
);

test(
  '#2d the same lost update, reproduced deterministically at the storage boundary',
  { timeout: T.timeout },
  async () => {
    const dbPath = join(tmpDir('s2d'), 'conductor.sqlite');
    const winner = openRuntime(dbPath);
    const racer = openRuntime(dbPath);
    try {
      const exec = startAgent(winner, 'clobber2');
      const command = 'helm uninstall legacy';
      dispatchTool(winner, 'clobber2', 'k2', command);
      const id = rowsFor(winner, exec.id)[0]!.id;
      const subject = subjectOf(command);

      // What a second resolver process holds in memory before it writes.
      const staleCopy = racer.decisionRepo.findById(id)!;
      assert.equal(staleCopy.status, 'pending');
      assert.equal(staleCopy.consumedAt, undefined);

      winner.decisions.resolve(id, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(winner.decisions.consumeApproval(exec.id, subject), true, 'token spent');
      assert.ok(winner.decisionRepo.findById(id)!.consumedAt != null, 'stamped durably');

      // The racing write lands: same row, built from the pre-spend snapshot.
      racer.decisionRepo.save({
        ...staleCopy,
        status: 'custom',
        resolution: {
          status: 'custom',
          resolvedAt: Date.now(),
          resolvedBy: 'racer',
          selectedOptionId: 'approve-once',
        },
        updatedAt: Date.now(),
      });

      // FIXED (P10): the guarded upsert refuses both hazards — a save built
      // from a stale snapshot can neither rewind a spent token nor replace a
      // settled verdict. `consumed_at` is preserved by COALESCE, and status/
      // resolution are frozen once non-pending by the CASE guard.
      const settled = winner.decisionRepo.findById(id)!;
      assert.notEqual(settled.consumedAt ?? null, null, 'the spent token survives the stale save');
      assert.equal(settled.status, 'accepted', 'the winning verdict is not replaced');
      assert.equal(
        racer.decisions.consumeApproval(exec.id, subject),
        false,
        'exactly one retry token per approval — no second mint',
      );
    } finally {
      racer.close();
      winner.close();
    }
  },
);

test(
  '#10 stale-surface safety: a second connection never observes a half-resolved decision',
  { timeout: T.timeout },
  async () => {
    const dbPath = join(tmpDir('s10'), 'conductor.sqlite');
    const rt = openRuntime(dbPath);
    const poller = openRuntime(dbPath); // the "stale surface": another connection
    try {
      const exec = startAgent(rt, 'reader');
      for (let i = 0; i < 24; i++) {
        gateCommand(rt, exec.id, `c-${String(i)}`, `pnpm add pkg-${String(i)}`);
      }
      const ids = rowsFor(rt, exec.id).map((d) => d.id);
      assert.equal(ids.length, 24);
      assert.equal(statusOf(rt, exec.id), 'PAUSED');

      // One thread drains the queue; the poller reads the same rows throughout.
      const resolverOps = ids.flatMap((id, i) => [
        ...(i % 3 === 0 ? [{ kind: 'yield' as const, ms: 2 }] : []),
        {
          kind: 'resolve' as const,
          id,
          outcome: i % 5 === 0 ? ('rejected' as const) : ('accepted' as const),
        },
      ]);
      const worker = runWorkerOps(dbPath, resolverOps);
      let settled = false;
      void worker.then(() => {
        settled = true;
      });

      let observations = 0;
      const violations: string[] = [];
      const execStates = new Set<string>();
      for (let pass = 0; pass < 400 && !settled; pass++) {
        const rows = poller.db.raw
          .prepare('SELECT id, status, resolution_json, consumed_at FROM decisions WHERE execution_id = ?')
          .all(exec.id) as unknown as RawRow[];
        observations += rows.length;
        for (const row of rows) {
          const v = violation(row);
          if (v) violations.push(v);
        }
        const state = poller.execRepo.findById(exec.id)!;
        execStates.add(state.status);
        const pending = rows.filter((r) => r.status === 'pending').length;
        // The one thing a UI may never show: a live run with an unanswered
        // judgment still on the board.
        if (pending > 0) assert.equal(state.status, 'PAUSED', `${state.status} with ${String(pending)} pending`);
        else assert.ok(state.status === 'PAUSED' || state.status === 'RUNNING');
        await tick();
      }

      const report = await worker;
      assert.ok(report.ok, `resolver thread failed: ${report.error ?? ''}`);
      assert.deepEqual(violations, [], 'no half-resolved row was ever observable');
      assert.ok(observations >= 24, `poller observed ${String(observations)} row-states`);

      // Final durable truth: every row consistent, nothing pending, run resumed.
      const final = poller.db.raw
        .prepare('SELECT id, status, resolution_json, consumed_at FROM decisions WHERE execution_id = ?')
        .all(exec.id) as unknown as RawRow[];
      assert.equal(final.length, 24);
      assert.equal(final.filter((r) => r.status === 'pending').length, 0);
      for (const row of final) assert.equal(violation(row), null);
      assert.equal(statusOf(rt, exec.id), 'RUNNING');
      assert.equal(statusOf(poller, exec.id), 'RUNNING', 'the stale connection agrees once settled');
      assert.equal(rt.execRepo.findById(exec.id)!.metrics.decisionCount, 24);
      assert.ok(execStates.has('PAUSED'), 'the poller really watched a held run');
    } finally {
      poller.close();
      rt.close();
    }
  },
);

test(
  '#12 adversarial resolve inputs never mint a retry token',
  { timeout: T.timeout },
  async () => {
    const rt = openRuntime(join(tmpDir('s12'), 'conductor.sqlite'));
    try {
      const exec = startAgent(rt, 'nasty');
      const command = 'kubectl delete ns staging';
      const subject = subjectOf(command);
      const mk = (callId: string): string => {
        gateCommand(rt, exec.id, callId, command);
        const pending = rt.decisions.pending(exec.id).find((d) => d.subject === subject);
        assert.ok(pending, 'each gated call leaves a pending judgment');
        if (statusOf(rt, exec.id) !== 'PAUSED') assert.fail('expected the gate to hold the run');
        return pending!.id;
      };

      // (a) custom resolution that picks the DENY option: no token.
      const a = mk('n1');
      rt.decisions.resolve(a, 'custom', { selectedOptionId: 'deny', customValue: 'no.' });
      assert.equal(rt.decisionRepo.findById(a)!.status, 'custom');
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false, 'deny is not approval');

      // (b) the "accepted" VERB with the deny option attached: the option wins.
      const b = mk('n2');
      rt.decisions.resolve(b, 'accepted', { selectedOptionId: 'deny' });
      assert.equal(rt.decisionRepo.findById(b)!.status, 'accepted');
      assert.equal(
        rt.decisions.consumeApproval(exec.id, subject),
        false,
        'selectedOptionId beats the verb — no silent allow',
      );

      // (c) an unknown option id throws instead of quietly approving.
      const c = mk('n3');
      assert.throws(
        () => rt.decisions.resolve(c, 'accepted', { selectedOptionId: 'yolo' }),
        /does not exist/,
        'a made-up option id cannot mint a token',
      );
      assert.equal(rt.decisionRepo.findById(c)!.status, 'pending', 'and the row is untouched');
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false);

      // (d) custom with neither value nor option: rejected up front.
      assert.throws(
        () => rt.decisions.resolve(c, 'custom', {}),
        /requires/,
        'an empty custom resolution is refused',
      );

      // (e) proper approve-once still works after all that noise.
      rt.decisions.resolve(c, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), true, 'exactly one pass');
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false, 'then nothing leaks');

      // (f) latest-verdict rule for delegation shadowing, on the SAME subject.
      // Timestamps must sit AFTER the real resolutions above (Date.now()-based),
      // otherwise the latest-verdict rule legitimately ignores them.
      const base = Date.now();
      const forged = (id: string, status: 'accepted' | 'rejected', resolvedAt: number): void => {
        const row = rt.decisionRepo.findById(c)!;
        rt.decisionRepo.save({
          ...row,
          id,
          status,
          resolution: { status, resolvedAt, resolvedBy: 'dev' },
          updatedAt: resolvedAt,
        });
      };
      const grant = rt.delegations.grant(
        { scope: 'workspace', category: 'deployment', grantedBy: 'dev' },
        base,
      );
      const isCovered = (): boolean =>
        rt.delegations.covers({
          executionId: exec.id,
          category: 'deployment',
          resource: command,
          subject,
          now: base + 10_000,
        }) !== null;

      forged('dec-late-accept', 'rejected', base + 100);
      forged('dec-late-accept-2', 'accepted', base + 200);
      assert.equal(isCovered(), true, 'acceptance is the latest verdict → delegation stands');

      forged('dec-late-reject', 'rejected', base + 300);
      assert.equal(isCovered(), false, 'a NEWER explicit denial shadows the delegation');

      // The denial shadow must not outlive the grant it disagrees with.
      rt.delegations.grant({ scope: 'workspace', category: 'deployment', grantedBy: 'dev' }, base + 400);
      assert.equal(
        isCovered(),
        true,
        'a fresh grant after the denial is authority again (nothing is shadowed forever)',
      );
      // …and only for executions the delegation applies to (workspace scope).
      assert.ok(grant.id);
      rt.delegations.revoke(grant.id, 'dev', base + 500);

      // Housekeeping: the two extra rows we forged are durable history now; the
      // real queue must still refuse to hand out a token for them.
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false);
    } finally {
      rt.close();
    }
  },
);
