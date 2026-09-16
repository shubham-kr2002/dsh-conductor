/**
 * Phase-10 — sqlite write contention on a shared FILE database.
 *
 * #9   two (then four) runtimes hammering the same conductor.sqlite through an
 *      interleaved async loop: `busy_timeout` must absorb everything, no
 *      SQLITE_BUSY may surface, and the final row counts must be exact — no
 *      lost rows, no duplicated rows.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  T,
  cleanTmpDirs,
  gateCommand,
  openRuntime,
  rowsFor,
  runWorkerOps,
  startAgent,
  statusOf,
  tick,
  tmpDir,
} from './helpers.js';
import type { WorkerOp } from './helpers.js';

after(() => cleanTmpDirs());

const LOCKY = /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i;

test(
  '#9a two runtimes interleave 50 events + 20 resolves on one file with zero surfaced locks',
  { timeout: T.timeout },
  async () => {
    const dbPath = join(tmpDir('s9a'), 'conductor.sqlite');
    const A = openRuntime(dbPath);
    const B = openRuntime(dbPath);
    try {
      // The configuration the assertion depends on, read back from the file.
      assert.equal(
        (A.db.raw.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout,
        5_000,
        'busy_timeout is configured',
      );
      assert.equal(
        (A.db.raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'wal',
        'WAL, so readers never block the writer',
      );

      const ea = startAgent(A, 'hammer-a', 'alpha slice').id;
      const eb = startAgent(B, 'hammer-b', 'beta slice').id;
      const failures: string[] = [];

      // 50 processEvents (25 per runtime) + 20 resolves (10 per runtime),
      // interleaved at the event loop, not batched.
      for (let round = 0; round < 25; round++) {
        try {
          gateCommand(A, ea, `a-${String(round)}`, round % 2 ? `pnpm add alpha-${String(round)}` : `helm uninstall alpha-${String(round)}`);
        } catch (err) {
          failures.push(`A.event ${String(err)}`);
        }
        await tick();
        try {
          gateCommand(B, eb, `b-${String(round)}`, round % 2 ? `pnpm add beta-${String(round)}` : `kubectl delete ns beta-${String(round)}`);
        } catch (err) {
          failures.push(`B.event ${String(err)}`);
        }
        await tick();
      }

      const pendA = A.decisions.pending(ea);
      const pendB = B.decisions.pending(eb);
      assert.equal(pendA.length, 25);
      assert.equal(pendB.length, 25);
      for (let i = 0; i < 10; i++) {
        try {
          A.decisions.resolve(pendA[i]!.id, i % 2 ? 'rejected' : 'accepted');
        } catch (err) {
          failures.push(`A.resolve ${String(err)}`);
        }
        await tick();
        try {
          B.decisions.resolve(pendB[i]!.id, i % 2 ? 'accepted' : 'rejected');
        } catch (err) {
          failures.push(`B.resolve ${String(err)}`);
        }
        await tick();
      }

      assert.deepEqual(failures, [], 'no write ever surfaced a lock error');
      assert.ok(!failures.some((f) => LOCKY.test(f)), 'and specifically not SQLITE_BUSY');

      // Exact persisted counts: one decision per gated call, two event rows
      // per call plus the execution.started row.
      const rowsA = rowsFor(A, ea);
      const rowsB = rowsFor(B, eb);
      assert.equal(rowsA.length, 25, 'no lost or duplicated decisions on A');
      assert.equal(rowsB.length, 25, 'no lost or duplicated decisions on B');
      assert.equal(new Set([...rowsA, ...rowsB].map((d) => d.id)).size, 50, 'ids unique across both');
      assert.equal(A.eventRepo.countByExecution(ea), 1 + 25 * 2, 'every observation landed');
      assert.equal(B.eventRepo.countByExecution(eb), 1 + 25 * 2);
      assert.equal(A.decisionRepo.list({}).length, 50, 'no cross-execution bleed');

      // Both connections agree on the shared totals, and aggregates are exact.
      assert.equal(B.decisionRepo.list({ executionId: ea }).length, 25);
      assert.equal(A.decisionRepo.list({ executionId: eb }).length, 25);
      for (const [rt, id, expected] of [
        [A, ea, 25],
        [B, eb, 25],
      ] as const) {
        const exec = rt.execRepo.findById(id)!;
        assert.equal(exec.metrics.decisionCount, expected, 'decisionCount == rows');
        assert.equal(exec.decisions.length, expected, 'references == rows');
        assert.equal(new Set(exec.decisions).size, expected, 'no duplicated reference');
        assert.equal(rt.decisions.pending(id).length, 15, 'ten were resolved per runtime');
      }
      assert.equal(statusOf(A, ea), 'PAUSED');
      assert.equal(statusOf(B, eb), 'PAUSED');
    } finally {
      A.close();
      B.close();
    }
  },
);

test(
  '#9b four writers (two threads + two in-process runtimes) hammer one file: exact totals, no locks',
  // Cross-thread writers can legitimately BLOCK inside busy_timeout (5 s per
  // contended write), so this one gets a longer, still-real budget.
  { timeout: 30_000 },
  async () => {
    const dbPath = join(tmpDir('s9b'), 'conductor.sqlite');
    const A = openRuntime(dbPath);
    const B = openRuntime(dbPath);
    try {
      const ea = startAgent(A, 'quad-a').id;
      const eb = startAgent(B, 'quad-b').id;
      const e1 = startAgent(A, 'thread-1').id; // ids reserved for the threads
      const e2 = startAgent(B, 'thread-2').id;

      const G = 12; // gates per writer — four concurrent writers
      const threadOps = (execId: string, tag: string, gates: number): WorkerOp[] => {
        const ops: WorkerOp[] = [];
        for (let i = 0; i < gates; i++) {
          ops.push({ kind: 'gate', execId, callId: `${tag}-${String(i)}`, command: `pnpm add ${tag}-${String(i)}` });
          if (i % 5 === 4) ops.push({ kind: 'yield', ms: 1 });
        }
        return ops;
      };

      // Four concurrent writers at once: two threads, two in-process runtimes.
      const inA = (async (): Promise<void> => {
        for (let i = 0; i < G; i++) {
          gateCommand(A, ea, `a-${String(i)}`, `pnpm add a-${String(i)}`);
          if (i % 2 === 1) await tick();
        }
      })();
      const inB = (async (): Promise<void> => {
        for (let i = 0; i < G; i++) {
          gateCommand(B, eb, `b-${String(i)}`, `pnpm add b-${String(i)}`);
          if (i % 2 === 1) await tick();
        }
      })();
      const [w1, w2] = await Promise.all([
        runWorkerOps(dbPath, threadOps(e1, 't1', G)),
        runWorkerOps(dbPath, threadOps(e2, 't2', G)),
        inA,
        inB,
      ] as const);

      assert.ok(!/SQLITE_BUSY|SQLITE_LOCKED|locked/i.test(w1.error ?? ''), 'no lock error in thread 1');
      assert.ok(!/SQLITE_BUSY|SQLITE_LOCKED|locked/i.test(w2.error ?? ''), 'no lock error in thread 2');

      const ids = [ea, eb, e1, e2];
      const rows = A.decisionRepo.list({});
      assert.equal(rows.length, 4 * G, `${String(4 * G)} gated calls → exactly ${String(4 * G)} decisions`);
      for (const id of ids) {
        const exec = A.execRepo.findById(id)!;
        assert.equal(rowsFor(A, id).length, G, `${String(G)} decisions for ${id}`);
        assert.equal(exec.decisions.length, G, 'references complete');
        assert.equal(exec.metrics.decisionCount, G, 'count complete');
        assert.equal(A.eventRepo.countByExecution(id), 1 + G * 2, 'events complete');
        assert.equal(new Set(exec.decisions).size, G);
      }
      assert.equal(new Set(rows.map((r) => r.id)).size, 4 * G, 'no duplicated decision ids');
      assert.equal(
        new Set(rows.map((r) => r.dedupeKey)).size,
        4 * G,
        'no duplicated dedupeKeys — every call is represented once',
      );
    } finally {
      A.close();
      B.close();
    }
  },
);

test(
  '#9c racing resolvers with opposite intents still leave exactly one coherent verdict per decision',
  { timeout: T.timeout },
  async () => {
    const dbPath = join(tmpDir('s9c'), 'conductor.sqlite');
    const A = openRuntime(dbPath);
    const B = openRuntime(dbPath);
    try {
      const ea = startAgent(A, 'contended-a').id;
      const eb = startAgent(B, 'contended-b').id;
      for (let i = 0; i < 6; i++) {
        gateCommand(A, ea, `ca-${String(i)}`, `pnpm add one-${String(i)}`);
        gateCommand(B, eb, `cb-${String(i)}`, `pnpm add two-${String(i)}`);
      }
      const shared = rowsFor(A, ea).map((d) => d.id);
      const other = rowsFor(B, eb).map((d) => d.id);

      // Two threads race to resolve the SAME twelve rows with OPPOSITE
      // intents. Which verdict wins per row is genuinely a race — what must
      // hold is that every row ends up with exactly one coherent verdict, no
      // row is lost, and no row is left half-resolved.
      const [w1, w2] = await Promise.all([
        runWorkerOps(dbPath, [
          ...shared.map((id): WorkerOp => ({ kind: 'resolve', id, outcome: 'accepted' })),
          ...other.map((id): WorkerOp => ({ kind: 'resolve', id, outcome: 'accepted' })),
        ]),
        runWorkerOps(dbPath, [
          ...other.map((id): WorkerOp => ({ kind: 'resolve', id, outcome: 'rejected' })),
          ...shared.map((id): WorkerOp => ({ kind: 'resolve', id, outcome: 'rejected' })),
        ]),
      ]);
      assert.ok(w1.ok && w2.ok, `threads failed: ${String(w1.error)} ${String(w2.error)}`);

      const all = A.decisionRepo.list({});
      assert.equal(all.length, 12, 'still exactly twelve rows — nothing lost, nothing duplicated');
      assert.equal(A.decisions.pending().length, 0, 'every judgment was answered');
      const accepted = all.filter((d) => d.status === 'accepted').length;
      const rejected = all.filter((d) => d.status === 'rejected').length;
      assert.equal(accepted + rejected, 12, 'a row holds ONE verdict');
      for (const d of all) {
        assert.ok(d.resolution, `${d.id} resolved carries a resolution`);
        assert.equal(d.resolution!.status, d.status, 'resolution agrees with the row status');
      }
      // Both runs are off the hook (the resume is idempotent from either side).
      assert.ok(['RUNNING', 'PAUSED'].includes(statusOf(A, ea) ?? ''), 'state is coherent');
      assert.ok(['RUNNING', 'PAUSED'].includes(statusOf(B, eb) ?? ''));
      assert.equal(A.decisionRepo.list({ executionId: ea }).length, 6);
      assert.equal(B.decisionRepo.list({ executionId: eb }).length, 6);
    } finally {
      A.close();
      B.close();
    }
  },
);
