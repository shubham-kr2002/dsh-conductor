/**
 * Phase-10 — fleet attention under load.
 *
 * #4   five agents, ten gates, mixed categories (deployment / dependencies /
 *      questions), one agent flooding: the built model must be deterministic,
 *      respect the needs-you slot, never spend more than one interrupt on the
 *      flooding agent, and lead each agent with its own highest-consequence
 *      judgment.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { compareAttention } from '../../src/attention/attention-priority.js';
import {
  T,
  claimKind,
  cleanTmpDirs,
  dispatchTool,
  gateCommand,
  modelFrom,
  openRuntime,
  orderDeviations,
  rowsFor,
  startAgent,
  statusOf,
  tmpDir,
} from './helpers.js';
import type { AttentionCandidate } from '../../src/attention/attention-candidate.js';

after(() => cleanTmpDirs());

const RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

const fingerprint = (items: AttentionCandidate[]): string[] =>
  items.map(
    (i) =>
      [
        i.id,
        i.kind,
        i.category,
        i.disposition,
        i.factors.consequence,
        i.factors.urgency,
        i.factors.blocking ? 'B' : '-',
        i.executionId,
        i.refIds.join('+'),
      ].join('|'),
  );

/**
 * Build the fleet. The BRIDGE gates the first action of each agent (that is
 * what DSH actually calls); later actions arrive on the observation path the
 * session log uses, because a held run is refused by the bridge *without*
 * being re-observed — which is precisely why "already held" arrivals are fed
 * through the manager. Both paths write the same durable rows.
 */
function fleet(dbPath: string): {
  rt: ReturnType<typeof openRuntime>;
  execIds: Record<string, string>;
  now: number;
} {
  const rt = openRuntime(dbPath);
  const execIds: Record<string, string> = {};
  for (const agent of ['infra', 'deps', 'risky', 'flooder', 'asker']) {
    execIds[agent] = startAgent(rt, agent, `ship ${agent} slice`).id;
  }
  const ask = (agent: string, id: string, question: string): void => {
    rt.host.askQuestion({ questions: [{ id, question }], agentId: agent });
  };
  // ten gates + two questions, deliberately interleaved so nothing is created
  // in "already sorted" order.
  dispatchTool(rt, 'infra', 'f-infra-1', 'helm uninstall payments-prod');
  dispatchTool(rt, 'deps', 'f-deps-1', 'pnpm add zod');
  dispatchTool(rt, 'risky', 'f-risky-1', 'git push --force origin main');
  ask('asker', 'f-ask-1', 'Charge the customer card on file for the migration?');
  gateCommand(rt, execIds.infra!, 'f-infra-2', 'kubectl delete ns staging');
  dispatchTool(rt, 'flooder', 'f-flood-1', 'pnpm add left-pad');
  gateCommand(rt, execIds.risky!, 'f-risky-2', 'rm -rf /var/lib/data');
  gateCommand(rt, execIds.flooder!, 'f-flood-2', 'pnpm add dayjs');
  ask('asker', 'f-ask-2', 'Delete the customer records table before the backfill?');
  gateCommand(rt, execIds.deps!, 'f-deps-2', 'pnpm add -D tsx');
  gateCommand(rt, execIds.infra!, 'f-infra-3', 'terraform apply -auto-approve');
  gateCommand(rt, execIds.flooder!, 'f-flood-3', 'pnpm add lodash');
  return { rt, execIds, now: 1_800_000_000_000 };
}

