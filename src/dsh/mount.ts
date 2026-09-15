/**
 * Conductor mount composition
 *
 * Wires the full stack (SQLite runtime → manager → decision queue → bridge →
 * cordis plugin object) from a plain config, as loaded from a composition
 * row. This is the entry a DSH profile references; nothing below it imports
 * DSH code.
 */

import { ConductorDatabase } from '../storage/database.js';
import { SqliteExecutionRepository } from '../storage/execution-repository.js';
import { SqliteEventRepository } from '../storage/event-repository.js';
import { SqliteDecisionRepository } from '../storage/decision-repository.js';
import { DecisionQueue } from '../decision/decision-queue.js';
import { ExecutionManager } from '../manager/execution-manager.js';
import { EventAdapter } from '../adapter/event-adapter.js';
import { ConductorBridge } from './conductor-bridge.js';
import { createConductorCordisPlugin, type CordisCtx, type ConductorPluginConfig } from './cordis-plugin.js';
import type { HostSessionEvent } from './host-surface.js';

export interface ConductorMountOptions {
  goal: string;
  workspaceRoot: string;
  dbPath?: string;
  autoAnswerRoutine?: boolean;
  /** Mark the execution COMPLETED when the agent goes idle on a finished turn. */
  completeOnIdle?: boolean;
  /** Extra hard constraints recorded on the execution. */
  constraints?: string[];
}

export interface ConductorMount {
  plugin: { name: string; apply(ctx: CordisCtx): void };
  bridge: ConductorBridge;
  manager: ExecutionManager;
  decisions: DecisionQueue;
  db: ConductorDatabase;
  executionId: string;
  close(): void;
}

export function mountConductor(config: ConductorMountOptions | ConductorPluginConfig): ConductorMount {
  const cfg = config as ConductorMountOptions;
  const workspaceRoot = cfg.workspaceRoot ?? process.cwd();
  const dbPath = cfg.dbPath ?? `${workspaceRoot}/.conductor/conductor.db`;

  const db = new ConductorDatabase({ path: dbPath });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  const bridge = new ConductorBridge({
    manager,
    decisions,
    autoAnswerRoutine: cfg.autoAnswerRoutine ?? false,
  });

  const exec = bridge.startExecution(cfg.goal ?? 'Mounted DSH session', {
    workspaceRoot,
    constraints: cfg.constraints,
  });

  const sessionEventToBridge = (evt: HostSessionEvent): void => {
    switch (evt.type) {
      case 'tool/result': {
        const known = bridge.rememberedCall(evt.data.callId as string);
        bridge.onToolResult({
          callId: String(evt.data.callId ?? ''),
          name: known?.name ?? String(evt.data.name ?? ''),
          isError: evt.data.isError === true,
          text: String(evt.data.text ?? ''),
          arguments: known?.arguments,
        });
        return;
      }
      case 'user/message': {
        const text = String(evt.data.text ?? '');
        if (text === '') return;
        manager.processEvent(
          EventAdapter.createEvent(
            exec.id,
            'human.intervention',
            { action: 'message', actor: 'developer', notes: text.slice(0, 500) },
            'human',
          ),
        );
        return;
      }
      case 'turn/end': {
        const reasonKind = String(evt.data.reasonKind ?? 'completed');
        // Transitions happen inside processEvent/applyEventToExecution and
        // are guarded by isActive(): a PAUSED/BLOCKED run records the event
        // but keeps waiting for the human.
        if (reasonKind === 'completed' && cfg.completeOnIdle !== false) {
          manager.processEvent(
            EventAdapter.createEvent(
              exec.id,
              'execution.completed',
              { executionId: exec.id, completedWork: [], summary: 'Agent finished the turn', durationMs: 0 },
              'dsh',
            ),
          );
        } else if (reasonKind === 'error') {
          manager.processEvent(
            EventAdapter.createEvent(
              exec.id,
              'execution.failed',
              { executionId: exec.id, error: 'DSH turn ended with an error' },
              'dsh',
            ),
          );
        }
        return;
      }
      default:
        return; // turn/start and everything else: no-ops while mounted
    }
  };

  const plugin = createConductorCordisPlugin(bridge, { sessionEventToBridge });

  return {
    plugin,
    bridge,
    manager,
    decisions,
    db,
    executionId: exec.id,
    close: () => db.close(),
  };
}
