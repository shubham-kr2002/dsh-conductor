#!/usr/bin/env node
/**
 * Conductor CLI entry point
 */

import { Command } from 'commander';
import {
  createManager,
  renderStatus,
  renderHistory,
  renderDecisions,
  renderDecisionDetail,
} from './commands.js';

const program = new Command();

program
  .name('conductor')
  .description('Conductor: The execution control plane for autonomous coding agents')
  .version('0.1.0');

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

program.parse(process.argv);
