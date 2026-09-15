/**
 * Part 19 — "A Day In The Life" deterministic demo scenario.
 *
 * Drives the REAL control plane (ExecutionManager + DecisionQueue +
 * PolicyEngine + AttentionEngine + EventAdapter + SQLite persistence)
 * through a scripted 42-minute story, then prints the final
 * return-to-work screen. Every number on that screen is derived from
 * persisted rows via the public summary derivations
 * (computeAttentionMetrics / rollupDecisionQuality / condenseTimeline /
 * buildAwaySummary / statusLanguage) — nothing is hardcoded.
 *
 * The story itself runs in milliseconds of real wall-clock time, so the
 * persisted timestamps are shifted AFTER the fact onto a fictional
 * schedule via the pure `reschedule` helper (execution state keeps its
 * transitions inside state_json, which repo.save re-serializes whole),
 * `rescheduleDecision` (decision rows via decisionRepo.save), and events
 * (pre-stamped at emit time with the same fictional clock).
 *
 * Beats (fictional clock shown for base = 09:12):
 *   1. "Upgrade the application dependencies and migrate the payment
 *      API" STARTED → RUNNING (agent 'atlas').
 *   2. Autonomous work: read/search, edits to src/pricing.ts +
 *      src/migrations/0042.sql, `pnpm test` FAILS → attention stays
 *      BACKGROUND (self-heal, zero decisions), fix + re-run passes.
 *   3. `pnpm add ioredis@5.4.1` → REQUIRE_APPROVAL decision with a
 *      structured `why`; developer answers APPROVE ONCE (accepted).
 *   4. Approval token: consumeApproval() true, then false (one-time).
 *      The install completes.
 *   5. `git push --force origin main` → CRITICAL decision (irreversible,
 *      external blast radius). Developer does NOT answer — takes over,
 *      edits the migration by hand, returns control. The decision stays
 *      pending.
 *   6. Agent continues, tests pass, execution.completed.
 *   7. Return-to-work screen printed from public derivations only.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Execution } from '../domain/execution.js';
import { EventAdapter } from '../adapter/event-adapter.js';
import { DecisionQueue } from '../decision/decision-queue.js';
import { deriveDecisionQuality, rollupDecisionQuality } from '../decision/decision-quality.js';
import { ExecutionManager } from '../manager/execution-manager.js';
import { approvalSubject } from '../policy/approval-subject.js';
import { ConductorDatabase } from '../storage/database.js';
import { SqliteDecisionRepository } from '../storage/decision-repository.js';
import { SqliteEventRepository } from '../storage/event-repository.js';
import { SqliteExecutionRepository } from '../storage/execution-repository.js';
import { computeAttentionMetrics, formatDuration } from '../summary/attention-metrics.js';
import { buildAwaySummary, renderAwaySummary } from '../summary/away-mode.js';
import { statusLanguage } from '../summary/status-language.js';
import { condenseTimeline, type TimelineEntry } from '../summary/timeline.js';
import type { AttentionClassification } from '../types/attention.js';
import type { ConductorDecision, DecisionWhy } from '../types/decision.js';
import type { ConductorEvent } from '../types/event.js';
import type {
  ExecutionState,
  ExecutionStatus,
  ExecutionTimestamps,
  HumanInterventionRecord,
  StateTransitionRecord,
} from '../types/execution.js';

export const MINUTE = 60_000;

/** The fictional story schedule — offsets in MINUTES from story base. */
export const DEMO_STORY = {
  goal: 'Upgrade the application dependencies and migrate the payment API',
  agentId: 'atlas',
  totalMin: 42,
  totalMs: 42 * MINUTE,
  /**
   * Fictional offset per lifecycle transition, in the exact order the
   * story produces them: start, pause (install ask), resume (approved),
   * pause (force-push), take-over, return control, complete.
   * held = (16.5-15) + (25-24) = 2.5 min; human control = 26.5-25 = 1.5
   * min → 4 min human attention out of 42 → ratio 9.5%.
   */
  transitionOffsetsMin: [0, 15, 16.5, 24, 25, 26.5, 42],
  /** Event emission stamps for the scripted beats. */
  beats: {
    start: 0,
    steppedAway: 0.5,
    readManifest: 2,
    grepCheckout: 2.4,
    editPricing: 6,
    writeMigration: 6.5,
    testStart: 10,
    testFail: 10.8,
    fixPricing: 12,
    fixTest: 12.4,
    testRerunStart: 13,
    testPass: 13.8,
    installAsk: 15,
    installDone: 17,
    installPkgJson: 17.3,
    pushAsk: 24,
    takeOver: 25,
    manualEdit: 25.8,
    returnControl: 26.5,
    reviewPayment: 32,
    finalTestStart: 33,
    finalTestPass: 33.9,
    commit: 36,
    commitDone: 36.4,
    complete: 42,
  },
  /** Fictional clock slots for the two decisions produced by the story. */
  decisionSlots: {
    install: { createdMin: 15, presentedMin: 15.25, resolvedMin: 16.5, updatedMin: 17, consumedMin: 16.75 },
    force: { createdMin: 24, presentedMin: 24.33, updatedMin: 24.33 },
  },
} as const;