test(
  '#4a ten gates across five agents: the model is deterministic and ordered identically twice',
  { timeout: T.timeout },
  () => {
    const { rt, execIds, now } = fleet(join(tmpDir('s4'), 'conductor.sqlite'));
    try {
      // Durable preconditions.
      const rows = rt.decisionRepo.list({});
      assert.equal(rows.length, 12, 'ten gates + two questions, all durable');
      assert.equal(rows.filter((r) => r.subject === undefined).length, 2, 'two are questions');
      assert.equal(
        new Set(rows.map((r) => r.id)).size,
        12,
        'no duplicate decision ids',
      );
      for (const id of Object.values(execIds)) {
        assert.equal(statusOf(rt, id), 'PAUSED', `${id} is held by its own judgment`);
      }

      const first = modelFrom(rt, now);
      const second = modelFrom(rt, now);
      assert.deepEqual(fingerprint(second.items), fingerprint(first.items), 'byte-identical ordering');
      assert.deepEqual(second.map, first.map);
      assert.equal(second.generatedAt, now);
      assert.deepEqual(
        second.budgetDemoted,
        first.budgetDemoted,
        'the same items are demoted every time',
      );

      // Ordering honours compareAttention (allowing only the documented
      // interrupt→queue demotion the budget pass applies after sorting).
      assert.deepEqual(
        orderDeviations(first.items, now, first.budgetDemoted),
        [],
        `items are attention-ordered: ${JSON.stringify(first.items.map((i) => i.id))}`,
      );
      const cmp = compareAttention(now);
      for (let i = 1; i < first.items.length; i++) {
        assert.ok(cmp(first.items[i - 1]!, first.items[i]!) <= 0, `position ${String(i)}`);
      }
    } finally {
      rt.close();
    }
  },
);

test(
  '#4b consequences lead: the critical push outranks deployment and dependencies',
  { timeout: T.timeout },
  () => {
    const { rt, now } = fleet(join(tmpDir('s4b'), 'conductor.sqlite'));
    try {
      const model = modelFrom(rt, now);
      const lead = model.items[0]!;
      assert.equal(lead.factors.consequence, 'critical', 'the most consequential item leads the fleet');
      assert.equal(lead.disposition, 'critical');
      assert.ok(
        /rm -rf|git push --force/.test(lead.title),
        `lead is one of the two irreversible gates: ${lead.title}`,
      );

      // Impact tiers as the policy actually rates them (persisted on the rows).
      const byTitle = new Map(rt.decisionRepo.list({}).map((d) => [d.title, d]));
      const helm = byTitle.get('Consequential command `helm uninstall payments-prod`');
      assert.ok(helm, 'helm gate exists');
      assert.equal(helm!.impact, 'major', 'require_approval ⇒ major (a standing policy, not a hard deny)');
      assert.equal(helm!.urgency, 'high');
      assert.ok(
        helm!.why?.evidence.ruleIds.includes('require-approval-deployment'),
        `the decision names the rule that fired: ${JSON.stringify(helm!.why?.evidence.ruleIds)}`,
      );
      assert.equal(helm!.why?.evidence.blastRadius, 'infrastructure', 'helm reaches the cluster');
      const pnpm = byTitle.get('Consequential command `pnpm add zod`');
      assert.ok(pnpm);
      assert.equal(pnpm!.impact, 'major');
      assert.ok(
        pnpm!.why?.evidence.ruleIds.includes('require-approval-dependency-install'),
        `dependency rule fired: ${JSON.stringify(pnpm!.why?.evidence.ruleIds)}`,
      );
      const force = byTitle.get('Dangerous command `git push --force origin main`');
      assert.ok(force);
      assert.equal(force!.impact, 'critical', 'a destructive publish is the critical tier');
      assert.ok(force!.why?.evidence.ruleIds.includes('require-approval-git-force'));
      assert.equal(force!.urgency, 'critical');

      // Questions are their own category and never impersonate approvals.
      // One agent's two questions share the generic title, but they are
      // DISTINCT durable rows — after the P10 dedupe fix they render as two
      // individually resolvable cards (merging them would hide the second
      // judgment behind the first card's actions).
      const questions = model.items.filter((i) => i.category === 'question');
      assert.equal(questions.length, 2, 'the asker gets one card per question');
      const questionRows = rt.decisionRepo.list({}).filter((d) => d.subject === undefined);
      assert.equal(questionRows.length, 2);
      assert.deepEqual(
        questions.flatMap((q) => q.refIds).sort(),
        questionRows.map((d) => d.id).sort(),
        'both question decisions are covered, each by its own card',
      );
      assert.ok(questions[0]!.title, 'the question card is titled');
      const approvalCats = model.items.filter((i) => i.category === 'approval');
      assert.equal(approvalCats.length, 10, 'every approval gate keeps its own card');
      assert.equal(model.items.length, 12);

      // No item is orphaned: every one points at real durable rows.
      const rowIds = new Set(rt.decisionRepo.list({}).map((d) => d.id));
      for (const i of model.items) {
        assert.ok(i.refIds.length > 0, `${i.id} references something`);
        for (const r of i.refIds) assert.ok(rowIds.has(r), `${i.id} → ${r} exists`);
      }
    } finally {
      rt.close();
    }
  },
);

