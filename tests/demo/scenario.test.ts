/**
 * Part 19 — "A Day In The Life" demo scenario tests.
 *
 * Runs the FULL scripted day against a real SQLite file in a temp dir
 * under tests/.tmp-demo-* and verifies the beats, the invariants the
 * story claims (no decision for a self-healed failure, one-time approval
 * token), and that the return-to-work numbers are honest derivations.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { Execution } from '../../src/domain/execution.js';
import { computeAttentionMetrics } from '../../src/summary/attention-metrics.js';
import { reschedule, runDemoScenario, DEMO_STORY } from '../../src/demo/scenario.js';

describe('Part 19 — A Day In The Life (deterministic demo)', () => {
  // Fixed fictional "now" so the demo is fully deterministic.
  const NOW = 1_763_300_000_000; // a Tuesday, arbitrarily chosen
  const MIN = 60_000;

  function tempDir(): string {
    // tests/.tmp-demo-<random> — inside the repo, per the demo spec.
    return mkdtempSync(join(process.cwd(), 'tests', '.tmp-demo-'));
  }

  test('full 42-minute story produces the honest return-to-work screen', async () => {
    const dir = tempDir();
    try {
      const captured: string[] = [];
      const result = await runDemoScenario({
        workspaceRoot: dir,
        now: NOW,
        log: (line) => captured.push(line),
      });

      // persisted where promised
      assert.equal(result.dbPath, join(dir, '.conductor-demo', 'demo.db'));
      assert.ok(existsSync(result.dbPath), 'sqlite file exists');

      // ── story facts recorded by the run ────────────────────────────
      assert.equal(result.facts.decisionDeltaOnFailure, 0, 'failed test run created no decision');
      assert.ok(
        result.facts.failureAttentionLevels.length > 0 &&
          result.facts.failureAttentionLevels.every((l) => l === 'BACKGROUND'),
        'test failure stayed BACKGROUND (self-heal)',
      );
      assert.equal(result.facts.tokenFirst, true, 'consumeApproval grants the retry once');
      assert.equal(result.facts.tokenSecond, false, 'the same token never grants twice');

      // ── metrics are derived and land in the honest ranges ──────────
      assert.equal(result.totalMs, 42 * MIN, 'fictional day is exactly 42 minutes');
      assert.ok(result.humanMs > 0);
      assert.ok(result.autonomousMs > result.totalMs / 2, 'majority of the day was autonomous');
      assert.ok(result.attentionRatio > 0.05 && result.attentionRatio < 0.15, `ratio ${String(result.attentionRatio)}`);
      assert.ok(result.autonomousMs + result.humanMs === result.totalMs, 'split is complete');
      assert.equal(result.decisions, 2);
      assert.equal(result.takeovers, 1);
      assert.equal(result.unsafeActions, 0, 'nothing was policy-denied in the story');

      // ── beat order from the condensed timeline ─────────────────────
      const t = result.timeline;
      const idx = (pred: (e: (typeof t)[number]) => boolean): number => t.findIndex(pred);
      const started = idx((e) => e.kind === 'lifecycle' && e.text.startsWith('Started:'));
      const failedTest = idx((e) => e.kind === 'test' && e.text.includes('tests failed'));
      const passedTest = idx((e) => e.kind === 'test' && e.text.includes('tests passed'));
      const installDecision = idx((e) => e.kind === 'decision' && e.text.includes('ioredis'));
      const forceDecision = idx((e) => e.kind === 'decision' && e.text.includes('force'));
      const tookOver = idx((e) => e.kind === 'intervention' && e.text === 'You took over');
      const returned = idx((e) => e.kind === 'intervention' && e.text === 'Control returned to the agent');
      const completed = idx((e) => e.kind === 'lifecycle' && e.text === 'Completed');

      for (const [name, i] of Object.entries({ started, failedTest, passedTest, installDecision, forceDecision, tookOver, returned, completed })) {
        assert.ok(i >= 0, `timeline contains the "${name}" beat`);
      }
      assert.ok(started < failedTest && failedTest < passedTest, 'autonomous work beats precede the decisions');
      assert.ok(installDecision < forceDecision, 'install decision BEFORE force decision');
      assert.ok(passedTest < installDecision, 'self-heal happens before the approval ask');
      assert.ok(
        forceDecision < tookOver && tookOver < returned && returned < completed,
        'take-over sits between the unanswered force-push decision and completion',
      );

      // ── final screen: derived, printed, and captured ───────────────
      assert.ok(result.finalScreen.some((l) => l.includes('TASK COMPLETE')));
      assert.ok(
        result.finalScreen.some(
          (l) => l.startsWith('TASK COMPLETE — ') && l.includes(DEMO_STORY.goal),
        ),
        'headline carries the real goal',
      );
      assert.ok(result.finalScreen.some((l) => l === '42 min total · 38 min autonomous · 4 min human attention'));
      assert.ok(result.finalScreen.some((l) => l === '2 decisions · 1 takeover · 0 unsafe actions'));
      assert.ok(result.finalScreen.some((l) => l === 'Human attention ratio: 9.5%'));
      assert.ok(captured.length > result.finalScreen.length, 'console/log sink saw every screen line');
      assert.ok(
        result.finalScreen.every((l) => captured.includes(l)),
        'every finalScreen line was also emitted to the log',
      );
      assert.ok(
        captured.some((l) => l.includes('WHAT') && l.includes('ioredis')) &&
          captured.some((l) => l.includes('WHY NOW')) &&
          captured.some((l) => l.includes('BLAST RADIUS') && l.includes('external-system')),
        'the decision WHY bullets were printed for install and force-push',
      );

      // ── DB reload: the story is durable, not in-memory theatre ─────
      const db2 = new ConductorDatabase({ path: result.dbPath });
      try {
        const repo = new SqliteExecutionRepository(db2);
        const reloaded = repo.findById(result.executionId);
        assert.ok(reloaded, 'execution row survived');
        assert.equal(reloaded.status, 'COMPLETED');
        // Decision ROWS are the source of truth: ExecutionManager.processEvent
        // re-saves its pre-create aggregate after DecisionQueue.addDecision,
        // so state.decisions/decisionCount can lag — the screen derives from rows.
        const dRepo = new SqliteDecisionRepository(db2);
        assert.equal(dRepo.list({ executionId: result.executionId }).length, 2);

        // ── reschedule onto a fresh fictional base: exactly 42 min ───
        const shifted = reschedule(reloaded.toState(), 500_000);
        const m = computeAttentionMetrics(new Execution(shifted), [], { now: 9_999_999_999 });
        assert.equal(m.totalMs, DEMO_STORY.totalMs, 'reschedule lands the day at exactly 42 minutes');
        assert.equal(shifted.timestamps.createdAt, 500_000);
        assert.equal(m.attentionRatio, 4 / 42);
        // idempotent: applying the schedule again with the same base changes nothing
        const twice = reschedule(shifted, 500_000);
        assert.deepEqual(twice.transitions.map((x) => x.timestamp), shifted.transitions.map((x) => x.timestamp));
        assert.deepEqual(twice, shifted);
      } finally {
        db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, maxRetries: 5 });
    }
  });

  test('defaults: opts.now falls back to wall clock and the story window is 42 min wide', async () => {
    const dir = tempDir();
    try {
      const t0 = Date.now();
      const result = await runDemoScenario({ workspaceRoot: dir, log: () => {} });
      assert.ok(
        result.storyBaseAt >= t0 - DEMO_STORY.totalMs &&
          result.storyBaseAt <= Date.now() - DEMO_STORY.totalMs + MIN,
        'default opts.now anchors the story to the wall clock, ending now-ish',
      ); // sanity: recent clock
      assert.equal(result.storyEndAt - result.storyBaseAt, 42 * MIN);
      assert.equal(result.facts.finalStatus, 'COMPLETED');
      assert.ok(result.facts.eventCount > 20, 'the day was recorded event by event');
    } finally {
      rmSync(dir, { recursive: true, maxRetries: 5 });
    }
  });
});