export interface DemoOptions {
  /** SQLite file. Default `${workspaceRoot}/.conductor-demo/demo.db`. */
  dbPath?: string;
  /** Workspace the fictional execution operates in. Default cwd. */
  workspaceRoot?: string;
  /** Story "now" (end of the 42-minute day). Default Date.now(). */
  now?: number;
  /** Output sink. Defaults to console.log. Every line passes through. */
  log?: (line: string) => void;
}

export interface DemoFacts {
  /** Attention levels recorded for the failing `pnpm test` events. */
  failureAttentionLevels: string[];
  /** New decisions caused by the failed test run — must be 0. */
  decisionDeltaOnFailure: number;
  /** First consumeApproval of the install token — expected true. */
  tokenFirst: boolean;
  /** Second consumeApproval of the same token — expected false. */
  tokenSecond: boolean;
  installSubject: string;
  forceSubject: string;
  finalStatus: ExecutionStatus;
  eventCount: number;
}

export interface DemoResult {
  executionId: string;
  goal: string;
  dbPath: string;
  /** Fictional story window, derived from opts.now. */
  storyBaseAt: number;
  storyEndAt: number;
  totalMs: number;
  autonomousMs: number;
  humanMs: number;
  attentionRatio: number;
  decisions: number;
  takeovers: number;
  unsafeActions: number;
  timeline: TimelineEntry[];
  finalScreen: string[];
  decisionIds: { install: string; force: string };
  facts: DemoFacts;
}

/**
 * Pure: rewrite an execution's persisted timeline onto the fictional
 * schedule that starts at `base`. Transitions are mapped positionally
 * (clamped to the last offset), createdAt/startedAt/updatedAt/completedAt
 * follow, take-over interventions attach to their transitions, and
 * metrics.durationMs is recomputed from the shifted bounds. Feeding an
 * already-rescheduled state with a new base produces the same 42-minute
 * story again (idempotent remapping, no relative drifting).
 */