test(
  '#4c the needs-you slot is respected, and one flooding agent cannot buy more than one interrupt',
  { timeout: T.timeout },
  () => {
    const { rt, execIds, now } = fleet(join(tmpDir('s4c'), 'conductor.sqlite'));
    try {
      const model = modelFrom(rt, now);
      const criticals = model.items.filter((i) => i.disposition === 'critical');
      const interrupts = model.items.filter((i) => i.disposition === 'interrupt');
      assert.ok(criticals.length >= 1, 'criticals exist in this fleet');
      assert.equal(interrupts.length, 0, 'a critical item owns the front row alone');
      assert.equal(model.map.needsYou, criticals.length, 'needs-you == criticals + interrupts');
      assert.ok(model.map.needsYou <= 1 + criticals.length);
      assert.equal(model.items.length, 12, 'twelve judgments, twelve cards — merging nothing away');
      assert.equal(model.budgetDemoted.length, 10, 'everything else was demoted, visibly');
      assert.equal(model.map.waiting, 10);
      for (const id of model.budgetDemoted) {
        const item = model.items.find((i) => i.id === id)!;
        assert.equal(item.disposition, 'queue', 'a demoted item is queued, never hidden');
        assert.ok(item.whyWaiting, 'and it explains why it waits');
      }

      // The flooding agent owns three judgments but buys at most one interrupt.
      const flood = model.items.filter((i) => i.executionId === execIds.flooder);
      assert.equal(flood.length, 3, 'all three floods are visible (nothing dropped)');
      assert.equal(flood.filter((i) => i.disposition === 'interrupt').length, 0);
      for (const i of flood) assert.equal(i.factors.blocking, true, 'the flood still holds its run');

      // Every agent is led by its own highest-consequence item.
      const byExec = new Map<string, AttentionCandidate[]>();
      for (const i of model.items) {
        const list = byExec.get(i.executionId) ?? [];
        list.push(i);
        byExec.set(i.executionId, list);
      }
      assert.equal(byExec.size, 5, 'five agents on one surface');
      const cmp = compareAttention(now);
      for (const [execId, list] of byExec) {
        const leader = list[0]!;
        for (const other of list.slice(1)) {
          assert.ok(
            RANK[leader.factors.consequence] >= RANK[other.factors.consequence],
            `${execId}: leader ${leader.factors.consequence} should not trail ${other.factors.consequence}`,
          );
          assert.ok(cmp(leader, other) <= 0, `${execId}: leader must be its own top item`);
        }
      }
      assert.equal(model.map.agents, 5);
      assert.equal(model.map.working, 0, 'nothing is unheld while ten judgments wait');
      assert.equal(model.map.waiting, model.items.length - model.map.needsYou);
    } finally {
      rt.close();
    }
  },
);

