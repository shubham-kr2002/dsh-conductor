/**
 * Phase 10 — CLI parity (end-to-end over a real file-backed control plane)
 *
 * Exercises the new `conductor attention / delegate / delegations` commands
 * as a real subprocess against the same SQLite file the runtime writes:
 * cockpit text + --json contract, delegation grant → covered gate creates
 * NO decision, non-interruption explanation, revoke → interrupts again,
 * recurrence offers, and the derived history (INTERRUPTED / DELEGATED /
 * RECURRING).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime, type ConductorRuntime } from '../../src/cli/commands.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';

const BIN = join(process.cwd(), 'dist-cli', 'src', 'cli', 'bin.js');
const DB = join(process.cwd(), 'tests', '.tmp-cli10-attention.db');

function cli(args: string[]): string {
  return execFileSync(process.execPath, [BIN, '--db', DB, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CONDUCTOR_DB_PATH: DB },
  });
}

function cliFails(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [BIN, '--db', DB, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CONDUCTOR_DB_PATH: DB },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 0, stderr: String(e.stderr ?? '') };
  }
  assert.fail(`expected non-zero exit for: conductor ${args.join(' ')}`);
}

function gate(rt: ConductorRuntime, executionId: string, callId: string, command: string): void {
  for (const evt of EventAdapter.adaptToolCall(executionId, { callId, name: 'bash', arguments: { command } })) {
    rt.manager.processEvent(evt);
  }
}

function cleanupDb(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${DB}${suffix}`, { force: true, maxRetries: 5 });
  }
}

describe('conductor attention / delegate / delegations (Phase 10 CLI)', () => {
  test('full parity scenario over a shared file control plane', { timeout: 120_000 }, () => {
    cleanupDb();
    const rt = createRuntime(DB);
    try {
      // --- scenario: two agents, one critical + one major interruption ----
      const a = rt.manager.createExecution({ goal: 'payments migration', workspaceRoot: '/srv', agent: { id: 'atlas' } });
      a.start();
      rt.execRepo.save(a);
      const b = rt.manager.createExecution({ goal: 'api refactor', workspaceRoot: '/srv', agent: { id: 'hera' } });
      b.start();
      rt.execRepo.save(b);

      gate(rt, a.id, 'a1', 'git push --force origin main'); // critical
      gate(rt, b.id, 'b1', 'pnpm add zod'); // major interrupt
      rt.manager.markAway(b.id);

      const critical = rt.decisionRepo.list({ status: 'pending' }).find((d) => d.impact === 'critical')!;
      const major = rt.decisionRepo.list({ status: 'pending' }).find((d) => d.impact === 'major')!;
      assert.ok(critical && major, 'both gates created decisions');

      // --- 1. cockpit text -------------------------------------------------
      const text = cli(['attention']);
      assert.match(text, /NEEDS YOU/);
      assert.match(text, /2 agents · 1 needs you/);
      assert.match(text, /attention load HIGH/);
      assert.ok(
        text.indexOf('git push --force') < text.indexOf('pnpm add zod'),
        'critical is shown before the deferred major',
      );
      assert.ok(text.indexOf('git push --force') < text.indexOf('NEEDS YOU') + text.length);
      assert.match(text, /WAITING/);
      assert.match(text, /WORKING/);
      assert.match(text, /\(delegation|decision dec-/, 'decision ids shown for actions');

      // --- 2. --json contract ----------------------------------------------
      const j = JSON.parse(cli(['attention', '--json']));
      assert.deepEqual(Object.keys(j).sort(), ['budgetDemoted', 'items', 'map']);
      assert.equal(j.map.needsYou, 1);
      assert.match(j.items[0].id, /^cand:decision:/);
      assert.deepEqual(j.items[0].refIds, [critical.id], 'critical item leads');
      assert.ok(Array.isArray(j.budgetDemoted));

      // --- 3. delegate command grants; ledger lists it ----------------------
      const grantOut = cli(['delegate', 'dependencies', '--by', 'shubham']);
      const dlId = /id:\s+(dl-\S+)/.exec(grantOut)?.[1];
      assert.ok(dlId, `grant confirmation missing id:\n${grantOut}`);
      const ledger = cli(['delegations']);
      assert.ok(ledger.includes(dlId!));
      assert.match(ledger, /\[active\]/);
      assert.match(ledger, /dependencies/);

      // --- 4. gated dependency command now creates NO decision --------------
      const pendingBefore = rt.decisionRepo.list({ status: 'pending' }).length;
      gate(rt, b.id, 'b2', 'pnpm add ioredis@5');
      assert.equal(rt.decisionRepo.list({ status: 'pending' }).length, pendingBefore, 'covered action did not interrupt');
      assert.equal(rt.execRepo.findById(b.id)!.status, 'PAUSED', 'the earlier interruption still holds the run');
      const delegatedEvents = rt.eventRepo
        .listByExecution(b.id, {})
        .filter((e) => e.type === 'policy.delegated');
      assert.ok(delegatedEvents.length >= 1, 'forensic delegation rows exist');
      const dlEvent = delegatedEvents[0]!;
      assert.equal((dlEvent.payload as Record<string, unknown>).delegationId, dlId);

      // --- 5. history shows the DELEGATED row --------------------------------
      const histText = cli(['attention', '--history']);
      assert.match(histText, /DELEGATED/);
      assert.ok(histText.includes('pnpm add ioredis@5'), 'the delegated command appears in history');
      assert.match(histText, /category: dependencies · delegation dl-/, 'history cites category and delegation');

      // --- 6. --why <eventId> explains the NON-interruption ------------------
      const whyEvent = cli(['attention', '--why', dlEvent.id]);
      assert.match(whyEvent, /WHY THIS DID NOT INTERRUPT YOU/);
      assert.match(whyEvent, /you delegated/);
      assert.match(whyEvent, /attention saved: not measured/);

      // --- 7. --why <decisionId> = seven-field why + priority facts ----------
      const whyDecision = cli(['attention', '--why', critical.id]);
      assert.match(whyDecision, /Why this interrupts you:/);
      assert.match(whyDecision, /REVERSIBILITY/);
      assert.match(whyDecision, /Why it is ranked here now:/);
      assert.match(whyDecision, /Consequence\s+CRITICAL/);

      // --- 8. revoke → the next dependency gate interrupts again --------------
      const revokeOut = cli(['delegations', '--revoke', dlId!, '--by', 'shubham']);
      assert.match(revokeOut, /Revoked delegation/);
      assert.match(cli(['delegations', '--all']), /\[revoked\]/);
      gate(rt, b.id, 'b3', 'pnpm add left-pad');
      assert.equal(rt.decisionRepo.list({ status: 'pending' }).length, pendingBefore + 1, 'revoked: interrupts again');

      // --- 9. accept both dependency decisions → recurrence offer ------------
      for (const d of rt.decisionRepo.list({ status: 'pending' })) {
        if (/pnpm add (zod|ioredis|left-pad)/.test(String(d.subject ?? ''))) {
          rt.decisions.resolve(d.id, 'accepted', { answerBy: 'dev' });
        }
      }
      const suggest = cli(['delegations', '--suggest']);
      assert.match(suggest, /DELEGATION OFFERS/);
      assert.match(suggest, /dependencies — 2 accepted/);
      assert.match(suggest, /grant with: conductor delegate dependencies/);
      assert.match(suggest, /OFFERS ONLY/);
      assert.equal(rt.delegations.list({ active: true }).length, 0, 'offers grant nothing');

      // --- 10. same subject twice → history shows INTERRUPTED + RECURRING ----
      gate(rt, b.id, 'b4', 'pnpm add left-pad'); // same subject again
      const hist2 = cli(['attention', '--history', '--json']);
      const h = JSON.parse(hist2);
      assert.ok(h.interrupted.some((i: { outcome: string }) => i.outcome === 'answered'), 'answered rows in history');
      assert.ok(
        h.recurringSubjects.some((r: { subject: string; count: number }) => r.subject === 'bash:pnpm add left-pad' && r.count === 2),
        'recurring subject traced',
      );
      assert.deepEqual(h.categories.dependencies, { accepted: 2, rejected: 0, pending: 1 });
      assert.ok(h.totals.decisions >= 4 && h.totals.autonomousActions >= 2);
      const histText2 = cli(['attention', '--history']);
      assert.match(histText2, /INTERRUPTED YOU\n  •/);
      assert.match(histText2, /bash:pnpm add left-pad ×2/);

      // --- 11. --since window + per-execution view + limit -------------------
      const sinceText = cli(['attention', '--history', '--since', '5']);
      assert.match(sinceText, /window: /);
      const oneExec = JSON.parse(cli(['attention', a.id, '--json']));
      assert.equal(oneExec.map.agents, 1);
      assert.match(cli(['attention', '--limit', '1']), /NEEDS YOU/);

      // --- 12. invalid category exits 1 and lists valid ones ------------------
      const bad = cliFails(['delegate', 'nonsense']);
      assert.equal(bad.status, 1);
      assert.ok(bad.stderr.includes('dependencies'));
      assert.ok(bad.stderr.includes('production_resources'));
    } finally {
      rt.db.close();
      cleanupDb();
    }
  });
});
