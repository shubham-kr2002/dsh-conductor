#!/usr/bin/env node
/**
 * Conductor CLI entry point
 */

import { Command } from 'commander';
import {
  createManager,
  createRuntime,
  renderStatus,
  renderHistory,
  renderDecisions,
  renderDecisionDetail,
  renderAttentionCockpit,
  renderAttentionWhyDecision,
  renderAttentionWhyEvent,
  renderDelegations,
  renderDelegationGrant,
  renderDelegationOffers,
  parseSinceOption,
  POLICY_CATEGORIES,
} from './commands.js';
import { attentionFromRuntime, loadAttentionRows, renderAttentionHistory } from '../summary/attention-history.js';
import { buildAttentionModel } from '../attention/attention-orchestrator.js';
import { explainNonInterruption } from '../attention/non-interruption-why.js';
import { DEFAULT_POLICY_RULES } from '../policy/policy-engine.js';
import type { Delegation } from '../types/delegation.js';
import { renderAwaySummary } from '../summary/away-mode.js';
import { computeAttentionMetrics, renderAttentionMetrics, formatDuration } from '../summary/attention-metrics.js';
import { condenseTimeline } from '../summary/timeline.js';
import { statusLanguage } from '../summary/status-language.js';
import { rollupDecisionQuality } from '../decision/decision-quality.js';
import { startConductorUi } from '../ui/server.js';
import { runDemoScenario } from '../demo/scenario.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderHandoffBrief } from '../handoff/handoff-service.js';

const program = new Command();

program
  .name('conductor')
  .description('Conductor: The execution control plane for autonomous coding agents')
  .version('0.1.0')
  .option('--db <path>', 'Shared control-plane SQLite file for any command (sets CONDUCTOR_DB_PATH)');

// One control plane, many windows: every command can point at the same file
// the mounted plugin writes, e.g. `conductor --db … metrics`.
program.hook('preAction', (thisCmd) => {
  const globals = thisCmd.opts();
  if (typeof globals.db === 'string') process.env.CONDUCTOR_DB_PATH = globals.db;
});

