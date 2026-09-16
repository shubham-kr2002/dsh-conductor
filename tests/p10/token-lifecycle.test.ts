/**
 * Phase-10 — approval-token lifecycle and delegation authority.
 *
 * #3   a spent token must never authorize a second action
 * #6   denial → retry → re-gate → second denial keeps holding
 * #7   an explicit denial outranks a standing delegation; an explicit later
 *      acceptance restores it
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  T,
  claimKind,
  cleanTmpDirs,
  dispatchTool,
  eventRows,
  gateCommand,
  openRuntime,
  rowsFor,
  startAgent,
  statusOf,
  subjectOf,
  tmpDir,
} from './helpers.js';

after(() => cleanTmpDirs());

const eventsOfType = (rt: ReturnType<typeof openRuntime>, id: string, type: string): number =>
  eventRows(rt, id).filter((e) => e.type === type).length;

test(
  '#3 one approval buys exactly one retry: re-gated afterwards, approve again, never leaks',
  { timeout: T.timeout },
  () => {
    const rt = openRuntime(join(tmpDir('s3'), 'conductor.sqlite'));
    try {
      const exec = startAgent(rt, 'spend');
      const command = 'kubectl delete ns reporting';
      const subject = subjectOf(command);

      // Gate 1: held + one durable judgment.
      assert.equal(claimKind(dispatchTool(rt, 'spend', 's-1', command)), 'deny');
      assert.equal(statusOf(rt, exec.id), 'PAUSED');
      const d1 = rowsFor(rt, exec.id)[0]!;
      assert.equal(d1.status, 'pending');
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false, 'unapproved: no token');

      // Human approves once.
      rt.decisions.resolve(d1.id, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(statusOf(rt, exec.id), 'RUNNING');

      // Retry of the identical action passes — and spends the token.
      assert.equal(claimKind(dispatchTool(rt, 'spend', 's-2', command)), 'allow', 'retry passes');
      assert.ok(rt.decisionRepo.findById(d1.id)!.consumedAt != null, 'token stamped spent');
      assert.equal(statusOf(rt, exec.id), 'RUNNING', 'the approved retry never re-pauses');
      assert.equal(rowsFor(rt, exec.id).length, 1, 'and is not re-observed as a new judgment');

      // Same command again: re-gated from scratch.
      assert.equal(claimKind(dispatchTool(rt, 'spend', 's-3', command)), 'deny', 're-gated');
      assert.equal(statusOf(rt, exec.id), 'PAUSED');
      const rows2 = rowsFor(rt, exec.id);
      assert.equal(rows2.length, 2, 'a NEW pending decision, not a reuse of the spent one');
      assert.equal(rows2[1]!.status, 'pending');
      assert.notEqual(rows2[1]!.id, d1.id, 'a distinct row, not the spent one re-opened');
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false, 'nothing left to spend');

      // Approve again → exactly one more pass, then gated again.
      rt.decisions.resolve(rows2[1]!.id, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(statusOf(rt, exec.id), 'RUNNING');
      assert.equal(claimKind(dispatchTool(rt, 'spend', 's-4', command)), 'allow');
      assert.equal(claimKind(dispatchTool(rt, 'spend', 's-5', command)), 'deny', 'still one-shot');
      assert.equal(statusOf(rt, exec.id), 'PAUSED');

      // Never leaks: a different action is gated too, and both tokens are spent.
      assert.equal(claimKind(dispatchTool(rt, 'spend', 's-6', 'terraform apply')), 'deny');
      const all = rowsFor(rt, exec.id);
      assert.equal(all.filter((d) => d.consumedAt != null).length, 2, 'exactly two tokens ever spent');
      assert.equal(all.filter((d) => d.status === 'pending').length, 1, 'the terraform gate is the only open question');
      assert.equal(
        all.filter((d) => d.status === 'accepted').length,
        2,
        'a third approval was granted but never used — it grants nothing to a different action',
      );
      assert.equal(
        rt.execRepo.findById(exec.id)!.metrics.decisionCount,
        all.length,
        'aggregate == rows',
      );
    } finally {
      rt.close();
    }
  },
);

test(
  '#6 denied → retry → re-gate → second denial keeps holding, even against a standing delegation',
  { timeout: T.timeout },
  () => {
    const rt = openRuntime(join(tmpDir('s6'), 'conductor.sqlite'));
    try {
      const exec = startAgent(rt, 'deny');
      const command = 'rm -rf ~';
      const subject = subjectOf(command);

      // 1st attempt (no delegation yet) → gated.
      assert.equal(claimKind(dispatchTool(rt, 'deny', 'd-1', command)), 'deny');
      assert.equal(statusOf(rt, exec.id), 'PAUSED');
      const d1 = rowsFor(rt, exec.id)[0]!;
      assert.equal(d1.status, 'pending');
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false, 'unanswered mints nothing');

      // The human grants a standing shell delegation… and then denies THIS one.
      rt.delegations.grant({ scope: 'workspace', category: 'shell', grantedBy: 'dev' }, Date.now());
      rt.decisions.resolve(d1.id, 'rejected', { feedback: 'never blow up home' });
      assert.equal(statusOf(rt, exec.id), 'RUNNING', 'a denial releases the hold, it does not freeze it');
      assert.equal(
        rt.delegations.covers({
          executionId: exec.id,
          category: 'shell',
          resource: command,
          subject,
          now: Date.now(),
        }),
        null,
        'the explicit denial outranks the delegation',
      );

      // 2nd attempt (identical command, fresh call) → denied and held again.
      assert.equal(claimKind(dispatchTool(rt, 'deny', 'd-2', command)), 'deny');
      assert.equal(statusOf(rt, exec.id), 'PAUSED', 'and it keeps holding');
      const d2 = rt.decisions.pending(rt.execRepo.findById(exec.id)!.id)[0]!;
      assert.equal(d2.subject, subject, 'same subject, brand-new judgment');
      assert.notEqual(d2.id, d1.id);
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false, 'denial mints no token');

      // While held, every other action is refused too — and records nothing new.
      assert.equal(claimKind(dispatchTool(rt, 'deny', 'd-2b', 'git status')), 'deny', 'held blocks all');
      assert.equal(rowsFor(rt, exec.id).length, 2, 'the held refusals created no extra judgments');
      assert.equal(eventsOfType(rt, exec.id, 'policy.delegated'), 0, 'nothing slipped through as delegated');

      rt.decisions.resolve(d2.id, 'rejected');
      assert.equal(statusOf(rt, exec.id), 'RUNNING');

      // 3rd attempt → gated a third time; two denials, still zero tokens.
      assert.equal(claimKind(dispatchTool(rt, 'deny', 'd-3', command)), 'deny');
      const rows = rowsFor(rt, exec.id);
      assert.equal(rows.length, 3);
      assert.equal(rows.filter((d) => d.status === 'pending').length, 1);
      assert.equal(rows.filter((d) => d.status === 'rejected').length, 2);
      for (const d of rows) assert.equal(d.consumedAt ?? null, null, 'no denial was ever spent');
      assert.equal(rt.decisions.consumeApproval(exec.id, subject), false);
      assert.equal(
        rt.delegations.covers({
          executionId: exec.id,
          category: 'shell',
          resource: command,
          subject,
          now: Date.now(),
        }),
        null,
        'the denial is still the newest verdict — the delegation stays shadowed',
      );

      // Aggregate truth.
      const agg = rt.execRepo.findById(exec.id)!;
      assert.equal(agg.metrics.decisionCount, rows.length);
      assert.deepEqual([...agg.decisions].sort(), rows.map((d) => d.id).sort());
      assert.equal(agg.transitions.filter((t) => t.to === 'PAUSED').length, 3, 'held three times');
    } finally {
      rt.close();
    }
  },
);

test(
  '#7 standing delegation, explicit denial, then explicit acceptance: authority follows the newest human verdict',
  { timeout: T.timeout },
  () => {
    const rt = openRuntime(join(tmpDir('s7'), 'conductor.sqlite'));
    try {
      const exec = startAgent(rt, 'shadow');
      const command = 'kubectl delete ns staging';
      const subject = subjectOf(command);

      // No delegation yet: gated.
      assert.equal(claimKind(dispatchTool(rt, 'shadow', 'p-1', command)), 'deny');
      const d1 = rowsFor(rt, exec.id)[0]!;

      // Human grants the category, then explicitly denies THIS action.
      rt.delegations.grant({ scope: 'workspace', category: 'deployment', grantedBy: 'dev' }, Date.now());
      rt.decisions.resolve(d1.id, 'rejected', { feedback: 'not in this namespace' });
      assert.equal(statusOf(rt, exec.id), 'RUNNING');

      // Denial newer than the grant → the delegation is shadowed.
      assert.equal(
        rt.delegations.covers({
          executionId: exec.id,
          category: 'deployment',
          resource: command,
          subject,
          now: Date.now(),
        }),
        null,
        'covers() is null while a newer explicit denial stands',
      );
      // …so the bridge denies DESPITE the delegation row being active.
      assert.equal(rt.delegationRepo.listAll().length, 1);
      assert.equal(rt.delegations.list({ active: true }).length, 1);
      assert.equal(claimKind(dispatchTool(rt, 'shadow', 'p-2', command)), 'deny');
      assert.equal(statusOf(rt, exec.id), 'PAUSED');
      const d2 = rt.decisions.pending(exec.id)[0]!;
      assert.equal(d2.subject, subject);
      assert.equal(eventsOfType(rt, exec.id, 'policy.delegated'), 0, 'no forensic allow was written');

      // An explicit LATER acceptance clears the shadow.
      rt.decisions.resolve(d2.id, 'accepted', { selectedOptionId: 'approve-once' });
      assert.equal(statusOf(rt, exec.id), 'RUNNING');
      assert.ok(
        rt.delegations.covers({
          executionId: exec.id,
          category: 'deployment',
          resource: command,
          subject,
          now: Date.now(),
        }),
        'the acceptance is now the newest verdict → delegation applies again',
      );

      // The acceptance ALSO carried a one-time token; spend it, then prove the
      // allow now comes from the delegation rather than from a token.
      assert.equal(claimKind(dispatchTool(rt, 'shadow', 'p-3', command)), 'allow', 'token pass');
      assert.equal(
        rt.decisionRepo.findById(d2.id)!.consumedAt != null,
        true,
        'the token is spent',
      );
      assert.equal(
        rt.decisions.consumeApproval(exec.id, subject),
        false,
        'no unspent approval remains',
      );
      assert.equal(claimKind(dispatchTool(rt, 'shadow', 'p-4', command)), 'allow', 'delegation pass');
      assert.equal(statusOf(rt, exec.id), 'RUNNING');
      assert.ok(eventsOfType(rt, exec.id, 'policy.delegated') >= 1, 'delegated pass is forensic');

      // Revoke → the gate closes again (and the previous acceptance still
      // cannot authorize anything new).
      const grant = rt.delegationRepo.listAll()[0]!;
      rt.delegations.revoke(grant.id, 'dev', Date.now() + 1);
      assert.equal(
        rt.delegations.covers({
          executionId: exec.id,
          category: 'deployment',
          resource: command,
          subject,
          now: Date.now() + 2,
        }),
        null,
        'revocation ends the authority',
      );
      assert.equal(claimKind(dispatchTool(rt, 'shadow', 'p-5', command)), 'deny');
      assert.equal(statusOf(rt, exec.id), 'PAUSED');

      // Durable ledger: 3 gated judgments, 1 delegated pass recorded, and the
      // pending one is exactly what the human still owes.
      const rows = rowsFor(rt, exec.id);
      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((d) => d.status),
        ['rejected', 'accepted', 'pending'],
      );
      assert.equal(rt.execRepo.findById(exec.id)!.metrics.decisionCount, 3);
    } finally {
      rt.close();
    }
  },
);
