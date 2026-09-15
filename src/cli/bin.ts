#!/usr/bin/env node
/**
 * Conductor CLI entry point
 */

import { Command } from 'commander';
import { createManager, renderStatus, renderHistory } from './commands.js';

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
      const summary = manager.getStatus(executionId);
      console.log(renderStatus(summary));
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
      const events = manager.getHistory(executionId, { limit });
      console.log(renderHistory(events));
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
      const exec = manager.createExecution({
        goal: task,
        workspaceRoot: options.workspace,
      });
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

program.parse(process.argv);
