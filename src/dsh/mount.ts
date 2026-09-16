/**
 * Conductor mount composition
 *
 * Wires the full stack (SQLite runtime → manager → decision queue → bridge →
 * cordis plugin object) from a plain config, as loaded from a composition
 * row. This is the entry a DSH profile references; nothing below it imports
 * DSH code.
 */

import type { DelegationService } from '../delegation/delegation-service.js';
import type { ExecutionManager } from '../manager/execution-manager.js';
import type { ConductorDatabase } from '../storage/database.js';
import type { DecisionQueue } from '../decision/decision-queue.js';
import { EventAdapter } from '../adapter/event-adapter.js';
import { ConductorBridge } from './conductor-bridge.js';
import { createConductorCordisPlugin, type CordisCtx, type ConductorPluginConfig } from './cordis-plugin.js';
import type { HostSessionEvent } from './host-surface.js';

import { createRuntime, type ConductorRuntime } from '../composition.js';

export interface ConductorMountOptions {
  goal: string;
  workspaceRoot: string;
  dbPath?: string;
  autoAnswerRoutine?: boolean;
  /** Mark the execution COMPLETED when the agent goes idle on a finished turn. */
  completeOnIdle?: boolean;
  /** Extra hard constraints recorded on the execution. */
  constraints?: string[];
  /**
   * Re-attach to the workspace's newest OPEN execution instead of always
   * starting a fresh one. Headless DSH ends the run when the gate holds, so
   * the human's retry arrives as a NEW process over the SAME execution —
   * that is where cross-process approval tokens live. Default false (P8
   * semantics unchanged); the bundle entry turns it on.
   */
  reuseOpenExecution?: boolean;
}

export interface ConductorMount {
  plugin: { name: string; apply(ctx: CordisCtx): void };
  /** Resolved SQLite file the control plane opened. */
  dbPath: string;
  bridge: ConductorBridge;
  manager: ExecutionManager;
  decisions: DecisionQueue;
  delegations: DelegationService;
  /** Full composed control plane (takeover/handoff included) via one root. */
  runtime: ConductorRuntime;
  db: ConductorDatabase;
  executionId: string;
  close(): void;
}

export function mountConductor(config: ConductorMountOptions | ConductorPluginConfig): ConductorMount {
  const cfg = config as ConductorMountOptions;
  const workspaceRoot = cfg.workspaceRoot ?? process.cwd();
  // Resolution order (documented in README · DSH installation): explicit
  // config.dbPath > CONDUCTOR_DB_PATH env > <workspaceRoot>/.conductor/
  // conductor.db. Nothing is placed silently in a surprising location.
  const dbPath =
    cfg.dbPath ?? process.env.CONDUCTOR_DB_PATH ?? `${workspaceRoot}/.conductor/conductor.db`;

  const runtime = createRuntime(dbPath);
  const { db, manager, decisions, delegations } = runtime;
  const bridge = new ConductorBridge({
    manager,
    decisions,
    autoAnswerRoutine: cfg.autoAnswerRoutine ?? false,
  });

  const open = cfg.reuseOpenExecution
    ? manager.executionRepo.findActiveByWorkspace(workspaceRoot)
    : null;
  const exec =
    open ??
    bridge.startExecution(cfg.goal ?? 'Mounted DSH session', {
      workspaceRoot,
      constraints: cfg.constraints,
    });
  if (open) bridge.adoptExecution(open.id);

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
    dbPath,
    bridge,
    manager,
    decisions,
    delegations,
    runtime,
    db,
    executionId: exec.id,
    close: () => db.close(),
  };
}
