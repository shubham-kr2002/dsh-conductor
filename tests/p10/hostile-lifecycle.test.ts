/**
 * Phase-10 — hostile lifecycle sequences.
 *
 * #1   pause → turn-end(completed) → tool event → duplicate delivery of the
 *      ORIGINAL tool event (dedupe window) → resume
 * #1b  the same redelivery AFTER the run resumed (re-gating contract)
 * #5   a completed agent receiving a LATE dangerous candidate
 * #11  duplicate `policy.delegated` observations
 *
 * Everything asserted here is read back out of sqlite (rows, statuses,
 * aggregates) — never from log text.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { EventAdapter } from '../../src/adapter/event-adapter.js';
import {
  T,
  claimKind,
  cleanTmpDirs,
  dispatchTool,
  eventRows,
  fireTurnEnd,
  gateCommand,
  modelFrom,
  openRuntime,
  rowsFor,
  startAgent,
  statusOf,
  subjectOf,
  tmpDir,
} from './helpers.js';
import type { ConductorEvent } from '../../src/types/event.js';

after(() => cleanTmpDirs());

const payloadOf = (e: ConductorEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const eventsOfType = (rows: ConductorEvent[], type: string): ConductorEvent[] =>
  rows.filter((e) => e.type === type);

test(
  '#1 pause → turn-end → tool event → duplicate original tool event → resume: held through turn-end, dedupe absorbs the replay',
  { timeout: T.timeout },
  () => {
    const rt = openRuntime(join(tmpDir('s1'), 'conductor.sqlite'));
    try {
      const exec = startAgent(rt, 'alpha');

      // (a) the gate pauses the run and leaves ONE durable decision.
      const first = dispatchTool(rt, 'alpha', 'call-1', 'helm uninstall payments-prod');
      assert.equal(claimKind(first), 'deny', 'a gated tool call must be claimed');
      assert.equal(statusOf(rt, exec.id), 'PAUSED');
      const rows1 = rowsFor(rt, exec.id);
      assert.equal(rows1.length, 1, 'one decision per gated call');
      assert.equal(rows1[0]?.dedupeKey, `${exec.id}:call-1`, 'decision carries the call dedupeKey');
      assert.equal(rows1[0]?.subject, subjectOf('helm uninstall payments-prod'));
      assert.ok(rows1[0]?.sourceEventId, 'decision points at the event that caused it');
      assert.ok(rows1[0]?.why, 'decision carries its own explanation');

      // (b) a turn-end that says "completed" must NOT complete a held run.
      fireTurnEnd(rt);
      assert.equal(
        statusOf(rt, exec.id),
        'PAUSED',
        'turn-end while held is recorded, never auto-completes',
      );
      assert.equal(rowsFor(rt, exec.id).length, 1, 'the turn-end created no decision of its own');
      assert.equal(
        eventsOfType(eventRows(rt, exec.id), 'execution.completed').length,
        1,
        'the turn-end is still durable history',
      );
      assert.equal(
        rt.execRepo.findById(exec.id)!.transitions.filter((t) => t.to === 'PAUSED').length,
        1,
        'held exactly once so far — the turn-end and the held arrival added no transitions',
      );

      // (c) another gated action arrives while held: it is still queued for the
      // human (the run stays held either way), and it is NOT auto-answered.
      gateCommand(rt, exec.id, 'call-2', 'kubectl delete ns staging');
      assert.equal(statusOf(rt, exec.id), 'PAUSED');
      const rows2 = rowsFor(rt, exec.id);
      assert.equal(rows2.length, 2, 'the held arrival still queues its own judgment');
      assert.equal(rt.decisions.pending(exec.id).length, 2);

      // (d) DUPLICATE delivery of the ORIGINAL tool event (same ids, replayed):
      // the pending-window dedupeKey absorbs it — no extra decision, count stable.
      const originalEvents = EventAdapter.adaptToolCall(exec.id, {
        callId: 'call-1',
        name: 'bash',
        arguments: { command: 'helm uninstall payments-prod' },
      });
      const countBefore = rt.manager.getStatus(exec.id).pendingDecisionsCount;
      for (let i = 0; i < 4; i++) for (const evt of originalEvents) rt.manager.processEvent(evt);

      assert.equal(
        rowsFor(rt, exec.id).length,
        2,
        'redelivery of the same dedupeKey creates no extra decisions',
      );
      assert.equal(
        rt.manager.getStatus(exec.id).pendingDecisionsCount,
        countBefore,
        'decisionCount stays stable across duplicate deliveries',
      );
      // Event history is APPEND-ONLY per delivery (a redelivered call is a new
      // observation row), but re-delivering the very same event OBJECT never
      // duplicates its row — the id conflict is a no-op. Only the DECISIONS
      // are protected from multiplication, via dedupeKey.
      const callRows = (): number =>
        eventRows(rt, exec.id).filter((e) => e.type === 'tool.called' && payloadOf(e).callId === 'call-1')
          .length;
      assert.equal(callRows(), 2, 'the original delivery plus one replay-derived observation');
      rt.manager.processEvent(originalEvents[0] as ConductorEvent);
      rt.manager.processEvent(originalEvents[0] as ConductorEvent);
      assert.equal(callRows(), 2, 'replaying the same event object adds no row');
      assert.equal(rowsFor(rt, exec.id).length, 2, '…and no decision either');
      assert.equal(statusOf(rt, exec.id), 'PAUSED', 'still held, still exactly two judgments');

      // (e) resume only happens once the LAST pending judgment is resolved.
      rt.decisions.resolve(rows1[0]!.id, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(statusOf(rt, exec.id), 'PAUSED', 'one judgment left → still held');
      rt.decisions.resolve(rt.decisions.pending(exec.id)[0]!.id, 'rejected', {
        feedback: 'not this one',
      });
      assert.equal(statusOf(rt, exec.id), 'RUNNING', 'last judgment resolved → resumed');

      // (f) persisted aggregate truth survives the whole hostile sequence.
      const final = rt.execRepo.findById(exec.id)!;
      const finalRows = rowsFor(rt, exec.id);
      assert.equal(finalRows.length, 2);
      assert.equal(final.metrics.decisionCount, finalRows.length, 'decisionCount == rows');
      assert.deepEqual([...final.decisions].sort(), finalRows.map((d) => d.id).sort());
      assert.equal(
        final.transitions.filter((t) => t.to === 'PAUSED').length,
        1,
        'exactly one pause: turn-end, held arrival and replays added none',
      );
      assert.equal(
        final.transitions.filter((t) => t.to === 'RUNNING').length,
        2,
        'start + the resume after the last judgment',
      );
      assert.deepEqual(
        rt.decisionRepo.list({ status: 'pending', executionId: exec.id }).map((d) => d.id),
        [],
        'nothing is left pending after resume',
      );

      // the approved retry passes once through the bridge, then re-gates
      assert.equal(
        claimKind(dispatchTool(rt, 'alpha', 'call-1-retry', 'helm uninstall payments-prod')),
        'allow',
        'the approve-once token lets the identical action through',
      );
      assert.equal(statusOf(rt, exec.id), 'RUNNING', 'the retry did not re-pause the run');
      assert.equal(
        claimKind(dispatchTool(rt, 'alpha', 'call-1-retry-2', 'helm uninstall payments-prod')),
        'deny',
        'the token is one-shot: the next identical action is gated again',
      );
      assert.equal(statusOf(rt, exec.id), 'PAUSED', 'the spent token leaves the run held again');
      assert.equal(rowsFor(rt, exec.id).length, 3, 'and exactly one new judgment');
    } finally {
      rt.close();
    }
  },
);

test(
  '#1b a redelivered event whose decision was already resolved re-gates — exactly one new decision, never a silent allow',
  { timeout: T.timeout },
  () => {
    const rt = openRuntime(join(tmpDir('s1b'), 'conductor.sqlite'));
    try {
      const exec = startAgent(rt, 'alpha');
      dispatchTool(rt, 'alpha', 'call-9', 'terraform apply -auto-approve');
      const original = rowsFor(rt, exec.id)[0]!;
      assert.equal(original.status, 'pending');
      rt.decisions.resolve(original.id, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(statusOf(rt, exec.id), 'RUNNING');

      // The SAME tool event, delivered again after the run resumed.
      const replay = EventAdapter.adaptToolCall(exec.id, {
        callId: 'call-9',
        name: 'bash',
        arguments: { command: 'terraform apply -auto-approve' },
      });
      for (const evt of replay) rt.manager.processEvent(evt);

      // Fail-closed: the run is held again and gained exactly ONE decision —
      // tool.called and command.started share dedupeKey `${exec}:call-9`, so a
      // redelivery can never multiply into several judgments.
      assert.equal(statusOf(rt, exec.id), 'PAUSED', 'a redelivered gated action re-pauses');
      assert.equal(
        rowsFor(rt, exec.id).length,
        2,
        'the pending-window dedupe does not span resolutions (re-gating is intended)',
      );
      for (let i = 0; i < 5; i++) for (const evt of replay) rt.manager.processEvent(evt);
      assert.equal(rowsFor(rt, exec.id).length, 2, 'no runaway duplication');
      assert.equal(rt.decisionRepo.findById(original.id)!.status, 'accepted');
      assert.ok(rt.decisionRepo.findById(original.id)!.consumedAt == null, 'first verdict intact');
    } finally {
      rt.close();
    }
  },
);

test(
  '#5 completed agent then LATE dangerous candidates: no pause, no decision, nothing in the model',
  { timeout: T.timeout },
  () => {
    const rt = openRuntime(join(tmpDir('s5'), 'conductor.sqlite'));
    try {
      const exec = startAgent(rt, 'late');
      fireTurnEnd(rt);
      assert.equal(statusOf(rt, exec.id), 'COMPLETED');
      const eventsBefore = eventRows(rt, exec.id).length;
      assert.equal(rowsFor(rt, exec.id).length, 0);

      gateCommand(rt, exec.id, 'late-1', 'rm -rf /var/lib/data');
      gateCommand(rt, exec.id, 'late-2', 'kubectl delete ns production');

      assert.equal(statusOf(rt, exec.id), 'COMPLETED', 'a terminal run is never re-held');
      assert.equal(
        rowsFor(rt, exec.id).length,
        0,
        'a finished run queues no judgment — the human cannot be interrupted for it',
      );
      assert.ok(
        eventRows(rt, exec.id).length > eventsBefore,
        'the late observations are still durable history',
      );

      const model = modelFrom(rt, Date.now());
      assert.deepEqual(
        model.items.filter((i) => i.executionId === exec.id),
        [],
        'model.items has nothing for a finished agent',
      );
      assert.equal(model.map.working, 0);
      assert.equal(model.map.finished, 1);
      assert.equal(model.map.needsYou, 0);

      // The bridge cannot hold a finished run either: it answers the gate from
      // policy (deny) but leaves the terminal state and the decision rows alone.
      const decision = rt.bridge.preToolExecute({
        callId: 'late-3',
        name: 'bash',
        arguments: { command: 'git push --force origin main' },
        agentId: 'late',
      });
      assert.equal(claimKind(decision), 'deny', 'policy still refuses the dangerous action');
      assert.equal(statusOf(rt, exec.id), 'COMPLETED');
      assert.equal(rowsFor(rt, exec.id).length, 0);
      assert.equal(rt.execRepo.findById(exec.id)!.transitions.at(-1)!.to, 'COMPLETED');
    } finally {
      rt.close();
    }
  },
);

test(
  '#11 duplicate policy.delegated observations: forensics per observation, never a decision, covers() is a pure read',
  { timeout: T.timeout },
  () => {
    const rt = openRuntime(join(tmpDir('s11'), 'conductor.sqlite'));
    try {
      const exec = startAgent(rt, 'deleg');
      const grant = rt.delegations.grant(
        { scope: 'workspace', category: 'dependencies', grantedBy: 'dev' },
        Date.now(),
      );

      const pair = EventAdapter.adaptToolCall(exec.id, {
        callId: 'dup-1',
        name: 'bash',
        arguments: { command: 'pnpm add zod' },
      });
      const toolEvt = pair.find((e) => e.type === 'tool.called')!;
      const cmdEvt = pair.find((e) => e.type === 'command.started')!;

      // Replay the IDENTICAL event objects (same ids) three times.
      for (let i = 0; i < 3; i++) {
        rt.manager.processEvent(toolEvt);
        rt.manager.processEvent(cmdEvt);
      }

      const rows = eventRows(rt, exec.id);
      const delegated = eventsOfType(rows, 'policy.delegated');
      assert.ok(delegated.length >= 1, 'each covered observation leaves a forensic row');
      assert.equal(
        delegated.length,
        6,
        'one policy.delegated per PAUSE-worthy observation (3 × tool.called + 3 × command.started)',
      );
      assert.equal(eventsOfType(rows, 'tool.called').length, 1, 'source event inserted once');
      assert.equal(eventsOfType(rows, 'command.started').length, 1);
      assert.equal(rowsFor(rt, exec.id).length, 0, 'a delegated action never creates a decision');
      assert.equal(rt.decisions.pending(exec.id).length, 0);
      assert.equal(statusOf(rt, exec.id), 'RUNNING', 'delegation never holds the run');
      for (const f of delegated) {
        const p = payloadOf(f);
        assert.equal(p.delegationId, grant.id, 'forensics name the delegation that allowed it');
        assert.equal(p.grantedBy, 'dev');
        assert.equal(p.category, 'dependencies');
        assert.equal(p.command, 'pnpm add zod');
      }

      // covers() is a pure read: N calls, no state change, same answer.
      const probe = (): boolean =>
        rt.delegations.covers({
          executionId: exec.id,
          category: 'dependencies',
          resource: 'pnpm add zod',
          subject: subjectOf('pnpm add zod'),
          now: Date.now(),
        }) !== null;
      assert.deepEqual([probe(), probe(), probe()], [true, true, true]);
      assert.equal(rt.delegationRepo.listAll().length, 1, 'no extra delegation rows');
      assert.equal(rt.delegations.list({ active: true }).length, 1);
      assert.equal(eventsOfType(eventRows(rt, exec.id), 'policy.delegated').length, 6);
      assert.equal(rowsFor(rt, exec.id).length, 0);

      // …and the bridge agrees: a covered call is allowed (undefined = dispatch).
      assert.equal(claimKind(dispatchTool(rt, 'deleg', 'dup-2', 'pnpm add zod')), 'allow');
      assert.equal(rowsFor(rt, exec.id).length, 0);
      assert.equal(rt.delegationRepo.listAll().length, 1);
    } finally {
      rt.close();
    }
  },
);