test(
  '#4d clearing an agent judgment changes only that agent: the next item of the same run leads',
  { timeout: T.timeout },
  () => {
    const { rt, execIds, now } = fleet(join(tmpDir('s4d'), 'conductor.sqlite'));
    try {
      const before = modelFrom(rt, now);
      const infraRows = rt.decisionRepo.list({ executionId: execIds.infra });
      assert.equal(infraRows.length, 3);

      // Resolve the infra agent's top item first — the model must move to the
      // next-most-consequential item of the SAME run, not shuffle others.
      const infraItems = before.items.filter((i) => i.executionId === execIds.infra);
      const top = infraItems[0]!;
      const topId = top.refIds[0]!;
      rt.decisions.resolve(topId, 'rejected');

      const after = modelFrom(rt, now);
      assert.equal(after.items.length, before.items.length - 1, 'one judgment left the surface');
      const stillInfra = after.items.filter((i) => i.executionId === execIds.infra);
      assert.equal(stillInfra.length, 2);
      assert.ok(!stillInfra.some((i) => i.refIds.includes(topId)), 'the resolved one is gone');
      assert.ok(
        RANK[stillInfra[0]!.factors.consequence] >= RANK[stillInfra[1]!.factors.consequence],
        'the next-worst infra gate now leads that agent',
      );
      // Other agents keep their relative order and count.
      for (const agent of ['deps', 'risky', 'flooder', 'asker'] as const) {
        const b = before.items.filter((i) => i.executionId === execIds[agent]).map((i) => i.id);
        const a = after.items.filter((i) => i.executionId === execIds[agent]).map((i) => i.id);
        assert.deepEqual(a, b, `${agent} untouched`);
      }
      assert.equal(statusOf(rt, execIds.infra!), 'PAUSED', 'two judgments still hold it');
      for (const id of rt.decisionRepo.list({ executionId: execIds.infra }).map((d) => d.id)) {
        if (id !== topId) rt.decisions.resolve(id, 'accepted');
      }
      assert.equal(statusOf(rt, execIds.infra!), 'RUNNING', 'clearing them frees the run');
      assert.equal(modelFrom(rt, now).map.finished, 0);
      assert.equal(modelFrom(rt, now).map.working, 1);
    } finally {
      rt.close();
    }
  },
);

test(
  '#4e with no critical item the whole budget is one interrupt, and the flooding agent cannot claim more',
  { timeout: T.timeout },
  () => {
    const rt = openRuntime(join(tmpDir('s4e'), 'conductor.sqlite'));
    try {
      const a = startAgent(rt, 'flood-a');
      const b = startAgent(rt, 'flood-b');
      // The flood: three rapid judgments from one agent.
      dispatchTool(rt, 'flood-a', 'q-1', 'pnpm add alpha-pkg');
      gateCommand(rt, a.id, 'q-2', 'pnpm add beta-pkg');
      gateCommand(rt, a.id, 'q-3', 'pnpm add gamma-pkg');
      // …and a competing agent with one equally-weighted judgment.
      dispatchTool(rt, 'flood-b', 'z-1', 'pnpm add delta-pkg');

      const now = 1_800_000_000_000;
      const model = modelFrom(rt, now);
      assert.equal(model.items.length, 4, 'nothing merged: four distinct judgments');
      assert.ok(
        model.items.every((i) => i.factors.consequence === 'high' && i.disposition !== 'critical'),
        'no critical item competes for the slot',
      );
      const interrupts = model.items.filter((i) => i.disposition === 'interrupt');
      assert.equal(interrupts.length, 1, 'the present-human budget is exactly one interrupt');
      assert.equal(model.map.needsYou, 1);
      assert.equal(model.budgetDemoted.length, 3, 'the other three stay queued and visible');

      const floodItems = model.items.filter((i) => i.executionId === a.id);
      assert.equal(floodItems.length, 3, 'all three floods are on the surface');
      assert.equal(
        floodItems.filter((i) => i.disposition === 'interrupt').length,
        1,
        'a flooding agent wins at most one slot',
      );
      assert.equal(interrupts[0]!.executionId, a.id, 'the oldest judgment wins the slot');
      assert.deepEqual(
        floodItems.slice(1).map((i) => i.disposition),
        ['queue', 'queue'],
        'the rest queue in creation order',
      );
      // Every held run stays held: the budget never releases a run.
      assert.equal(statusOf(rt, a.id), 'PAUSED');
      assert.equal(statusOf(rt, b.id), 'PAUSED');
      assert.equal(rt.decisions.pending(a.id).length, 3);
      // A second build at the same instant is identical — the budget is a
      // function of rows, not of call order.
      assert.deepEqual(modelFrom(rt, now).budgetDemoted, model.budgetDemoted, 'stable demotion');
      assert.equal(b.id === a.id, false);
    } finally {
      rt.close();
    }
  },
);
