/**
 * Semantic timeline
 *
 * Collapses the raw event log into the handful of things a human would
 * actually narrate: "ran the tests → failed", "edited 3 files", "needs a
 * decision". Raw events stay available underneath; this is the default
 * view, because a transcript is the enemy of attention economy.
 */

import type { ConductorEvent } from '../types/event.js';
import type { ConductorDecision } from '../types/decision.js';

export type TimelineKind =
  | 'lifecycle'
  | 'decision'
  | 'question'
  | 'command'
  | 'files'
  | 'test'
  | 'intervention'
  | 'blocked';

export type TimelineTone = 'ok' | 'warn' | 'bad' | 'info';

export interface TimelineEntry {
  at: number;
  kind: TimelineKind;
  text: string;
  tone: TimelineTone;
  /** Number of raw events collapsed into this entry. */
  count: number;
  /** Secondary line: identifiers, error summary, file names, … */
  detail?: string;
}

interface FileGroup {
  first: ConductorEvent;
  last: ConductorEvent;
  paths: string[];
}

function eventText(e: ConductorEvent): { command?: string; callId?: string } {
  const p = e.payload as Record<string, unknown>;
  return {
    command: (p.command as string) ?? ((p.arguments as Record<string, unknown> | undefined)?.command as string),
    callId: (p.callId as string) ?? (p.commandId as string),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function flushFiles(group: FileGroup | null, out: TimelineEntry[]): void {
  if (!group) return;
  const p = group.first.payload as Record<string, unknown>;
  const verb = p.action === 'created' ? 'created' : 'edited';
  const names = group.paths.slice(0, 3).map((f) => f.split('/').pop() ?? f);
  out.push({
    at: group.last.timestamp,
    kind: 'files',
    tone: 'ok',
    count: group.paths.length,
    text: group.paths.length === 1
      ? `${verb} ${names[0]}`
      : `${verb} ${String(group.paths.length)} files`,
    detail: group.paths.length > 1
      ? names.join(', ') + (group.paths.length > 3 ? ` +${String(group.paths.length - 3)} more` : '')
      : group.paths[0],
  });
}

/**
 * Build the semantic timeline. `decisions` are rendered from the decision
 * records themselves (they carry status + resolution, the events don't).
 */
export function condenseTimeline(
  events: ConductorEvent[],
  decisions: ConductorDecision[] = [],
  opts: { limit?: number } = {},
): TimelineEntry[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const out: TimelineEntry[] = [];
  let fileGroup: FileGroup | null = null;
  /** callId -> pending command entry awaiting its completion. */
  const openCommands = new Map<string, TimelineEntry & { failed?: boolean }>();

  const closeFileRun = () => {
    flushFiles(fileGroup, out);
    fileGroup = null;
  };

  for (const e of sorted) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'execution.started':
        closeFileRun();
        out.push({ at: e.timestamp, kind: 'lifecycle', tone: 'info', count: 1, text: `Started: ${truncate(String(p.goal ?? 'task'), 80)}` });
        break;
      case 'execution.completed':
        closeFileRun();
        out.push({ at: e.timestamp, kind: 'lifecycle', tone: 'ok', count: 1, text: 'Completed', detail: p.summary ? truncate(String(p.summary), 120) : undefined });
        break;
      case 'execution.failed':
        closeFileRun();
        out.push({ at: e.timestamp, kind: 'lifecycle', tone: 'bad', count: 1, text: 'Failed', detail: p.error ? truncate(String(p.error), 120) : undefined });
        break;

      case 'command.started': {
        closeFileRun();
        const { callId, command } = eventText(e);
        const entry: TimelineEntry & { failed?: boolean } = {
          at: e.timestamp, kind: 'command', tone: 'info', count: 1,
          text: `ran \`${truncate(String(command ?? '?'), 70)}\``,
        };
        if (callId) openCommands.set(callId, entry);
        out.push(entry);
        break;
      }
      case 'command.completed': {
        const { callId, command } = eventText(e);
        const existing = callId ? openCommands.get(callId) : undefined;
        const failed = Number(p.exitCode ?? 0) !== 0;
        if (existing) {
          existing.tone = failed ? 'bad' : 'ok';
          existing.count += 1;
          existing.failed = failed;
        } else {
          closeFileRun();
          const entry: TimelineEntry & { failed?: boolean } = {
            at: e.timestamp, kind: 'command', tone: failed ? 'bad' : 'ok', count: 1, failed,
            text: `ran \`${truncate(String(command ?? '?'), 70)}\``,
          };
          out.push(entry);
        }
        break;
      }
      case 'tool.called': {
        // Tool calls that produced their own domain event are represented by
        // it; otherwise collapse into the read/write/search they performed.
        const name = String(p.toolName ?? '');
        const args = (p.arguments as Record<string, unknown> | undefined) ?? {};
        if (name === 'bash' || name === 'pwsh' || name === 'write' || name === 'edit'
          || name === 'create_file' || name === 'ask_user_question') break; // covered elsewhere
        closeFileRun();
        const target = String(args.file_path ?? args.path ?? args.pattern ?? args.url ?? '');
        out.push({
          at: e.timestamp, kind: 'command', tone: 'info', count: 1,
          text: target === '' ? `used ${name}` : `${name} ${truncate(target.split('/').pop() ?? target, 48)}`,
        });
        break;
      }
      case 'file.changed': {
        const path = String(p.filePath ?? 'file');
        if (fileGroup && (e.timestamp - fileGroup.last.timestamp < 120_000)) {
          fileGroup.paths.push(path);
          fileGroup.last = e;
        } else {
          closeFileRun();
          fileGroup = { first: e, last: e, paths: [path] };
        }
        break;
      }
      case 'test.failed':
        closeFileRun();
        out.push({ at: e.timestamp, kind: 'test', tone: 'bad', count: 1, text: `tests failed: ${truncate(String(p.testName ?? 'suite'), 60)}`, detail: p.error ? truncate(String(p.error), 140) : undefined });
        break;
      case 'test.passed':
        closeFileRun();
        out.push({ at: e.timestamp, kind: 'test', tone: 'ok', count: 1, text: `tests passed: ${truncate(String(p.testName ?? 'suite'), 60)}` });
        break;
      case 'agent.question':
        // rendered from decisions below (richer); skip raw duplicate
        break;
      case 'agent.blocked':
        closeFileRun();
        out.push({ at: e.timestamp, kind: 'blocked', tone: 'bad', count: 1, text: 'Agent is blocked', detail: p.reason ? truncate(String(p.reason), 140) : undefined });
        break;
      case 'human.intervention': {
        closeFileRun();
        const action = String(p.action ?? 'intervention');
        const label: Record<string, string> = {
          take_over: 'You took over',
          continue: 'Control returned to the agent',
          mark_away: 'You stepped away',
          message: 'You sent guidance',
          decision_resolved: 'Decision recorded',
          resume: 'You resumed the run',
          pause: 'You paused the run',
          cancel: 'You cancelled the run',
        };
        out.push({
          at: e.timestamp, kind: 'intervention', tone: 'info', count: 1,
          text: label[action] ?? `Human: ${action}`,
          detail: p.notes ? truncate(String(p.notes), 140) : undefined,
        });
        break;
      }
      default:
        break;
    }
  }
  closeFileRun();

  for (const d of [...decisions].sort((a, b) => a.createdAt - b.createdAt)) {
    out.push({
      at: d.createdAt,
      kind: 'decision',
      tone: d.status === 'pending' ? 'warn' : d.status === 'rejected' || d.status === 'expired' ? 'bad' : 'ok',
      count: 1,
      text: d.status === 'pending'
        ? `needs decision: ${truncate(d.title, 70)}`
        : `decision: ${truncate(d.title, 60)} → ${d.status}`,
      detail: d.status === 'pending' ? truncate(d.question, 140) : undefined,
    });
  }

  out.sort((a, b) => a.at - b.at);
  const limit = opts.limit ?? out.length;
  return out.slice(Math.max(0, out.length - limit));
}
