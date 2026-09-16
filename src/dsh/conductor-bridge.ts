/**
 * Conductor Bridge
 *
 * The DSH-facing control plane: maps host extension-point interactions
 * (tool pre-execution gates, approvals, agent questions, step scheduling,
 * session events) onto Conductor executions, policy, attention, and the
 * decision queue. Pure logic over the normalized host surface — no DSH
 * imports, per the architecture rule that the core never depends on DSH.
 */

import { EventAdapter } from '../adapter/event-adapter.js';
import { approvalSubject } from '../policy/approval-subject.js';
import type { ExecutionManager } from '../manager/execution-manager.js';
import type { DecisionQueue } from '../decision/decision-queue.js';
import type { Execution } from '../domain/execution.js';
import type {
  ConductorHostBindings,
  HostApprovalOutcome,
  HostPreStepDecision,
  HostPreToolDecision,
  HostQuestionAnswer,
  HostQuestionRequest,
  HostSessionEvent,
  HostStepPayload,
  HostToolExecution,
  HostToolResult,
} from './host-surface.js';

export interface BridgeDeps {
  manager: ExecutionManager;
  decisions: DecisionQueue;
  /**
   * When true, `user-questions/request` is answered by Conductor for
   * routine low-risk questions that carry a recommended option. Off by
   * default: the human stays the answerer, Conductor only mirrors.
   */
  autoAnswerRoutine?: boolean;
}

const HELD_STATUSES = new Set(['PAUSED', 'BLOCKED', 'TAKEN_OVER', 'HANDOFF_PENDING']);

function argsOf(exec: HostToolExecution): Record<string, unknown> {
  return typeof exec.arguments === 'object' && exec.arguments !== null
    ? (exec.arguments as Record<string, unknown>)
    : {};
}

function questionConsequence(q: {
  question: string;
  detail?: string;
  options?: Array<{ label: string }>;
}): 'low' | 'medium' | 'high' {
  const text = `${q.question} ${q.detail ?? ''}`.toLowerCase();
  if (/irreversib|delete|drop |destroy|production|customer|money|payment|charge|credential|secret|security|migration|schema|auth\b/i.test(text)) {
    return 'high';
  }
  return 'medium';
}

export class ConductorBridge {
  /** host agent/session key -> execution id */
  private readonly _byHostKey: Map<string, string> = new Map();
  private _activeExecutionId?: string;
  private readonly _disposers: Array<() => void> = [];
  /** callId -> call identity, so post-commit tool/result rows can be joined. */
  private readonly _calls = new Map<string, { name: string; arguments: unknown }>();

  constructor(private readonly deps: BridgeDeps) {}

  public get activeExecutionId(): string | undefined {
    return this._activeExecutionId;
  }

