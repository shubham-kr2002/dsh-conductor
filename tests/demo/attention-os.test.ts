/**
 * Phase 10 — "Attention OS" fleet demo tests.
 *
 * Runs the full scripted fleet story once against a real SQLite file in
 * a temp dir (tests/.tmp-demo10-*) with opts.now pinned, then pins the
 * invariants the return-to-work screen advertises:
 *   - the noise storm creates ZERO decisions yet groups into exactly
 *     one failure cluster (>= 2 grouped members, forensics kept);
 *   - the interruption budget demotes vesta's install (queue + why) and
 *     is proven presentation-only (every demotion durably answered);
 *   - delegation covers hera's install (policy.delegated forensics,
 *     decision total unchanged, observation in the model);
 *   - nova's CRITICAL leads the cockpit and demotes atlas's question;
 *   - the take-over intervened in nova and returned control;
 *   - at story end map.finished === 4 and needsYou === 1;
 *   - the return-to-work block exists, quotes the held decision and an
 *     attention-ratio line; human attention < 8 min of the 50-min story;
 *   - facts reconcile (held + control + autonomous === total;
 *     interruptions === decisions + takeovers);
 *   - a second run into a fresh db yields IDENTICAL facts (determinism).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { MINUTE } from '../../src/demo/scenario.js';
import {
  ATTENTION_STORY_MINUTES,
  runDemoAttention,
  type AttentionDemoResult,
} from '../../src/demo/attention-os.js';

const NOW = 1_763_320_000_000; // pinned fictional "now" (end of the story)

/** Replace volatile UUID-bearing tokens so screens can be compared. */
function scrub(s: string): string {
  return s.replace(/(dec|dl|evt|exec|call|st|cand)-[0-9a-f-]{8,}/gi, '$1-<id>');
}

function tempDir(prefix = '.tmp-demo10-'): string {
  return mkdtempSync(join(process.cwd(), 'tests', prefix));
}