export function reschedule(state: ExecutionState, base: number): ExecutionState {
  const offsets = DEMO_STORY.transitionOffsetsMin;
  const clamp = (i: number) => offsets[Math.min(i, offsets.length - 1)] ?? 0;
  const transitions: StateTransitionRecord[] = state.transitions.map((t, i) => ({
    ...t,
    timestamp: base + clamp(i) * MINUTE,
  }));

  const lastTransitionTs =
    transitions.length > 0
      ? transitions[transitions.length - 1]!.timestamp
      : base + DEMO_STORY.totalMs;

  const timestamps: ExecutionTimestamps = {
    createdAt: base,
    ...(state.timestamps.startedAt != null ? { startedAt: base + (offsets[0] ?? 0) * MINUTE } : {}),
    updatedAt: lastTransitionTs,
    ...(state.timestamps.completedAt != null ? { completedAt: lastTransitionTs } : {}),
  };

  const takeOverTs = transitions.find((t) => t.to === 'TAKEN_OVER')?.timestamp;
  const returnTs =
    takeOverTs != null
      ? transitions.find((t) => t.to === 'RUNNING' && t.timestamp > takeOverTs)?.timestamp
      : undefined;
  const interventions: HumanInterventionRecord[] = state.interventions.map((iv) => {
    if (iv.type === 'take_over' && takeOverTs != null) return { ...iv, timestamp: takeOverTs };
    if (iv.type === 'continue' && returnTs != null) return { ...iv, timestamp: returnTs };
    return { ...iv, timestamp: timestamps.createdAt };
  });

  const durationMs =
    timestamps.startedAt != null
      ? Math.max(0, lastTransitionTs - timestamps.startedAt)
      : 0;

  return {
    ...state,
    timestamps,
    transitions,
    interventions,
    metrics: { ...state.metrics, durationMs },
  };
}

/** Fictional clock slot for one decision row. */
export interface DecisionSlot {
  createdMin: number;
  presentedMin?: number;
  resolvedMin?: number;
  updatedMin: number;
  consumedMin?: number;
}

/** Pure: rewrite a decision row's observable timestamps onto the story. */
export function rescheduleDecision(
  d: ConductorDecision,
  base: number,
  slot?: DecisionSlot,
): ConductorDecision {
  if (!slot) return { ...d };
  const at = (min: number) => base + min * MINUTE;
  const out: ConductorDecision = {
    ...d,
    createdAt: at(slot.createdMin),
    updatedAt: at(slot.updatedMin),
    ...(d.resolution
      ? { resolution: { ...d.resolution, resolvedAt: at(slot.resolvedMin ?? slot.createdMin) } }
      : {}),
    ...(d.consumedAt != null && slot.consumedMin != null ? { consumedAt: at(slot.consumedMin) } : {}),
  };
  if (d.quality?.presentedAt != null || slot.presentedMin != null) {
    out.quality = { ...d.quality, presentedAt: at(slot.presentedMin ?? slot.createdMin) };
  }
  return out;
}

/** The verdict phrase for the return-to-work headline, from real status. */
const VERDICT: Partial<Record<ExecutionStatus, string>> = {
  COMPLETED: 'TASK COMPLETE',
  FAILED: 'TASK FAILED',
  CANCELLED: 'TASK CANCELLED',
};

function whyBullets(w: DecisionWhy | undefined): string[] {
  if (!w) return [];
  return [
    `• WHAT — ${w.what}`,
    `• WHY NOW — ${w.whyNow}`,
    `• IMPACT — ${w.impact} · ${w.reversibility}${w.reversibilityNote ? ` — ${w.reversibilityNote}` : ''}`,
    `• BLAST RADIUS — ${w.evidence.blastRadius} (rules: ${w.evidence.ruleIds.join(', ') || 'attention'})`,
    ...(w.recommendation ? [`• RECOMMENDATION — ${w.recommendation}`] : []),
  ];
}