  /** Register an execution for a goal and bind it to a host agent/session. */
  public startExecution(
    goal: string,
    opts: { workspaceRoot: string; hostKey?: string; constraints?: string[] },
  ): Execution {
    const exec = this.deps.manager.createExecution({
      goal,
      workspaceRoot: opts.workspaceRoot,
      constraints: opts.constraints,
    });
    exec.start('system');
    this.deps.manager.executionRepo.save(exec);
    this.deps.manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal }, 'dsh'),
    );
    this._activeExecutionId = exec.id;
    if (opts.hostKey) this._byHostKey.set(opts.hostKey, exec.id);
    return exec;
  }

  public bindHostKey(hostKey: string, executionId: string): void {
    this._byHostKey.set(hostKey, executionId);
    this._activeExecutionId = executionId;
  }

  /** Look up the live call a session-log tool/result refers to. */
  public rememberedCall(callId: string): { name: string; arguments: unknown } | undefined {
    return this._calls.get(callId);
  }

  private rememberCall(callId: string, name: string, args: Record<string, unknown>): void {
    this._calls.set(callId, { name, arguments: args });
    if (this._calls.size > 500) {
      const oldest = this._calls.keys().next().value;
      if (oldest !== undefined) this._calls.delete(oldest);
    }
  }

  public executionFor(exec: { agentId?: string; sessionId?: string }): Execution | undefined {
    const key =
      (exec.agentId ? this._byHostKey.get(`agent:${exec.agentId}`) : undefined) ??
      (exec.sessionId ? this._byHostKey.get(`session:${exec.sessionId}`) : undefined);
    const id = key ?? this._activeExecutionId;
    return id ? (this.deps.manager.executionRepo.findById(id) ?? undefined) : undefined;
  }

  // -------------------------------------------------------------------------
  // Extension-point handlers (signatures mirror DSH waterfalls)
  // -------------------------------------------------------------------------

  /**
   * `tools/pre-execute`: observe the action, classify it, and gate dispatch.
   * Returning undefined delegates to DSH (allow path); returning a decision
   * claims the call. Approved retries pass once, at most.
   */
  public preToolExecute(exec: HostToolExecution): HostPreToolDecision | undefined {
    const execution = this.executionFor(exec);
    if (!execution) return undefined; // unmanaged agent — hands off entirely

    const args = argsOf(exec);
    const subject = approvalSubject(exec.name, args);
    this.rememberCall(exec.callId, exec.name, args);

    if (HELD_STATUSES.has(execution.status)) {
      return {
        kind: 'deny',
        reason:
          `Conductor holds execution ${execution.id} (${execution.status}) for human judgment. ` +
          `Resolve with "conductor decisions", then the agent may retry.`,
      };
    }

    // Human already approved this exact action (via CLI resolve)? Consume the
    // one-time token and let THIS retry through. Shared DB makes it work
    // across processes without any polling.
    if (this.deps.decisions.consumeApproval(execution.id, subject)) {
      // Deliberately skip re-observation: classifying an already-approved
      // action again would PAUSE the run we just cleared.
      return undefined;
    }

    const policy = this.deps.manager.policyEngine.evaluateToolExecution(exec.name, args);

    // Observe (classifies; may queue a decision and PAUSE the execution).
    for (const evt of EventAdapter.adaptToolCall(execution.id, {
      callId: exec.callId,
      name: exec.name,
      arguments: args,
      agentId: exec.agentId,
    })) {
      this.deps.manager.processEvent(evt);
    }

    if (policy.action === 'deny') {
      return { kind: 'deny', reason: `Conductor policy: ${policy.reason ?? 'denied'}` };
    }
    if (policy.action === 'require_approval') {
      // A standing human delegation (checked identically by the manager,
      // which already recorded policy.delegated forensics above) releases
      // the gate — but never while held, and never over a current denial.
      const delegations = this.deps.manager.delegations;
      if (delegations) {
        const fresh0 = this.deps.manager.executionRepo.findById(execution.id);
        if (fresh0 && !HELD_STATUSES.has(fresh0.status)) {
          const covered = delegations.covers({
            executionId: execution.id,
            category: policy.category,
            ...(policy.ruleId ? { ruleId: policy.ruleId } : {}),
            resource: String(args.command ?? args.file_path ?? args.path ?? ''),
            subject,
            now: Date.now(),
          });
          if (covered) return undefined; // allow — delegated
        }
      }
      const fresh = this.deps.manager.executionRepo.findById(execution.id);
      const nowHeld = fresh ? HELD_STATUSES.has(fresh.status) : false;
      return {
        kind: 'deny',
        reason: nowHeld
          ? `Conductor paused this run for your judgment: ${policy.reason ?? 'approval required'}. ` +
            `Approve with "conductor decisions" — the agent will retry once you do.`
          : `Conductor policy requires approval: ${policy.reason ?? ''}`,
      };
    }
    return undefined; // allow — delegate to DSH dispatch
  }

  /**
   * `approval/request`: when DSH itself asks for approval of a gated tool,
   * Conductor answers REJECTED while a human holds the execution, so the
   * fail-fast deny is visible to the agent instead of hanging on a prompt
   * no one is watching. Outside held states it delegates (undefined).
   */
  public onApprovalRequest(req: {
    toolName: string;
    agentId?: string;
  }): HostApprovalOutcome | undefined {
    const execution = this.executionFor(req);
    if (!execution) return undefined;
    if (HELD_STATUSES.has(execution.status)) return 'rejected';
    return undefined;
  }

  /**
   * `agent/pre-step`: freeze the loop while a human holds the wheel.
   * DSH consumes claimed inbox messages on reject, so the mount layer must
   * re-inject them (`holdForHuman` instructs it to).
   */
  public preStep(payload: HostStepPayload): HostPreStepDecision | undefined {
    const execution = this.executionFor(payload);
    if (!execution) return undefined;
    if (HELD_STATUSES.has(execution.status)) {
      return { kind: 'reject', holdForHuman: true };
    }
    return undefined; // enter — delegate
  }

  /**
   * `user-questions/request`: mirror the agent's question into the decision
   * queue. In auto-answer mode, routine recommended-option questions are
   * answered without interrupting the human; anything else delegates so the
   * human answers through the DSH UI (with a Conductor decision also queued
   * if the attention engine paused the run).
   */
  public onQuestion(req: HostQuestionRequest): HostQuestionAnswer | undefined {
    const execution = this.executionFor(req);
    if (!execution) return undefined;

    const first = req.questions[0];
    for (const q of req.questions) {
      for (const evt of EventAdapter.adaptToolCall(execution.id, {
        callId: q.id,
        name: 'ask_user_question',
        arguments: {
          questions: [{ question: q.question, options: q.options }],
          ...(q.detail ? { context: q.detail } : {}),
          consequence: questionConsequence(q),
        },
      })) {
        this.deps.manager.processEvent(evt);
      }
    }

    if (this.deps.autoAnswerRoutine && first) {
      const fresh = this.deps.manager.executionRepo.findById(execution.id);
      const held = fresh ? HELD_STATUSES.has(fresh.status) : false;
      if (!held && !questionLooksHighStakes(first)) {
        const chosen = first.options && first.options.length > 0 ? [first.options[0].label] : ['yes'];
        return { answers: [{ id: first.id, selected: chosen }] };
      }
    }
    return undefined; // the human answers — via DSH UI and/or the conductor queue
  }

  /** `tools/result` / `session/event`: ingest post-commit activity. */
  public onToolResult(result: HostToolResult): void {
    const execution = this.executionFor(result);
    if (!execution) return;
    for (const evt of EventAdapter.adaptToolResult(
      execution.id,
      {
        callId: result.callId,
        toolName: result.name,
        isError: result.isError,
        value: result.text,
        timestamp: Date.now(),
      },
      (result.arguments ?? undefined) as Record<string, unknown> | undefined,
    )) {
      this.deps.manager.processEvent(evt);
    }
  }

  public onSessionEvent(evt: HostSessionEvent): void {
    const executionId = this._activeExecutionId;
    if (!executionId) return;
    for (const mapped of EventAdapter.adaptSessionEvent(executionId, evt as never)) {
      this.deps.manager.processEvent(mapped);
    }
  }

  // -------------------------------------------------------------------------
  // Mounting
  // -------------------------------------------------------------------------

  /** Attach to a host (real cordis bindings in production, fakes in tests). */
  public attach(bindings: ConductorHostBindings): () => void {
    this._disposers.push(
      bindings.on('session/event', (evt) => this.onSessionEvent(evt)),
      bindings.on('tools/result', (r) => this.onToolResult(r)),
      bindings.on('tools/pre-execute', (exec) => this.preToolExecute(exec)),
      bindings.on('user-questions/request', (req) => this.onQuestion(req)),
      bindings.on('agent/pre-step', (payload) => this.preStep(payload)),
      bindings.on('approval/request', (req) => this.onApprovalRequest(req)),
    );
    return () => {
      while (this._disposers.length > 0) (this._disposers.pop() as () => void)();
    };
  }
}

function questionLooksHighStakes(q: { question: string; detail?: string }): boolean {
  return questionConsequence(q) === 'high';
}
