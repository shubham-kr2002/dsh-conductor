/**
 * Conductor × Cordis mounting layer
 *
 * The only module that speaks raw DSH/cordis plumbing: it adapts the real
 * waterfall semantics (call `next()` to delegate, return a value to claim;
 * `session/event` delivers `(session, event)`; `agent/pre-step` rejects
 * CONSUME claimed inbox messages) into the normalized ConductorHostBindings
 * the pure ConductorBridge was built against, and projects the result back.
 *
 * Everything below reads only scalar leaf fields off live DSH objects — no
 * serialization of Agents, Contexts, or messages into Conductor storage.
 *
 * Mount as a static composition row pointing at the compiled module:
 *   - name: '<abs-path>/dist/src/dsh/cordis-plugin.js'
 *     config:
 *       workspaceRoot: /path/to/project
 *       dbPath: /path/to/project/.conductor/conductor.db
 *       goal: 'what the agent is hired to finish'
 */

import type { ConductorBridge } from './conductor-bridge.js';
import type {
  HostApprovalOutcome,
  HostPreStepDecision,
  HostPreToolDecision,
  HostQuestionAnswer,
  HostSessionEvent,
  HostStepPayload,
  HostToolExecution,
  HostToolResult,
} from './host-surface.js';

// ---------------------------------------------------------------------------
// Minimal structural cordis surface (no @deepseek-ai imports — the core must
// stay DSH-free; the loader passes a ctx that satisfies this shape).
// ---------------------------------------------------------------------------

export interface CordisCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(name: string, listener: (...args: any[]) => any): () => void;
  effect(execute: () => void | (() => void)): void;
  provide?(name: string, value: unknown): () => void;
}

export interface ConductorPluginConfig {
  /** Human-readable goal for the managed execution. */
  goal?: string;
  workspaceRoot?: string;
  /** SQLite path; default ./.conductor/conductor.db under workspaceRoot. */
  dbPath?: string;
  /** Let Conductor answer routine recommended questions for the human. */
  autoAnswerRoutine?: boolean;
  /**
   * Pre-constructed bridge (CLI/tests). When omitted, the plugin builds a
   * runtime via createRuntime() using dbPath/workspaceRoot/goal.
   */
  bridge?: ConductorBridge;
}

type Decision0 = HostPreToolDecision | HostQuestionAnswer | HostPreStepDecision | HostApprovalOutcome;

// ---------------------------------------------------------------------------
// Projection helpers (leaf reads only)
// ---------------------------------------------------------------------------

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      parts.push(String((block as { text?: unknown }).text ?? ''));
    }
  }
  return parts.join('\n');
}

function projectToolResult(message: Record<string, unknown>): {
  callId: string;
  isError: boolean;
  text: string;
} {
  const callId =
    typeof message.id === 'string'
      ? message.id
      : String(
          (
            (Array.isArray(message.content) ? message.content[0] : undefined) as
              | { tool_use_id?: string }
              | undefined
          )?.tool_use_id ?? '',
        );
  const content = Array.isArray(message.content) ? message.content : [];
  const blocks = content as Array<Record<string, unknown>>;
  const errBlock = blocks.find((b) => b.type === 'tool_result' && b.is_error === true);
  const nested = errBlock ? textBlocks(errBlock.content) : textBlocks(content);
  const error = message.error as { name?: string; code?: string } | undefined;
  return {
    callId,
    isError: errBlock !== undefined || error !== undefined,
    text: nested,
  };
}

/**
 * Normalize one DSH session-log event into the bindings surface the bridge
 * consumes, or return null for types Conductor ignores. tool/call entries
 * are IGNORED: the live pre-execute gate already observed that call.
 */