function eventLabel(e: ConductorEvent): string {
  const p = e.payload as Record<string, unknown>;
  const focus = p.command ?? p.filePath ?? p.toolName ?? p.testName ?? p.action ?? p.summary ?? p.goal ?? '';
  const s = String(focus);
  return s === '' ? e.type : `${e.type} — ${s.slice(0, 74)}`;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Run the full scripted day against a real SQLite database and return the
 * derived return-to-work result. See the module header for the beat list.
 */
export async function runDemoScenario(opts: DemoOptions = {}): Promise<DemoResult> {
  const log = opts.log ?? ((line: string): void => console.log(line));
  const now = opts.now ?? Date.now();
  const base = now - DEMO_STORY.totalMs;
  const workspaceRoot = resolve(opts.workspaceRoot ?? process.cwd());
  const dbPath = opts.dbPath ?? join(workspaceRoot, '.conductor-demo', 'demo.db');
  mkdirSync(workspaceRoot, { recursive: true }); // ConductorDatabase makes db dirname itself

  const B = DEMO_STORY.beats;
  const clock = (t: number) => new Date(t).toTimeString().slice(0, 5);
  const storyTs = (min: number) => base + min * MINUTE;

  const db = new ConductorDatabase({ path: dbPath });
  try {
    const execRepo = new SqliteExecutionRepository(db);
    const eventRepo = new SqliteEventRepository(db);
    const decisionRepo = new SqliteDecisionRepository(db);
    const decisions = new DecisionQueue(decisionRepo, execRepo);
    const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);

    /** Feed pre-built events through the real pipeline on the fictional clock. */
    const emit = (events: ConductorEvent[], min: number): AttentionClassification[] => {
      const t = storyTs(min);
      const out: AttentionClassification[] = [];
      for (const e of events) {
        const cls = manager.processEvent({ ...e, timestamp: t });
        if (cls) out.push(cls);
        log(`  ${clock(t)} · ${eventLabel(e)}${cls ? `  [attention: ${cls.level}]` : ''}`);
      }
      return out;
    };

    log('=================================================================');
    log(' CONDUCTOR · PART 19 — A DAY IN THE LIFE (deterministic demo)');
    log(` workspace ${workspaceRoot}`);
    log(` sqlite    ${dbPath}`);
    log(` story     ${clock(base)} → ${clock(base + DEMO_STORY.totalMs)} (42 min)`);
    log('=================================================================');

    // ── Beat 1 · the task is handed over and starts ──────────────────
    log('');
    log('▶ beat 1 — developer sets the task and steps away');
    const exec = manager.createExecution({
      goal: DEMO_STORY.goal,
      workspaceRoot,
      agent: { id: DEMO_STORY.agentId, provider: 'dsh', model: 'atlas-1' },
      initialPhase: 'initialization',
      constraints: ['payment API v1 contract must stay intact', 'no history rewrites without human sign-off'],
    });
    emit(
      [
        EventAdapter.createEvent(
          exec.id,
          'execution.started',
          { executionId: exec.id, goal: DEMO_STORY.goal, workspaceRoot, agentId: DEMO_STORY.agentId },
          'dsh',
        ),
      ],
      B.start,
    );
    emit(
      [
        EventAdapter.createEvent(
          exec.id,
          'human.intervention',
          { action: 'mark_away', actor: 'shubham', notes: 'developer stepped away; atlas owns the run' },
          'human',
        ),
      ],
      B.steppedAway,
    );

    // ── Beat 2 · autonomous work: a failing test is NOT an interrupt ─
    log('');
    log('▶ beat 2 — atlas works alone: reads, edits, runs the suite, it fails, self-heals');
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-read-1', name: 'read', arguments: { file_path: 'package.json' } }), B.readManifest);
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-grep-1', name: 'grep', arguments: { pattern: 'checkout' } }), B.grepCheckout);
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-edit-1', name: 'edit', arguments: { file_path: 'src/pricing.ts' } }), B.editPricing);
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-write-1', name: 'write', arguments: { file_path: 'src/migrations/0042.sql' } }), B.writeMigration);

    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-test-1', name: 'bash', arguments: { command: 'pnpm test' } }), B.testStart);
    const decisionsBeforeFailure = decisions.list(exec.id).length;
    const failureClasses = emit(
      EventAdapter.adaptToolResult(
        exec.id,
        {
          callId: 'call-test-1',
          toolName: 'bash',
          isError: true,
          error: { name: 'CommandFailed', code: 'EXIT_1', message: 'pricing.test.ts: expected 200, got 500 (redis client not initialised)' },
        },
        { command: 'pnpm test' },
      ),
      B.testFail,
    );
    const decisionDeltaOnFailure = decisions.list(exec.id).length - decisionsBeforeFailure;
    if (decisionDeltaOnFailure !== 0) {
      throw new Error(`demo invariant broken: failed test run created ${String(decisionDeltaOnFailure)} decision(s), expected 0 (self-heal)`);
    }
    const failureAttentionLevels = failureClasses.map((c) => c.level);
    log(`      ↳ self-healed: ${plural(decisionDeltaOnFailure, 'decision')} created for the failure (levels: ${failureAttentionLevels.join(', ')})`);

    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-edit-2', name: 'edit', arguments: { file_path: 'src/pricing.ts' } }), B.fixPricing);
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-edit-3', name: 'edit', arguments: { file_path: 'tests/pricing.test.ts' } }), B.fixTest);
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-test-2', name: 'bash', arguments: { command: 'pnpm test' } }), B.testRerunStart);
    emit(
      EventAdapter.adaptToolResult(exec.id, { callId: 'call-test-2', toolName: 'bash', isError: false }, { command: 'pnpm test' }),
      B.testPass,
    );

    // ── Beat 3 · dependency install needs the human ──────────────────
    log('');
    log('▶ beat 3 — `pnpm add ioredis@5.4.1` hits the dependency policy → a decision with a real WHY');
    const installCmd = 'pnpm add ioredis@5.4.1';
    const installSubject = approvalSubject('bash', { command: installCmd });
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-install-1', name: 'bash', arguments: { command: installCmd } }), B.installAsk);
    const installDecision = decisions.pending(exec.id).find((d) => d.subject === installSubject);
    if (!installDecision) throw new Error('demo invariant broken: no pending decision for the install');
    decisions.present(installDecision.id);
    log(`      ⚑ ${installDecision.title}  (${installDecision.impact}/${installDecision.urgency})`);
    for (const bullet of whyBullets(installDecision.why)) log(`        ${bullet}`);
    log('      shubham answers: APPROVE ONCE');
    decisions.resolve(installDecision.id, 'accepted', { answerBy: 'shubham' });

    // ── Beat 4 · the approve-once token is spent exactly once ────────
    log('');
    log('▶ beat 4 — the approval grants one retry token: consume once true, then false');
    const tokenFirst = decisions.consumeApproval(exec.id, installSubject);
    const tokenSecond = decisions.consumeApproval(exec.id, installSubject);
    if (!(tokenFirst && !tokenSecond)) {
      throw new Error(`demo invariant broken: approval token consume was ${String(tokenFirst)}/${String(tokenSecond)}, expected true/false`);
    }
    log(`      consumeApproval("${installSubject}") → ${String(tokenFirst)}, again → ${String(tokenSecond)}`);
    emit(
      EventAdapter.adaptToolResult(exec.id, { callId: 'call-install-1', toolName: 'bash', isError: false }, { command: installCmd }),
      B.installDone,
    );
    emit(
      [EventAdapter.createEvent(exec.id, 'file.changed', { filePath: 'package.json', action: 'modified' }, 'agent')],
      B.installPkgJson,
    );

    // ── Beat 5 · the force-push: CRITICAL, unanswered → take over ────
    log('');
    log('▶ beat 5 — `git push --force origin main` is rated critical; developer takes over instead of answering');
    const forceCmd = 'git push --force origin main';
    const forceSubject = approvalSubject('bash', { command: forceCmd });
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-push-1', name: 'bash', arguments: { command: forceCmd } }), B.pushAsk);
    const forceDecision = decisions.pending(exec.id).find((d) => d.subject === forceSubject);
    if (!forceDecision) throw new Error('demo invariant broken: no pending decision for the force push');
    decisions.present(forceDecision.id);
    log(`      ⚑ ${forceDecision.title}  (${forceDecision.impact}/${forceDecision.urgency})`);
    for (const bullet of whyBullets(forceDecision.why)) log(`        ${bullet}`);
    log('      shubham does NOT answer — takes the keyboard');

    const heldExec = manager.getExecution(exec.id);
    heldExec.takeOver('shubham', 'Force-push rewrites published history; developer handles the push personally.');
    execRepo.save(heldExec);
    emit(
      [EventAdapter.createEvent(exec.id, 'human.intervention', { action: 'take_over', actor: 'shubham', notes: 'rewinding origin/main by hand' }, 'human')],
      B.takeOver,
    );
    emit(
      [EventAdapter.createEvent(exec.id, 'file.changed', { filePath: 'src/migrations/0042.sql', action: 'modified' }, 'human')],
      B.manualEdit,
    );
    const backExec = manager.getExecution(exec.id);
    backExec.continueFromTakeOver('shubham', 'Fixed migration 0042 manually; pushing with --force-with-lease myself.', ['src/migrations/0042.sql']);
    execRepo.save(backExec);
    emit(
      [EventAdapter.createEvent(exec.id, 'human.intervention', { action: 'continue', actor: 'shubham', notes: 'control returned to atlas', modifications: ['src/migrations/0042.sql'] }, 'human')],
      B.returnControl,
    );

    // ── Beat 6 · agent finishes the job ──────────────────────────────
    log('');
    log('▶ beat 6 — atlas resumes, verifies, commits, finishes');
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-read-2', name: 'read', arguments: { file_path: 'src/payment/api.ts' } }), B.reviewPayment);
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-test-3', name: 'bash', arguments: { command: 'pnpm test' } }), B.finalTestStart);
    emit(
      EventAdapter.adaptToolResult(exec.id, { callId: 'call-test-3', toolName: 'bash', isError: false }, { command: 'pnpm test' }),
      B.finalTestPass,
    );
    const wrapExec = manager.getExecution(exec.id);
    wrapExec.addCompletedWork('Dependency upgraded — ioredis@5.4.1 installed after one-time approval');
    wrapExec.addCompletedWork('Payment API migrated — migration 0042 applied, suite green (112 tests)');
    wrapExec.addRisk('Migration 0042 was edited during the human take-over — re-verify on staging before release');
    wrapExec.setProgressSummary('Dependencies upgraded and payment API migration complete — suite green');
    execRepo.save(wrapExec);
    emit(EventAdapter.adaptToolCall(exec.id, { callId: 'call-commit-1', name: 'bash', arguments: { command: 'git commit -m "deps: ioredis@5.4.1; feat(payment): migration 0042"' } }), B.commit);
    emit(
      EventAdapter.adaptToolResult(
        exec.id,
        { callId: 'call-commit-1', toolName: 'bash', isError: false },
        { command: 'git commit -m "deps: ioredis@5.4.1; feat(payment): migration 0042"' },
      ),
      B.commitDone,
    );
    emit(
      [
        EventAdapter.createEvent(
          exec.id,
          'execution.completed',
          { executionId: exec.id, completedWork: [], summary: 'Dependencies upgraded and payment API migration complete', durationMs: 0 },
          'dsh',
        ),
      ],
      B.complete,
    );

    // ── Beat 7 · shift persisted rows onto the fictional schedule ────
    // (transitions/decisions were stamped with the real Date.now() deep
    // inside Execution / DecisionQueue — remap them after the fact.)
    log('');
    log('▶ beat 7 — re-timing the day onto the fictional schedule, then deriving the screen');
    execRepo.save(new Execution(reschedule(execRepo.findById(exec.id)!.toState(), base)));

    const slots = new Map<string, DecisionSlot>([
      [installDecision.id, DEMO_STORY.decisionSlots.install],
      [forceDecision.id, DEMO_STORY.decisionSlots.force],
    ]);
    for (const d of decisionRepo.list({ executionId: exec.id })) {
      const shifted = rescheduleDecision(d, base, slots.get(d.id));
      // The decision upsert never rewrites created_at, so shift the row by
      // delete + reinsert (the repository's only full-rewrite path).
      decisionRepo.delete(d.id);
      decisionRepo.save(shifted);
    }

    // Persist the observable decision-quality facts (post-hoc, derived).
    const finalExec = execRepo.findById(exec.id)!;
    const allDecisions = decisionRepo.list({ executionId: exec.id });
    for (const d of allDecisions) {
      d.quality = deriveDecisionQuality(d, allDecisions, finalExec);
      decisionRepo.save(d);
    }
    const decisionsFinal = decisionRepo.list({ executionId: exec.id });
    const eventsFinal = eventRepo.listByExecution(exec.id);

    // ── Return-to-work screen — public derivations ONLY ──────────────
    const metrics = computeAttentionMetrics(finalExec, decisionsFinal, {
      now,
      takeoverCount: finalExec.interventions.filter((i) => i.type === 'take_over').length,
    });
    const unsafeActions = eventsFinal.filter(
      (e) => (e.metadata?.attention as { ruleId?: string } | undefined)?.ruleId === 'policy-deny',
    ).length;
    const roll = rollupDecisionQuality(decisionsFinal);
    const timeline = condenseTimeline(eventsFinal, decisionsFinal);
    const away = buildAwaySummary({
      execution: finalExec,
      events: eventsFinal,
      decisions: decisionsFinal,
      since: base,
      now: storyTs(DEMO_STORY.totalMin),
    });
    const lang = statusLanguage(metrics.status);
    const verdict = VERDICT[metrics.status] ?? lang.label.toUpperCase();
    const humanMs = metrics.heldMs + metrics.humanControlMs;
    const minLabel = (ms: number) => `${String(Math.round(ms / MINUTE))} min`;
    const ratioPct = Math.round(metrics.attentionRatio * 1000) / 10;

    const finalScreen: string[] = [
      '=================================================================',
      '           CONDUCTOR — RETURN TO WORK · DAY SUMMARY             ',
      '=================================================================',
      `${verdict} — ${finalExec.goal}`,
      `${minLabel(metrics.totalMs)} total · ${minLabel(metrics.autonomousMs)} autonomous · ${minLabel(humanMs)} human attention`,
      `${plural(metrics.decisionsCreated, 'decision')} · ${plural(metrics.takeovers, 'takeover')} · ${plural(unsafeActions, 'unsafe action')}`,
      `Human attention ratio: ${String(ratioPct)}%`,
      `Status: ${lang.label} — ${lang.meaning}`,
      `Decision quality: ${String(roll.resolved)} answered · median response ${roll.medianResponseMs != null ? formatDuration(roll.medianResponseMs) : '—'} · recurred ${String(roll.recurredCount)} · outcomes ${JSON.stringify(roll.outcomes)}`,
      '',
      ...renderAwaySummary(away).split('\n'),
      '',
      'Timeline (semantic):',
      ...timeline.map((e) => `  ${clock(e.at)}  ${e.tone === 'bad' ? '✗' : e.tone === 'warn' ? '!' : e.tone === 'ok' ? '✓' : '·'} ${e.text}${e.detail ? ` — ${e.detail}` : ''}`),
      '=================================================================',
    ];
    log('');
    for (const line of finalScreen) log(line);

    return {
      executionId: exec.id,
      goal: finalExec.goal,
      dbPath,
      storyBaseAt: base,
      storyEndAt: storyTs(DEMO_STORY.totalMin),
      totalMs: metrics.totalMs,
      autonomousMs: metrics.autonomousMs,
      humanMs,
      attentionRatio: metrics.attentionRatio,
      decisions: metrics.decisionsCreated,
      takeovers: metrics.takeovers,
      unsafeActions,
      timeline,
      finalScreen,
      decisionIds: { install: installDecision.id, force: forceDecision.id },
      facts: {
        failureAttentionLevels,
        decisionDeltaOnFailure,
        tokenFirst,
        tokenSecond,
        installSubject,
        forceSubject,
        finalStatus: metrics.status,
        eventCount: eventsFinal.length,
      },
    };
  } finally {
    db.close();
  }
}
