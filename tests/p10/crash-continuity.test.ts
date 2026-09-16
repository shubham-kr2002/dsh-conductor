/**
 * Phase-10 — crash / restart continuity.
 *
 * #8   a run paused before the process dies must be resumable by a FRESH
 *      runtime over the same file: the pending judgment survives, the bridge
 *      re-binds, the approval token works exactly once, aggregates agree with
 *      the rows, and held time keeps accruing from the durable transitions.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { computeAttentionMetrics } from '../../src/summary/attention-metrics.js';
import {
  T,
  claimKind,
  cleanTmpDirs,
  crashPauseChild,
  dispatchTool,
  modelFrom,
  openRuntime,
  gateCommand,
  rowsFor,
  startAgent,
  statusOf,
  subjectOf,
  tmpDir,
} from './helpers.js';

after(() => cleanTmpDirs());

test(
  '#8a restart: a pending judgment survives the db being closed and reopened',
  { timeout: T.timeout },
  () => {
    const dir = tmpDir('s8a');
    const dbPath = join(dir, 'conductor.sqlite');
    const command = 'helm uninstall checkout-service';
    const subject = subjectOf(command);

    // ---- process 1: gate a dangerous action, then die (clean close)
    const first = openRuntime(dbPath);
    let execId = '';
    let decisionId = '';
    try {
      const exec = startAgent(first, 'phoenix', 'keep checkout running');
      execId = exec.id;
      assert.equal(claimKind(dispatchTool(first, 'phoenix', 'k-1', command)), 'deny');
      assert.equal(statusOf(first, execId), 'PAUSED');
      const rows = rowsFor(first, execId);
      assert.equal(rows.length, 1);
      decisionId = rows[0]!.id;
      // A second, unrelated OBSERVATION (session-log path: the bridge itself
      // refuses without re-observing while the run is held) so the restart has
      // more than one thing to recover.
      gateCommand(first, execId, 'k-2', 'pnpm add zod');
      assert.equal(rowsFor(first, execId).length, 2, 'a held run still queues what it sees');
    } finally {
      first.close();
    }

    // ---- process 2: entirely fresh manager / queue / delegation service
    const second = openRuntime(dbPath);
    try {
      assert.equal(statusOf(second, execId), 'PAUSED', 'the hold is durable, not in-memory');
      const pending = second.decisions.pending(execId);
      assert.equal(pending.length, 2, 'decisions.pending() intact after restart');
      assert.deepEqual(
        pending.map((d) => d.id).sort(),
        rowsFor(second, execId).filter((d) => d.status === 'pending').map((d) => d.id).sort(),
      );
      const carried = pending.find((d) => d.id === decisionId)!;
      assert.equal(carried.subject, subject, 'subject survived the round trip');
      assert.equal(carried.dedupeKey, `${execId}:k-1`);
      assert.ok(carried.why, 'the explanation survived too');

      // The bridge is bound fresh: same host key, new process, same truth.
      // (A bridge that has never seen the execution treats the agent as
      // unmanaged and hands off entirely — that is the re-bind step.)
      assert.equal(
        second.bridge.executionFor({ agentId: 'phoenix' }),
        undefined,
        'a fresh bridge knows nothing until it is re-bound',
      );
      second.bridge.bindHostKey('agent:phoenix', execId);
      assert.equal(claimKind(dispatchTool(second, 'phoenix', 'k-3', 'helm upgrade api')), 'deny');
      assert.equal(
        second.bridge.executionFor({ agentId: 'phoenix' })?.id,
        execId,
        'host key re-bound to the same execution',
      );

      // Human approves. The token must be spendable ONCE from this new process.
      second.decisions.resolve(decisionId, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(statusOf(second, execId), 'PAUSED', 'the other judgment still holds it');
      assert.equal(second.decisions.consumeApproval(execId, subject), true, 'token works in process 2');
      assert.equal(second.decisions.consumeApproval(execId, subject), false, '…exactly once');
      assert.ok(second.decisionRepo.findById(decisionId)!.consumedAt != null);

      // Aggregate consistency after the restart (no lost decision references).
      const reloaded = second.execRepo.findById(execId)!;
      const rows = rowsFor(second, execId);
      assert.equal(reloaded.decisions.length, rows.length, 'state.decisions == rows');
      assert.equal(reloaded.metrics.decisionCount, rows.length, 'decisionCount == rows');
      assert.deepEqual(
        [...reloaded.decisions].sort(),
        rows.map((d) => d.id).sort(),
        'the same ids, no duplicates',
      );

      // Metrics are read off the durable transition log: nothing resets, and
      // held time keeps growing with `now` while the run is still held.
      // One captured instant, so the accrual delta is exact rather than
      // "two Date.now() calls that happened to straddle a millisecond".
      const now = Date.now();
      const held = computeAttentionMetrics(reloaded, rows, { now });
      const later = computeAttentionMetrics(reloaded, rows, { now: now + 45_000 });
      assert.equal(held.heldMs + held.humanControlMs + held.autonomousMs, held.totalMs);
      assert.ok(held.heldMs > 0, 'the restart still knows it was held');
      assert.equal(later.heldMs - held.heldMs, 45_000, 'heldMs accrues from durable transitions');
      assert.equal(later.decisionsCreated, rows.length);
      assert.equal(later.takeovers, 0);

      // Model rebuilt from the reopened db still surfaces the run.
      const model = modelFrom(second, now);
      assert.ok(
        model.items.some((i) => i.executionId === execId),
        'the restarted run is still on the attention surface',
      );
    } finally {
      second.close();
    }
  },
);

test(
  '#8b abrupt process death (no close, WAL left behind) loses neither the hold nor the judgment',
  { timeout: T.timeout },
  async () => {
    const dir = tmpDir('s8b');
    const dbPath = join(dir, 'conductor.sqlite');
    const ws = join(dir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'README.md'), 'hello\n');
    const command = 'helm uninstall doomed-service';
    const subject = subjectOf(command);

    const observed = await crashPauseChild(dbPath, {
      agentId: 'crashy',
      goal: 'survive a kill',
      command,
      callId: 'crash-1',
      workspaceRoot: ws,
    });
    assert.equal(observed.claim, 'deny', 'the dying process gated the call');
    assert.equal(observed.status, 'PAUSED');
    assert.equal(observed.pending, 1);

    // The crash left WAL files behind; the next process must recover through them.
    const rt = openRuntime(dbPath);
    try {
      assert.equal(rt.db.isOpen(), true);
      assert.equal(statusOf(rt, observed.execId), 'PAUSED', 'the hold survived the crash');
      const pending = rt.decisions.pending(observed.execId);
      assert.equal(pending.length, 1, 'the judgment survived the crash');
      assert.equal(pending[0]!.subject, subject);
      assert.equal(pending[0]!.dedupeKey, `${observed.execId}:crash-1`);
      assert.equal(rt.execRepo.findById(observed.execId)!.metrics.decisionCount, 1);

      // A fresh bridge in a fresh process can clear it, and the retry token is
      // good for exactly one pass.
      rt.bridge.bindHostKey('agent:crashy', observed.execId);
      assert.equal(claimKind(dispatchTool(rt, 'crashy', 'crash-2', command)), 'deny', 'still held');
      rt.decisions.resolve(pending[0]!.id, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(statusOf(rt, observed.execId), 'RUNNING');
      assert.equal(claimKind(dispatchTool(rt, 'crashy', 'crash-3', command)), 'allow', 'token from the new process');
      assert.equal(claimKind(dispatchTool(rt, 'crashy', 'crash-4', command)), 'deny', 'spent');
      assert.equal(
        rt.decisions.consumeApproval(observed.execId, subject),
        false,
        'and it cannot be spent again',
      );

      const rows = rowsFor(rt, observed.execId);
      assert.equal(rows.length, 2, 'the redelivered action re-gated once');
      assert.equal(rt.execRepo.findById(observed.execId)!.metrics.decisionCount, rows.length);
      assert.ok(rt.eventRepo.listByExecution(observed.execId, { limit: 500 }).length > 0);
    } finally {
      rt.close();
    }
  },
);

test(
  '#8c reopening does not mint work: the same rows yield the same model and metrics',
  { timeout: T.timeout },
  () => {
    const dir = tmpDir('s8c');
    const dbPath = join(dir, 'conductor.sqlite');
    const a = openRuntime(dbPath);
    try {
      const exec = startAgent(a, 'idem');
      dispatchTool(a, 'idem', 'i-1', 'kubectl delete ns staging');
      dispatchTool(a, 'idem', 'i-2', 'pnpm add zod');
      const now = 1_800_000_000_000;
      const first = modelFrom(a, now);
      const metricsA = computeAttentionMetrics(
        a.execRepo.findById(exec.id)!,
        rowsFor(a, exec.id),
        { now, takeoverCount: 0 },
      );
      a.close();

      const b = openRuntime(dbPath);
      try {
        const second = modelFrom(b, now);
        assert.deepEqual(
          second.items.map((i) => `${i.id}|${i.disposition}|${i.category}`),
          first.items.map((i) => `${i.id}|${i.disposition}|${i.category}`),
          'reopening changes nothing in the attention surface',
        );
        assert.deepEqual(second.map, first.map);
        const metricsB = computeAttentionMetrics(
          b.execRepo.findById(exec.id)!,
          rowsFor(b, exec.id),
          { now, takeoverCount: 0 },
        );
        assert.deepEqual(metricsB, metricsA, 'metrics are a pure function of durable rows');
      } finally {
        b.close();
      }
    } finally {
      cleanTmpDirs();
    }
  },
);