program
  .command('status [executionId]')
  .description('Display status of active or specific execution')
  .action((executionId) => {
    const { manager, db } = createManager();
    try {
      console.log(renderStatus(manager.getStatus(executionId)));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('history [executionId]')
  .description('Display chronological event history of an execution')
  .option('-l, --limit <number>', 'Maximum number of events to show', '50')
  .action((executionId, options) => {
    const { manager, db } = createManager();
    try {
      const limit = parseInt(options.limit, 10) || 50;
      console.log(renderHistory(manager.getHistory(executionId, { limit })));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('run <task>')
  .description('Start a new execution under Conductor')
  .option('-w, --workspace <path>', 'Workspace root path', process.cwd())
  .action((task, options) => {
    const { manager, db } = createManager();
    try {
      const exec = manager.createExecution({ goal: task, workspaceRoot: options.workspace });
      exec.start();
      manager.executionRepo.save(exec);
      console.log(`Started execution: ${exec.id}`);
      console.log(renderStatus(manager.getStatus(exec.id)));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('decisions [executionId]')
  .description('List pending decisions requiring your judgment (highest priority first)')
  .option('--all', 'Include resolved/expired/cancelled decisions')
  .action((executionId, options) => {
    const { decisions, db } = createManager();
    try {
      const items = options.all
        ? decisions.list(executionId)
        : decisions.pending(executionId);
      console.log(renderDecisions(items));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('resolve <decisionId>')
  .description('Resolve a pending decision and (optionally) resume its execution')
  .option('-a, --accept', 'Accept the recommended option')
  .option('-r, --reject', 'Reject the proposed action')
  .option('-c, --custom <answer>', 'Provide a custom answer')
  .option('-o, --option <optionId>', 'Choose a specific option id')
  .option('-f, --feedback <text>', 'Optional note recorded with the resolution')
  .option('--by <who>', 'Who is resolving (default: developer)', 'developer')
  .option('--no-resume', 'Do not resume the execution automatically')
  .action((decisionId, options) => {
    const { decisions, db } = createManager();
    try {
      const chosen = [options.accept, options.reject, options.custom].filter(Boolean).length;
      if (chosen === 0) {
        console.error('Specify --accept, --reject, or --custom "<answer>".');
        process.exit(2);
      }
      const outcome = options.accept
        ? 'accepted'
        : options.reject
          ? 'rejected'
          : 'custom';
      const resolved = decisions.resolve(decisionId, outcome, {
        answerBy: options.by,
        selectedOptionId: options.option,
        customValue: options.custom,
        feedback: options.feedback,
        resumeExecution: options.resume !== false,
      });
      console.log(renderDecisionDetail(resolved));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('show <decisionId>')
  .description('Show full context for one decision without resolving it')
  .action((decisionId) => {
    const { decisions, db } = createManager();
    try {
      console.log(renderDecisionDetail(decisions.get(decisionId)));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('take-over <executionId>')
  .description('Freeze the agent, capture workspace, and show a continuation brief')
  .option('--by <who>', 'Who is taking over', 'developer')
  .option('-n, --notes <text>', 'Why you are taking over (recorded with the intervention)')
  .action((executionId, options) => {
    const { takeover, manager, db } = createManager();
    try {
      const result = takeover.takeOver(executionId, { actor: options.by, notes: options.notes });
      console.log(result.brief);
      console.log(renderStatus(manager.getStatus(executionId)));
      console.log(
        '\nWorkspace frozen. Make your edits, then run:\n' +
          `  conductor continue ${executionId} --notes "what you changed and why"`,
      );
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('brief <executionId>')
  .description('Show the current continuation brief for a taken-over execution')
  .action((executionId) => {
    const { takeover, db } = createManager();
    try {
      const current = takeover.currentBrief(executionId);
      if (!current) {
        console.log('No active take-over for this execution.');
      } else {
        console.log(current.brief);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('continue <executionId>')
  .description('Return control to the agent: reconcile workspace edits and resume')
  .option('--by <who>', 'Who is resuming', 'developer')
  .option('-n, --notes <text>', 'Guidance for the agent on what you changed')
  .action((executionId, options) => {
    const { takeover, manager, db } = createManager();
    try {
      const exec = manager.getExecution(executionId);
      if (exec.status === 'TAKEN_OVER') {
        const result = takeover.continue(executionId, { actor: options.by, notes: options.notes });
        const m = result.modifications;
        const nChanged = m.created.length + m.modified.length + m.deleted.length;
        console.log(
          nChanged === 0
            ? 'No workspace changes detected while taken over.'
            : `Reconciled ${String(nChanged)} human change(s): ` +
              [
                m.created.length > 0 ? `+${String(m.created.length)} created` : '',
                m.modified.length > 0 ? `~${String(m.modified.length)} modified` : '',
                m.deleted.length > 0 ? `-${String(m.deleted.length)} deleted` : '',
              ]
                .filter((s) => s !== '')
                .join(', '),
        );
        console.log(result.brief);
      } else {
        exec.resume('Resumed via CLI', 'human');
        manager.executionRepo.save(exec);
      }
      console.log(renderStatus(manager.getStatus(executionId)));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('away [executionId]')
  .description('Mark that you stepped away (sets the window for the return summary)')
  .action((executionId) => {
    const { manager, db } = createManager();
    try {
      const ts = manager.markAway(executionId);
      console.log(`Away mark recorded at ${new Date(ts).toISOString()}.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('summary [executionId]')
  .description('Decision-oriented "while you were away" summary')
  .action((executionId) => {
    const { manager, db } = createManager();
    try {
      console.log(renderAwaySummary(manager.getAwaySummary(executionId)));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('handoff <executionId>')
  .description('Build a structured handoff brief from persisted state (no transcript)')
  .option('--from <agentId>', 'Outgoing agent id', 'default-agent')
  .option('--to <agentId>', 'Incoming agent id (optional)')
  .option('--no-mark', 'Do not mark the execution HANDOFF_PENDING')
  .action((executionId, options) => {
    const { handoff, db } = createManager();
    try {
      const h = handoff.createHandoff(executionId, {
        fromAgentId: options.from,
        toAgentId: options.to,
        markExecution: options.mark !== false,
      });
      console.log(renderHandoffBrief(h));
      console.log(`\nHandoff id: ${h.handoffId}`);
      console.log(`Adopt with:  conductor adopt ${h.handoffId} --to <agentId>`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('adopt <handoffId>')
  .description('Adopt a handoff as an incoming agent and resume the execution')
  .option('--to <agentId>', 'Incoming agent id', 'default-agent')
  .option('--no-resume', 'Do not resume the execution automatically')
  .action((handoffId, options) => {
    const { handoff, manager, db } = createManager();
    try {
      const { brief } = handoff.adoptHandoff(handoffId, options.to, {
        resumeExecution: options.resume !== false,
      });
      console.log(brief);
      const exec = manager.executionRepo.findById(
        handoff.loadHandoff(handoffId).executionId,
      );
      if (exec) console.log(renderStatus(manager.getStatus(exec.id)));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('metrics [executionId]')
  .description('Attention budget for an execution: autonomous vs human time')
  .action((executionId) => {
    const { manager, decisions, takeoverRepo, decisionRepo, db } = createRuntime();
    try {
      const exec = executionId
        ? manager.executionRepo.findById(executionId)
        : (manager.getActiveExecution() ?? manager.executionRepo.list({ limit: 1 })[0]);
      if (!exec) throw new Error(executionId ? `execution not found: ${executionId}` : 'no execution to measure');
      const all = decisionRepo.list({ executionId: exec.id });
      const m = computeAttentionMetrics(exec, all, {
        now: Date.now(),
        // interventions are recorded by the domain on every take-over path
        takeoverCount: exec.interventions.filter((i) => i.type === 'take_over').length,
      });
      console.log(`Attention budget — ${exec.goal}`);
      console.log(renderAttentionMetrics(m));
      const roll = rollupDecisionQuality(all);
      console.log(`quality: ${String(roll.resolved)} answered` +
        (roll.medianResponseMs != null ? `, median response ${formatDuration(roll.medianResponseMs)}` : '') +
        (roll.recurredCount ? `, ${String(roll.recurredCount)} came back` : ', none came back'));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('timeline [executionId]')
  .description('Condensed semantic timeline — what happened, without the transcript')
  .option('-l, --limit <number>', 'Maximum activities to show', '40')
  .action((executionId, options) => {
    const { manager, decisionRepo, db } = createRuntime();
    try {
      const exec = executionId
        ? manager.executionRepo.findById(executionId)
        : (manager.getActiveExecution() ?? manager.executionRepo.list({ limit: 1 })[0]);
      if (!exec) throw new Error(executionId ? `execution not found: ${executionId}` : 'no execution to show');
      const limit = parseInt(options.limit, 10) || 40;
      const events = manager.eventRepo.listByExecution(exec.id, { limit: 500 });
      const decisions = decisionRepo.list({ executionId: exec.id });
      const glyphs = { ok: '✓', bad: '✗', warn: '⚠', info: '·' };
      console.log(`Timeline — ${exec.goal}  (${statusLanguage(exec.status).label})`);
      for (const t of condenseTimeline(events, decisions, { limit })) {
        const clock = new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const extra = t.count > 1 ? ` ×${String(t.count)}` : '';
        console.log(`${clock}  ${glyphs[t.tone] ?? '·'}  ${t.text}${extra}${t.detail ? `   — ${t.detail}` : ''}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('ui')
  .description('Serve the Conductor control surface over the shared control plane')
  .option('-p, --port <number>', 'Port (0 for ephemeral)', '8717')
  .option('--host <host>', 'Bind address', '127.0.0.1')
  .option('--db <path>', 'SQLite path shared with the mounted plugin (default $CONDUCTOR_DB_PATH or ./.conductor/conductor.db)')
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    if (!Number.isFinite(port)) throw new Error('port must be a number');
    const dbPath = options.db ?? process.env.CONDUCTOR_DB_PATH ?? './.conductor/conductor.db';
    const server = await startConductorUi({ dbPath, port, host: options.host });
    console.log(`Conductor control surface → ${server.url}`);
    console.log(`reading control plane: ${dbPath}`);
    process.on('SIGINT', () => { void server.close().then(() => process.exit(0)); });
    process.on('SIGTERM', () => { void server.close().then(() => process.exit(0)); });
    // keep alive
    await new Promise(() => undefined);
  });

program
  .command('demo')
  .description('Deterministic "A Day in the Life" run through the real control plane, ending on the return-to-work screen')
  .option('-w, --workspace <path>', 'Workspace root for the story', process.cwd())
  .option('--db <path>', 'Demo control-plane SQLite file (default <workspace>/.conductor-demo/demo.db)')
  .option('--start <iso>', 'Fictional story start (ISO datetime; default: 42 minutes ago)')
  .option('-q, --quiet', 'Print only the final screen')
  .action(async (options) => {
    let now: number | undefined;
    if (options.start) {
      now = Date.parse(options.start);
      if (Number.isNaN(now)) {
        console.error('Error: --start must be an ISO datetime');
        process.exit(1);
      }
    }
    try {
      const result = await runDemoScenario({
        workspaceRoot: options.workspace,
        ...(options.db ? { dbPath: options.db } : {}),
        ...(now !== undefined ? { now } : {}),
        ...(options.quiet ? { log: () => {} } : {}),
      });
      console.log('');
      for (const line of result.finalScreen) console.log(line);
      console.log('');
      console.log(`Control plane left intact at: ${result.dbPath}`);
      console.log(`See it live:  conductor ui --db ${result.dbPath}   (one decision is still waiting for you)`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Scaffold .conductor/ with a ready-to-mount DSH plugin config')
  .option('-w, --workspace <path>', 'Workspace root path', process.cwd())
  .action((options) => {
    const dir = path.join(options.workspace, '.conductor');
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'conductor.db');
    const file = path.join(dir, 'conductor.mount.yml');
    if (fs.existsSync(file)) {
      console.log(`${file} already exists — left untouched.`);
    } else {
      fs.writeFileSync(
        file,
        [
          '# Mount Conductor into DSH (host extension point).',
          '# Add to your DSH agent preset, then restart the agent session:',
          '',
          'plugins:',
          '  - dsh-conductor',
          '',
          '# Conductor control plane (this file is the shared source of truth):',
          `conductor:`,
          `  db: ${dbPath}`,
          '',
          '# Then, in another terminal:',
          '#   conductor ui            # mission control at http://127.0.0.1:8717',
          '#   conductor decisions     # what needs your judgment',
          '',
        ].join('\n'),
      );
      console.log(`wrote ${file}`);
    }
    console.log(`control plane database: ${dbPath}`);
    console.log('Next: mount the plugin above into DSH, start an execution, run `conductor ui`.');
  });

// ---------------------------------------------------------------------------
// Phase 10 — attention cockpit, why, history, and delegation commands.
// (Appended; every command above is untouched.)
// ---------------------------------------------------------------------------

program
  .command('attention [executionId]')
  .description('Attention cockpit: where your focus should go across the fleet')
  .option('--all', 'Include recorded items (delegated activity, batches)')
  .option('--json', 'Machine-readable output: {map, items, budgetDemoted}')
  .option('-l, --limit <number>', 'Maximum items shown per section')
  .option('--why <id>', 'Explain one interruption (decision id) or one non-interruption (event id)')
  .option('--history', 'Where your attention went: derived history over the window')
  .option('--since <iso|minutes>', 'History window start: ISO datetime, or N minutes ago')
  .action((executionId, options) => {
    const rt = createRuntime();
    try {
      const now = Date.now();

      if (typeof options.why === 'string' && options.why !== '') {
        const id = options.why;
        const decision = rt.decisionRepo.findById(id);
        const rows = loadAttentionRows(rt, executionId ? { executionId } : {});
        const model = buildAttentionModel({ ...rows, now });
        if (decision) {
          const exec = rt.execRepo.findById(decision.executionId);
          console.log(renderAttentionWhyDecision(decision, model, rows.decisions, exec ?? null, now));
          return;
        }
        const event = rows.events.find((e) => e.id === id);
        if (!event) throw new Error(`no decision or event with id: ${id}`);
        const payload = event.payload as Record<string, unknown>;
        const stored = event.metadata?.attention as { ruleId?: string } | undefined;
        const metaRule = typeof event.metadata?.ruleId === 'string' ? (event.metadata.ruleId as string) : undefined;
        const fromPayload = typeof payload.delegationId === 'string' ? payload.delegationId : undefined;
        const fromAttention =
          stored?.ruleId && stored.ruleId.startsWith('delegation:')
            ? stored.ruleId.slice('delegation:'.length)
            : undefined;
        const fromMeta = metaRule && metaRule.startsWith('dl-') ? metaRule : undefined;
        const dlId = fromPayload ?? fromAttention ?? fromMeta;
        let delegation: Delegation | null = null;
        if (dlId) delegation = rt.delegationRepo.findById(dlId) ?? null;
        const w = explainNonInterruption(event, { policy: rt.manager.policyEngine, delegation });
        console.log(renderAttentionWhyEvent(event, w));
        return;
      }

      if (options.history) {
        let since: number | undefined;
        try {
          since = parseSinceOption(options.since, now);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
        const { history } = attentionFromRuntime(rt, now, since != null ? { since } : {});
        if (options.json) console.log(JSON.stringify(history));
        else console.log(renderAttentionHistory(history));
        return;
      }

      const rows = loadAttentionRows(rt, executionId ? { executionId } : {});
      const model = buildAttentionModel({ ...rows, now });
      if (options.json) {
        console.log(JSON.stringify({ map: model.map, items: model.items, budgetDemoted: model.budgetDemoted }));
        return;
      }
      const limit = options.limit != null ? parseInt(options.limit, 10) || undefined : undefined;
      console.log(
        renderAttentionCockpit(model, rows.executions, rows.decisions, {
          now,
          all: Boolean(options.all),
          ...(limit != null ? { limit } : {}),
        }),
      );
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      rt.db.close();
    }
  });

program
  .command('delegate <category>')
  .description('Grant a standing delegation: covered actions run without interrupting you')
  .option('--execution <id>', 'Scope the delegation to one execution (default: whole workspace)')
  .option('--pattern <substr>', 'Narrow to commands/paths containing this substring')
  .option('--hours <n>', 'Hours until expiry (default: valid until revoked)')
  .option('--by <who>', 'Who is granting', 'developer')
  .option('-n, --note <text>', 'Why (recorded with the delegation for the audit trail)')
  .action((category, options) => {
    if (!POLICY_CATEGORIES.includes(category)) {
      console.error(`Error: unknown category "${category}". Valid categories: ${POLICY_CATEGORIES.join(', ')}`);
      process.exit(1);
    }
    let ttlMs: number | undefined;
    if (options.hours != null) {
      const h = Number(options.hours);
      if (!Number.isFinite(h) || h <= 0) {
        console.error('Error: --hours must be a positive number of hours');
        process.exit(1);
      }
      ttlMs = h * 3_600_000;
    }
    const { delegations, db } = createRuntime();
    try {
      const d = delegations.grant({
        scope: options.execution ? 'execution' : 'workspace',
        ...(options.execution ? { executionId: options.execution } : {}),
        category: category as (typeof POLICY_CATEGORIES)[number],
        ...(options.pattern ? { resourcePattern: String(options.pattern) } : {}),
        grantedBy: String(options.by ?? 'developer'),
        ...(ttlMs != null ? { ttlMs } : {}),
        ...(options.note ? { note: String(options.note) } : {}),
      });
      console.log(renderDelegationGrant(d, Date.now()));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program
  .command('delegations')
  .description('List standing delegations; --suggest shows recurrence offers')
  .option('--all', 'Include expired and revoked rows (audit view)')
  .option('--revoke <id>', 'Revoke a delegation by id')
  .option('--by <who>', 'Who is revoking', 'developer')
  .option('--suggest', 'Show delegation offers built from recurring approvals (grants nothing)')
  .action((options) => {
    const rt = createRuntime();
    try {
      const now = Date.now();
      if (typeof options.revoke === 'string' && options.revoke !== '') {
        const d = rt.delegations.revoke(options.revoke, String(options.by ?? 'developer'), now);
        console.log(
          `Revoked delegation ${d.id} (by ${d.revokedBy ?? options.by}). ` +
            'Covered actions will interrupt you again.',
        );
      } else {
        const list = options.all ? rt.delegations.list() : rt.delegations.list({ active: true, now });
        console.log(renderDelegations(list, now));
      }
      if (options.suggest) {
        const ruleCategory = new Map(DEFAULT_POLICY_RULES.map((r) => [r.id, r.category]));
        const offers = rt.delegations.suggestions({
          decisions: rt.decisionRepo.list({}),
          ruleCategory: (id) => ruleCategory.get(id),
          now,
        });
        console.log('');
        console.log(renderDelegationOffers(offers));
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      rt.db.close();
    }
  });

program.parse(process.argv);

