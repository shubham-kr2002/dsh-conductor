/**
 * "Why didn't you interrupt me?"
 *
 * The trust half of an Attention OS. Every event the pipeline let pass
 * without claiming human time can be explained AFTER the fact from real,
 * persisted facts: the stored attention classification (level/action/
 * rule/rationale travel in event metadata), the deterministic policy
 * evaluation, and — where a delegation covered the action — the
 * delegation itself. No invented time savings: attention cost is
 * reported as 'not measured' because it has never been measured.
 */

import type { ConductorEvent } from '../types/event.js';
import type { PolicyEngine } from '../policy/policy-engine.js';
import type { PolicyEvaluationResult } from '../types/policy.js';
import type { AttentionLevel, AttentionAction } from '../types/attention.js';
import type { Delegation } from '../types/delegation.js';

export interface WhyNotInterrupted {
  /** One-line description of what the agent was allowed to do. */
  action: string;
  /** The stored classification this event received. */
  attention: { level: AttentionLevel; action: AttentionAction; ruleId?: string; rationale?: string } | null;
  /** Deterministic bullets, each backed by a persisted fact. */
  allowedBecause: string[];
  /** If a delegation carried it, which one. */
  delegatedBy: { id: string; category: string; grantedBy: string } | null;
  /** Honest statement — attention saved is not a measured quantity. */
  attentionSaved: 'not measured';
}

function describeAction(e: ConductorEvent): string {
  const p = e.payload as Record<string, unknown>;
  const args = (p.arguments as Record<string, unknown> | undefined) ?? {};
  const command = (p.command as string) ?? (args.command as string);
  const path = (p.filePath as string) ?? (args.file_path as string);
  if (command) return `run \`${command}\``;
  if (path) return `${String(p.action ?? 'modify')} \`${path}\``;
  if (p.toolName) return `use \`${String(p.toolName)}\``;
  return e.type;
}

/**
 * Explain why one event did not reach the human. Pure: reads the stored
 * metadata + re-evaluates policy (deterministic function of the row).
 */
export function explainNonInterruption(
  event: ConductorEvent,
  opts: { policy?: PolicyEngine; delegation?: Delegation | null } = {},
): WhyNotInterrupted {
  const stored = event.metadata?.attention as
    | { level?: AttentionLevel; action?: AttentionAction; ruleId?: string; rationale?: string }
    | undefined;
  const reasons: string[] = [];
  const p = event.payload as Record<string, unknown>;

  if (stored) {
    reasons.push(`attention classified it ${(stored.level ?? 'SILENT').toLowerCase()} (${(stored.action ?? 'CONTINUE').toLowerCase()}) — ${stored.rationale ?? stored.ruleId ?? 'no rule rationale stored'}`);
    if (stored.action === 'CONTINUE') reasons.push('no human action was required to keep the run safe');
    if (stored.action === 'RECORD') reasons.push('worth recording, not worth interrupting for');
  }

  let evalResult: PolicyEvaluationResult | undefined;
  if (opts.policy) {
    if (typeof p.command === 'string') evalResult = opts.policy.evaluateShellCommand(p.command);
    else if (typeof p.toolName === 'string') {
      evalResult = opts.policy.evaluateToolExecution(String(p.toolName), (p.arguments as Record<string, unknown>) ?? {});
    }
    if (evalResult) {
      if (evalResult.action === 'allow') {
        reasons.push(`policy permits it${evalResult.ruleId ? ` (rule ${evalResult.ruleId})` : ''}: ${evalResult.reason ?? 'no restriction matched'}`);
      } else if (evalResult.action === 'require_approval') {
        reasons.push(`policy requires approval, but a standing authority covered it`);
      }
    }
  } else {
    reasons.push('no protected resource, credential, or deployment target was involved');
  }

  const reversibility = p.reversibility as string | undefined;
  if (reversibility === 'reversible') reasons.push('the action is reversible');
  const consequence = p.consequence as string | undefined;
  if (consequence === 'low' || consequence === 'medium') reasons.push(`consequence was assessed ${consequence}`);

  const delegation = opts.delegation ?? null;
  if (delegation) {
    reasons.push(`you delegated this category to the agent (delegation ${delegation.id}, granted by ${delegation.grantedBy})`);
  }

  return {
    action: describeAction(event),
    attention: stored
      ? {
          level: stored.level ?? 'SILENT',
          action: stored.action ?? 'CONTINUE',
          ...(stored.ruleId ? { ruleId: stored.ruleId } : {}),
          ...(stored.rationale ? { rationale: stored.rationale } : {}),
        }
      : null,
    allowedBecause: reasons.length > 0 ? reasons : ['the pipeline recorded nothing that asked for human judgment'],
    delegatedBy: delegation ? { id: delegation.id, category: delegation.category, grantedBy: delegation.grantedBy } : null,
    attentionSaved: 'not measured',
  };
}

/**
 * Recent events that actually earned the label "allowed autonomously":
 * actions with real content (commands/tools), classified CONTINUE/RECORD,
 * plus delegated actions. Pure telemetry (reads, file echoes) stays out —
 * the list should read like work done, not a log tail.
 */
export function autonomousHighlights(
  events: ConductorEvent[],
  opts: { limit?: number } = {},
): ConductorEvent[] {
  const out: ConductorEvent[] = [];
  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);
  for (const e of sorted) {
    if (out.length >= (opts.limit ?? 12)) break;
    const stored = e.metadata?.attention as { action?: AttentionAction } | undefined;
    if (e.type === 'policy.delegated') {
      out.push(e);
      continue;
    }
    if (e.type !== 'command.completed' && e.type !== 'test.passed') continue;
    if (stored && (stored.action === 'CONTINUE' || stored.action === 'RECORD')) out.push(e);
  }
  return out.reverse();
}
