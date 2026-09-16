/**
 * Phase-10 — attention-metric reconciliation across a full hostile episode.
 *
 * #13  pause → resolve → human takeover → completion must leave
 *      heldMs + humanControlMs + autonomousMs == totalMs EXACTLY, ratio in
 *      [0,1], interruptions == decisions + takeovers, and the numbers must be
 *      reproducible from the reopened file.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { computeAttentionMetrics } from '../../src/summary/attention-metrics.js';
import { TakeoverService } from '../../src/takeover/takeover-service.js';
import {
  T,
  claimKind,
  cleanTmpDirs,
  dispatchTool,
  fireTurnEnd,
  openRuntime,
  rowsFor,
  startAgent,
  statusOf,
  tmpDir,
} from './helpers.js';

after(() => cleanTmpDirs());

test(
  '#13 pause → resolve → takeover → completion: the occupancy identity closes exactly',
  { timeout: T.timeout },
  () => {
    const dir = tmpDir('s13');
    const dbPath = join(dir, 'conductor.sqlite');
    const ws = join(dir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'src.ts'), 'export const a = 1;\n');

    const rt = openRuntime(dbPath);
    try {
      const exec = startAgent(rt, 'metronome', 'reconcile the billing job', ws);

      // 1. a gate holds the run for human judgment
      assert.equal(claimKind(dispatchTool(rt, 'metronome', 'm-1', 'helm uninstall billing-prod')), 'deny');
      assert.equal(statusOf(rt, exec.id), 'PAUSED');
      const gate = rowsFor(rt, exec.id)[0]!;

      // 2. the human answers it (attention spent)
      rt.decisions.resolve(gate.id, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(statusOf(rt, exec.id), 'RUNNING');

      // 3. the human takes the keyboard over.
      //    (git is optional here: the snapshot code probes `rev-parse` and
      //    falls back to a plain filesystem scan when the workspace is not a
      //    repository — exactly what this temp dir is — so no skip is needed.)
      const taken = rt.takeover.takeOver(exec.id, { actor: 'dev', notes: 'fixing the migration by hand' });
      assert.equal(taken.execution.status, 'TAKEN_OVER');
      assert.equal(typeof taken.record!.snapshot.isGitRepo, 'boolean');
      assert.ok(taken.record!.snapshot.files.some((f) => f.path === 'src.ts'), 'workspace scanned');
      writeFileSync(join(ws, 'hotfix.ts'), 'export const hotfix = true;\n');

      // 4. control returns to the agent, then the turn ends.
      const back = rt.takeover.continue(exec.id, { actor: 'dev' });
      assert.equal(back.execution.status, 'RUNNING');
      assert.ok(
        back.modifications.created.includes('hotfix.ts'),
        `human edits were reconciled: ${JSON.stringify(back.modifications)}`,
      );
      fireTurnEnd(rt);
      assert.equal(statusOf(rt, exec.id), 'COMPLETED');

      // --- the reconciliation ---
      const rows = rowsFor(rt, exec.id);
      const takeovers = rt.takeoverRepo.listByExecution(exec.id);
      const m = computeAttentionMetrics(rt.execRepo.findById(exec.id)!, rows, {
        now: Date.now(),
        takeoverCount: takeovers.length,
      });

      assert.equal(m.status, 'COMPLETED');
      assert.equal(
        m.heldMs + m.humanControlMs + m.autonomousMs,
        m.totalMs,
        `occupancy must close: ${JSON.stringify(m)}`,
      );
      assert.ok(m.heldMs > 0, 'the paused stretch was measured');
      assert.ok(m.humanControlMs >= 0, 'the takeover stretch was measured');
      assert.ok(m.autonomousMs >= 0);
      assert.ok(m.attentionRatio >= 0 && m.attentionRatio <= 1, `ratio ${String(m.attentionRatio)}`);
      assert.equal(
        m.attentionRatio,
        (m.heldMs + m.humanControlMs) / m.totalMs,
        'ratio is the held share of the run',
      );
      assert.equal(m.interruptions, m.decisionsCreated + m.takeovers, 'each interruption counted once');
      assert.equal(m.interruptions, rows.length + takeovers.length);
      assert.equal(m.decisionsCreated, 1);
      assert.equal(m.decisionsResolved, 1);
      assert.equal(m.decisionsPending, 0);
      assert.equal(m.takeovers, 1);
      assert.equal(m.endsAt, m.startedAt + m.totalMs, 'endsAt is the terminal transition');

      // Reopening the file reproduces the exact same numbers for the same now.
      const stamp = Date.now() + 120_000;
      const again = computeAttentionMetrics(rt.execRepo.findById(exec.id)!, rows, {
        now: stamp,
        takeoverCount: takeovers.length,
      });
      assert.deepEqual(again, m, 'a finished run is immutable, so metrics repeat');
    } finally {
      rt.close();
    }
  },
);

test(
  '#13b a held run keeps accruing attention after restart; a resolved one stops counting',
  { timeout: T.timeout },
  () => {
    const dbPath = join(tmpDir('s13b'), 'conductor.sqlite');
    const a = openRuntime(dbPath);
    let execId = '';
    let at = 0;
    try {
      const exec = startAgent(a, 'tick');
      execId = exec.id;
      dispatchTool(a, 'tick', 't-1', 'kubectl delete ns playground');
      at = Date.now();
      const m = computeAttentionMetrics(a.execRepo.findById(execId)!, rowsFor(a, execId), { now: at });
      assert.equal(m.status, 'PAUSED');
      assert.equal(m.endsAt, at, 'an unfinished run ends at `now`');
      assert.equal(m.heldMs + m.humanControlMs + m.autonomousMs, m.totalMs);
    } finally {
      a.close();
    }

    const b = openRuntime(dbPath);
    try {
      const rows = rowsFor(b, execId);
      const exec = b.execRepo.findById(execId)!;
      const heldNow = computeAttentionMetrics(exec, rows, { now: at + 30_000 });
      const heldLater = computeAttentionMetrics(exec, rows, { now: at + 90_000 });
      assert.equal(heldLater.heldMs - heldNow.heldMs, 60_000, 'held time accrues with the clock');
      assert.ok(heldLater.attentionRatio > 0.9, 'the human is the bottleneck while it waits');
      assert.equal(heldLater.totalMs - heldNow.totalMs, 60_000);
      assert.equal(heldLater.interruptions, heldNow.interruptions, 'no phantom interruptions');

      b.decisions.resolve(rows[0]!.id, 'rejected');
      assert.equal(statusOf(b, execId), 'RUNNING');
      const closed = computeAttentionMetrics(b.execRepo.findById(execId)!, rowsFor(b, execId), {
        now: at + 120_000,
      });
      const tr = b.execRepo.findById(execId)!.transitions;
      const pauseAt = tr.find((t) => t.to === 'PAUSED')!.timestamp;
      const resumeAt = tr.find((t) => t.from === 'PAUSED')!.timestamp;
      assert.equal(closed.heldMs, resumeAt - pauseAt, 'held time froze at the resume transition');
      assert.ok(closed.attentionRatio < heldLater.attentionRatio, 'the ratio drops once answered');
      assert.equal(closed.heldMs + closed.humanControlMs + closed.autonomousMs, closed.totalMs);
      assert.equal(closed.decisionsPending, 0);
    } finally {
      b.close();
    }
  },
);

test(
  '#13c interruptions cannot be double-counted by a duplicate verdict path',
  { timeout: T.timeout },
  () => {
    const rt = openRuntime(join(tmpDir('s13c'), 'conductor.sqlite'));
    try {
      const exec = startAgent(rt, 'double');
      dispatchTool(rt, 'double', 'x-1', 'docker system prune -a');
      const id = rowsFor(rt, exec.id)[0]!.id;
      const before = computeAttentionMetrics(rt.execRepo.findById(exec.id)!, rowsFor(rt, exec.id), {
        now: Date.now(),
      });
      rt.decisions.resolve(id, 'accepted', { selectedOptionId: 'approve-once' });
      // a second, racing verdict on the same row (the CLI answering twice)
      rt.decisions.resolve(id, 'rejected');
      const after = computeAttentionMetrics(rt.execRepo.findById(exec.id)!, rowsFor(rt, exec.id), {
        now: Date.now(),
      });
      assert.equal(after.decisionsCreated, before.decisionsCreated, 'no extra decision appeared');
      assert.equal(after.interruptions, before.interruptions, 'no extra interruption counted');
      assert.equal(rt.decisionRepo.findById(id)!.status, 'accepted', 'the first verdict stands');
      assert.equal(after.heldMs + after.humanControlMs + after.autonomousMs, after.totalMs);
    } finally {
      rt.close();
    }
  },
);

test(
  '#13d takeover is git-agnostic: with the git runner unavailable the human still gets control',
  { timeout: T.timeout },
  () => {
    const dir = tmpDir('s13d');
    const dbPath = join(dir, 'conductor.sqlite');
    const ws = join(dir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'entry.ts'), 'export const before = 1;\n');

    const rt = openRuntime(dbPath);
    try {
      // A TakeoverService that cannot see git at all — the sandbox-without-git
      // shape. The snapshot must fall back to its bounded filesystem scan
      // rather than refuse the takeover.
      const noGit = (): { ok: boolean; stdout: string } => ({ ok: false, stdout: '' });
      const takeover = new TakeoverService({
        executionRepo: rt.execRepo,
        eventRepo: rt.eventRepo,
        decisionRepo: rt.decisionRepo,
        takeoverRepo: rt.takeoverRepo,
        git: noGit,
      });

      const exec = startAgent(rt, 'nogit', 'keep the release going', ws);
      dispatchTool(rt, 'nogit', 'g-1', 'helm uninstall release-c');
      rt.decisions.resolve(rowsFor(rt, exec.id)[0]!.id, 'rejected');

      const taken = takeover.takeOver(exec.id, { actor: 'dev', notes: 'no git here' });
      assert.equal(taken.execution.status, 'TAKEN_OVER');
      assert.equal(taken.record!.snapshot.isGitRepo, false, 'no repository claimed');
      assert.equal(taken.record!.snapshot.branch, undefined);
      assert.deepEqual(taken.record!.snapshot.gitStatus, [], 'no porcelain noise without git');
      assert.ok(taken.record!.snapshot.files.some((f) => f.path === 'entry.ts'), 'files still scanned');
      assert.ok(taken.brief.length > 0, 'the human still gets a usable brief');

      writeFileSync(join(ws, 'entry.ts'), 'export const before = 2; // hand edit\n');
      const back = takeover.continue(exec.id, { actor: 'dev' });
      assert.equal(back.execution.status, 'RUNNING');
      assert.deepEqual(back.modifications.modified, ['entry.ts'], 'the hand edit was reconciled');
      assert.deepEqual(back.modifications.created, []);

      fireTurnEnd(rt);
      const rows = rowsFor(rt, exec.id);
      const takeovers = rt.takeoverRepo.listByExecution(exec.id);
      const m = computeAttentionMetrics(rt.execRepo.findById(exec.id)!, rows, {
        now: Date.now(),
        takeoverCount: takeovers.length,
      });
      assert.equal(m.heldMs + m.humanControlMs + m.autonomousMs, m.totalMs);
      assert.equal(m.interruptions, rows.length + takeovers.length);
      assert.equal(m.humanControlMs >= 0 && m.humanControlMs <= m.totalMs, true);
      assert.ok(m.attentionRatio >= 0 && m.attentionRatio <= 1);
    } finally {
      rt.close();
    }
  },
);