describe('Phase 10 — Attention OS deterministic fleet demo', async () => {
  const dir = tempDir();
  let result: AttentionDemoResult;
  const captured: string[] = [];
  try {
    result = await runDemoAttention({
      workspaceRoot: dir,
      now: NOW,
      log: (line) => captured.push(line),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  test('story window + database land where promised', () => {
    assert.equal(result.storyEndAt - result.storyBaseAt, ATTENTION_STORY_MINUTES * MINUTE);
    assert.equal(result.storyEndAt, NOW);
    assert.equal(result.dbPath, join(dir, '.conductor-demo', 'attention.db'));
    assert.match(result.facts.pendingTitle, /helm uninstall ns demo/);
  });

  test('beat 2 — noise storm created ZERO decisions yet one failure cluster', () => {
    assert.equal(result.facts.stormDecisions, 0, 'storm must not create decisions');
    assert.equal(result.facts.stormPauseActions, 0, 'storm must not pause orion');
    assert.ok(
      result.facts.stormLevels.every((l) => l === 'BACKGROUND' || l === 'SILENT' || l === 'DECISION'),
      'storm classifications stay self-heal/notify — never PAUSE',
    );
    assert.equal(result.facts.stormClusters, 1, 'exactly one failure cluster');
    assert.ok(result.facts.stormClusterMembers >= 2, 'cluster groups >= 2 members');
    assert.equal(result.facts.stormClusterMembers, 3, 'three failing test runs grouped');
    assert.deepEqual(result.batches, [{ agent: 'orion', members: 3 }]);
    assert.ok(captured.some((l) => l.includes('storm absorbed')), '"storm absorbed" printed');
  });

  test('beat 3/4 — atlas holds needs-you; the budget demotes vesta durably', () => {
    assert.equal(result.facts.atlasDecisionImpact, 'major');
    assert.equal(result.facts.atlasDecisionUrgency, 'high');
    assert.equal(result.facts.atlasStatusAfterQuestion, 'PAUSED');
    assert.equal(result.facts.atlasHoldsNeedsYou, true);
    assert.equal(result.facts.vestaDemoted, true, 'vesta demoted from interrupt to queue');
    assert.equal(result.facts.vestaWhyWaiting, true, 'queue item explains its deferral');
    assert.equal(result.facts.budgetDemotions, 2, 'vesta at beat 4, atlas at beat 6');
    assert.equal(result.facts.budgetDemotionsResolved, 2);
    assert.equal(result.facts.budgetSuppressedLost, 0, 'suppression is presentation-only');
    assert.ok(captured.some((l) => l.includes('queued, not interrupted')));
    assert.ok(captured.some((l) => l.includes('• WHAT —')), 'the three WHY bullets printed');
  });

  test('beat 5 — delegation covered hera: forensics, zero decisions, observation', () => {
    assert.equal(result.facts.delegationGranted, 1);
    assert.equal(result.facts.delegatedActions, 1);
    assert.equal(result.facts.delegationForensics, 2, 'tool.called + command.started each leave one row');
    assert.equal(result.facts.heraDecisions, 0, 'decision total unchanged by the covered action');
    assert.equal(result.facts.decisionsTotal, 4, 'atlas, vesta, nova, orion — nothing for hera');
    assert.equal(result.facts.heraFinalDisposition, 'observe', 'watched, not surfaced');
    assert.ok(
      captured.some((l) => l.includes("ran under your delegation — here is why it didn't ask")),
      'explainNonInterruption block printed',
    );
    assert.ok(captured.some((l) => l.includes('you delegated this category')));
  });

  test('beat 6 — nova CRITICAL leads the cockpit; atlas demoted to waiting', () => {
    assert.equal(result.facts.novaCriticalLeads, true);
    assert.equal(result.facts.atlasDemotedToWaiting, true);
    assert.ok(captured.some((l) => l.includes('CRITICAL leads')));
  });

  test('beat 7 — the take-over intervened in nova and control was returned', () => {
    assert.equal(result.facts.takeovers, 1);
    assert.equal(result.takeover.agent, 'nova');
    assert.equal(result.takeover.actor, 'shubham');
    assert.equal(result.takeover.manualFile, 'docs/ROLLBACK.md');
    assert.equal(result.facts.novaStatusAfterTakeover, 'RUNNING', 'control returned');
    assert.ok(result.takeover.returnedAt > result.takeover.tookOverAt);
  });

  test('final map — 4 finished, exactly 1 needs-you (the held helm gate)', () => {
    assert.equal(result.map.agents, 5);
    assert.equal(result.map.finished, 4);
    assert.equal(result.map.needsYou, 1);
    assert.equal(result.facts.decisionsPending, 1);
    assert.equal(result.facts.pendingAgent, 'orion');
    assert.equal(result.facts.unsafeActions, 0);
    // the cockpit leads with the held decision, then the batched failure observation
    assert.equal(result.orderedItems[0]!.agent, 'orion');
    assert.equal(result.orderedItems[0]!.section, 'needs-you');
    // The failure storm is visibly suppressed in the cockpit — since the
    // dedupe/cluster core fix it lands as a batched cluster ('watching');
    // 'waiting' covers the un-clustered presentation.
    assert.ok(result.orderedItems.some((i) => i.section === 'waiting' || i.section === 'watching'));
  });

  test('return-to-work block is derived, quoted and honest', () => {
    const joined = result.returnToWork.join('\n');
    assert.match(joined, /While you were away: 5 agents · 4 finished · 1 needs your review now/);
    assert.ok(
      result.returnToWork.some((l) => l.includes(result.facts.pendingTitle)),
      'the one pending decision title heads the brief',
    );
    assert.match(joined, /Attention ratio/);
    assert.match(joined, /0 unsafe/);
    assert.match(joined, /2 demotions · 2 durably answered · 0 lost/);
    assert.match(joined, /3 batched observations/);
    const screen = result.finalScreen.join('\n');
    assert.match(screen, /1 requires your attention/);
  });

  test('attention accounting reconciles and stays realistic (< 8 min of ~50)', () => {
    const f = result.facts;
    assert.equal(f.heldMs + f.humanControlMs + f.autonomousMs, f.fleetTotalMs, 'attention split is complete');
    assert.equal(f.interruptionsTotal, f.decisionsTotal + f.takeovers, 'interruptions reconcile');
    assert.equal(f.humanAttentionMs, f.heldMs + f.humanControlMs);
    assert.ok(
      f.humanAttentionMs > 0 && f.humanAttentionMs < 8 * MINUTE,
      `human attention ${String(f.humanAttentionMs)} ms must be < 8 min`,
    );
    assert.ok(f.attentionRatio > 0 && f.attentionRatio < 0.2, 'fleet ratio is a fraction of agent-minutes');
    assert.equal(f.medianResponseMs, 66_000, 'median response derived from the story slots');
    assert.equal(f.recurrences, 0);
    assert.equal(f.outcomeCompletedAfter, 3, 'three answered decisions were followed by completion');
  });

  test('take-over interventions persist on the fictional clock', async () => {
    const dir2 = tempDir('.tmp-demo10-verify-');
    const r2 = await runDemoAttention({ workspaceRoot: dir2, now: NOW, log: () => {} });
    const db = new ConductorDatabase({ path: r2.dbPath });
    try {
      const nova = new SqliteExecutionRepository(db).findById(r2.executionIds.nova)!;
      const types = nova.interventions.map((i) => i.type);
      assert.ok(types.includes('take_over'), 'take_over intervention recorded');
      assert.ok(types.includes('continue'), 'control returned to the agent');
      const take = nova.interventions.find((i) => i.type === 'take_over')!;
      assert.equal(take.timestamp, r2.takeover.tookOverAt, 'intervention carries the fictional clock');
      assert.ok(take.timestamp < r2.storyEndAt && take.timestamp > r2.storyBaseAt);
    } finally {
      db.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('determinism — a second run into a fresh db yields identical facts', async () => {
    const dirB = tempDir('.tmp-demo10-det-');
    try {
      const second = await runDemoAttention({ workspaceRoot: dirB, now: NOW, log: () => {} });
      assert.deepEqual(second.facts, result.facts, 'facts identical between runs (facts carry no ids)');
      assert.deepEqual(
        second.finalScreen.map(scrub),
        result.finalScreen.map(scrub),
        'screens identical modulo ids',
      );
      assert.deepEqual(
        second.map,
        result.map,
        'attention map identical',
      );
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