function projectSessionEvent(event: unknown): HostSessionEvent | null {
  const e = event as { type?: string; time?: number; seq?: number; data?: Record<string, unknown> };
  if (typeof e?.type !== 'string') return null;
  const time = typeof e.time === 'number' ? e.time : Date.now();
  const data = typeof e.data === 'object' && e.data !== null ? e.data : {};

  switch (e.type) {
    case 'turn/start':
      return { type: 'turn/start', time, seq: e.seq, data: { turn: Number(data.turn ?? 0) } };
    case 'turn/end': {
      const reason = data.reason as { kind?: string; error?: { message?: string } } | undefined;
      return {
        type: 'turn/end',
        time,
        seq: e.seq,
        data: { turn: Number(data.turn ?? 0), reasonKind: String(reason?.kind ?? 'completed') },
      };
    }
    case 'tool/result': {
      const projected = projectToolResult(data.message as Record<string, unknown>);
      if (projected.callId === '') return null;
      return { type: 'tool/result', time, seq: e.seq, data: { ...projected, name: '' } };
    }
    case 'user/message':
      return {
        type: 'user/message',
        time,
        seq: e.seq,
        data: { text: textBlocks((data as { content?: unknown }).content) },
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export function createConductorCordisPlugin(
  bridge: ConductorBridge,
  opts: { sessionEventToBridge: (evt: HostSessionEvent) => void; log?: (msg: string) => void },
): { name: string; apply(ctx: CordisCtx): void } {
  const log = opts.log ?? ((m: string) => console.log(`[conductor] ${m}`));

  return {
    name: 'dsh-conductor',
    apply(ctx: CordisCtx): void {
      // session/event: (session, event) — observe-only, post-commit.
      const offSession = ctx.on('session/event', (session: unknown, event: unknown) => {
        const projected = projectSessionEvent(event);
        if (projected) opts.sessionEventToBridge(projected);
      });

      // tools/pre-execute: (exec, next) — waterfall gate.
      const offPreExecute = ctx.on('tools/pre-execute', (exec: Record<string, unknown>, next: () => Promise<Decision0>) => {
        const agent = exec.agent as { id?: string } | undefined;
        const input: HostToolExecution = {
          callId: String(exec.callId ?? ''),
          name: String(exec.name ?? ''),
          arguments: exec.arguments,
          agentId: typeof agent?.id === 'string' ? agent.id : undefined,
        };
        const claimed: HostPreToolDecision | undefined = bridge.preToolExecute(input);
        if (!claimed) return next(); // delegate → DSH dispatches
        return Promise.resolve(claimed);
      });

      // user-questions/request: (request, next) — claim = answer, else delegate.
      const offQuestions = ctx.on('user-questions/request', (request: Record<string, unknown>, next: () => Promise<Decision0>) => {
        const agent = request.agent as { id?: string } | undefined;
        const raw = Array.isArray(request.questions) ? request.questions : [];
        const answer: HostQuestionAnswer | undefined = bridge.onQuestion({
          agentId: typeof agent?.id === 'string' ? agent.id : undefined,
          questions: raw.map((q, i) => {
            const item = q as Record<string, unknown>;
            return {
              id: String(item.id ?? `q-${String(i)}`),
              question: String(item.question ?? ''),
              ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
              ...(typeof item.header === 'string' ? { header: item.header } : {}),
              ...(Array.isArray(item.options)
                ? {
                    options: (item.options as Array<Record<string, unknown>>).map((o) => ({
                      label: String(o.label ?? ''),
                      ...(typeof o.description === 'string' ? { description: o.description } : {}),
                    })),
                  }
                : {}),
              ...(item.multiSelect === true ? { multiSelect: true } : {}),
            };
          }),
        });
        if (!answer) return next(); // the human answers through the DSH UI
        return Promise.resolve<HostQuestionAnswer>(answer);
      });

      // agent/pre-step: ({agent, messages, turn, step, signal}, next) — freeze hook.
      const offPreStep = ctx.on('agent/pre-step', (payload: Record<string, unknown>, next: () => Promise<Decision0>) => {
        const agent = payload.agent as { id?: string; inject?: (m: unknown) => unknown } | undefined;
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        const input: HostStepPayload = {
          agentId: typeof agent?.id === 'string' ? agent.id : undefined,
          turn: Number(payload.turn ?? 0),
          step: Number(payload.step ?? 0),
          messages,
        };
        const claimed: HostPreStepDecision | undefined = bridge.preStep(input);
        if (!claimed) return next(); // enter — normal step
        // DSH consumed the claimed inbox batch with this reject; re-inject
        // (no wake) so the work is there when the run is released.
        if (claimed.kind === 'reject' && claimed.holdForHuman && agent && typeof agent.inject === 'function') {
          for (const m of messages) {
            try {
              agent.inject(m);
            } catch {
              // inject can fail on disposed agents — nothing to hold for anyway
            }
          }
        }
        // Messages already re-injected above — plain reject from here.
        return Promise.resolve<HostPreStepDecision>({ kind: 'reject', holdForHuman: false });
      });

      // approval/request: (req, next) — answer only while a human holds the run.
      const offApproval = ctx.on('approval/request', (req: Record<string, unknown>, next: () => Promise<Decision0>) => {
        const agent = req.agent as { id?: string } | undefined;
        const outcome = bridge.onApprovalRequest({
          toolName: String(req.toolName ?? ''),
          agentId: typeof agent?.id === 'string' ? agent.id : undefined,
        });
        if (!outcome) return next();
        return Promise.resolve<HostApprovalOutcome>(outcome);
      });

      // results + activity reach the bridge through session/event only
      // (tools/result emits deep-frozen live objects; session/event is the
      // durable post-commit mirror and is enough).

      ctx.effect(() => () => {
        offSession();
        offPreExecute();
        offQuestions();
        offPreStep();
        offApproval();
        log('detached — extension points released');
      });

      if (typeof ctx.provide === 'function') {
        ctx.provide('conductor', { bridge, version: 1 });
      }
      log('mounted: pre-execute gate, question mirror, step freeze, approval veto');
    },
  };
}

/** Default export for the plugin loader (`exports.default ?? exports`). */
export default createConductorCordisPlugin;
