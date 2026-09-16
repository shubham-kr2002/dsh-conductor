/**
 * Conductor CLI Commands Implementation
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConductorDatabase } from '../storage/database.js';
import { SqliteExecutionRepository } from '../storage/execution-repository.js';
import { SqliteEventRepository } from '../storage/event-repository.js';
import { SqliteDecisionRepository } from '../storage/decision-repository.js';
import { SqliteDelegationRepository } from '../storage/delegation-repository.js';
import { DelegationService } from '../delegation/delegation-service.js';
import { SqliteTakeoverRepository } from '../storage/takeover-repository.js';
import { SqliteHandoffRepository } from '../storage/handoff-repository.js';
import { decisionStatusLabel } from '../summary/status-language.js';
import { DecisionQueue } from '../decision/decision-queue.js';
import { TakeoverService } from '../takeover/takeover-service.js';
import { HandoffService } from '../handoff/handoff-service.js';
import { ExecutionManager } from '../manager/execution-manager.js';
import type { ConductorEvent } from '../types/event.js';
import type { ConductorDecision } from '../types/decision.js';

export { resolveDbPath, createRuntime, createRuntime as createManager, type ConductorRuntime } from '../composition.js';

export function renderStatus(summary: ReturnType<ExecutionManager['getStatus']>): string {
  const lines: string[] = [
    '=================================================================',
    '                   CONDUCTOR EXECUTION STATUS                    ',
    '=================================================================',
    `Execution ID:        ${summary.executionId}`,
    `Goal:                ${summary.goal}`,
    `Status:              [${summary.status}]`,
    `Current Phase:       ${summary.currentPhase}`,
    `Progress Summary:    ${summary.progressSummary}`,
    `Duration:            ${summary.durationSeconds}s`,
    '-----------------------------------------------------------------',
    `Metrics:             Tools: ${summary.toolCallCount} | Files: ${summary.filesModifiedCount} | Completed Tasks: ${summary.completedWorkCount}`,
    `Pending Decisions:   ${summary.pendingDecisionsCount}`,
    `Known Risks:         ${summary.risksCount}`,
    `Needs You:           ${summary.attentionRequired ? 'YES — see pending items below' : 'no'}`,
  ];

  if (summary.pendingAttention.length > 0) {
    lines.push('-----------------------------------------------------------------');
    lines.push('ITEMS REQUIRING YOUR JUDGMENT:');
    for (const item of summary.pendingAttention) {
      lines.push(`  [${item.level}] ${item.type} — ${item.rationale}`);
    }
  }

  lines.push('=================================================================');
  return lines.join('\n');
}

export function renderHistory(events: ConductorEvent[]): string {
  if (events.length === 0) {
    return 'No events recorded for this execution.';
  }

  const lines: string[] = [
    '=================================================================',
    '                   CONDUCTOR EXECUTION HISTORY                   ',
    '=================================================================',
  ];

  for (const evt of events) {
    const timeStr = new Date(evt.timestamp).toISOString().slice(11, 19);
    let detail = '';

    switch (evt.type) {
      case 'execution.started':
        detail = (evt.payload.goal as string) || '';
        break;
      case 'tool.called':
        detail = `${evt.payload.toolName} (${JSON.stringify(evt.payload.arguments || {})})`;
        break;
      case 'file.changed':
        detail = `${evt.payload.filePath} (${evt.payload.action})`;
        break;
      case 'command.started':
        detail = (evt.payload.command as string) || '';
        break;
      case 'command.completed':
        detail = `exitCode=${evt.payload.exitCode} (${evt.payload.command || ''})`;
        break;
      case 'test.passed':
        detail = `PASS: ${evt.payload.testName || ''}`;
        break;
      case 'test.failed':
        detail = `FAIL: ${evt.payload.testName || ''} - ${evt.payload.error || ''}`;
        break;
      case 'agent.blocked':
        detail = (evt.payload.reason as string) || '';
        break;
      case 'agent.question':
        detail = (evt.payload.question as string) || '';
        break;
      case 'human.intervention':
        detail = `${evt.payload.action} by ${evt.payload.actor}: ${evt.payload.notes || ''}`;
        break;
      default:
        detail = JSON.stringify(evt.payload);
        break;
    }

    const attention = evt.metadata?.attention as { level?: string } | undefined;
    const tag = attention
      ? ` {${attention.level === 'SILENT' ? '·' : attention.level === 'BACKGROUND' ? '•' : attention.level === 'DECISION' ? '!' : '✱'}}`
      : '';
    lines.push(`[${timeStr}] ${evt.type.padEnd(20)} ${detail}${tag}`);
  }

  lines.push('=================================================================');
  return lines.join('\n');
}

/** Render the pending decision queue, highest priority first. */
export function renderDecisions(decisions: ConductorDecision[]): string {
  const lines: string[] = [
    '=================================================================',
    '                      CONDUCTOR DECISIONS                      ',
    '=================================================================',
  ];

  if (decisions.length === 0) {
    lines.push('Nothing needs you. The agent is working autonomously.');
    lines.push('=================================================================');
    return lines.join('\n');
  }

  lines.push(`${String(decisions.length)} decision(s) require your judgment:`);
  lines.push('');
  decisions.forEach((d, idx) => {
    const age = Math.round((Date.now() - d.createdAt) / 60000);
    lines.push(`${String(idx + 1)}. [${d.impact}/${d.urgency}] ${d.title}`);
    lines.push(`   ${d.question}`);
    if (d.recommendation) lines.push(`   Agent recommends: ${d.recommendation}`);
    if (d.options.length > 0) {
      for (const opt of d.options) {
        const rec = opt.isRecommended ? ' <= recommended' : '';
        lines.push(`     (${opt.id}) ${opt.label}${opt.description ? ` — ${opt.description}` : ''}${rec}`);
      }
    }
    lines.push(`   id: ${d.id} | execution: ${d.executionId} | ${String(age)}m ago`);
    lines.push('');
  });
  lines.push('Resolve with:  conductor resolve <decision-id> --accept | --reject | --custom "<answer>"');
  lines.push('=================================================================');
  return lines.join('\n');
}

export function renderDecisionDetail(d: ConductorDecision): string {
  const lines = [
    `Decision ${d.id}`,
    `  Title:   ${d.title}`,
    `  Status:  ${decisionStatusLabel(d.status)}`,
    `  Impact:  ${d.impact} | Urgency: ${d.urgency} | Confidence: ${String(d.confidence)}`,
    `  Question: ${d.question}`,
    '  Context:',
    ...d.context.split('\n').map((l) => `    ${l}`),
  ];
  if (d.why) {
    const w = d.why;
    lines.push('  Why this interrupts you:');
    lines.push(`    WHAT           ${w.what}`);
    lines.push(`    WHY NOW        ${w.whyNow}`);
    lines.push(`    IMPACT         ${w.impact}`);
    lines.push(`    REVERSIBILITY  ${w.reversibility}${w.reversibilityNote ? ` — ${w.reversibilityNote}` : ''}`);
    lines.push(`    EVIDENCE       rules: ${w.evidence.ruleIds.join(', ') || '—'} | blast: ${w.evidence.blastRadius} | ambiguity: ${Math.round(w.evidence.ambiguity * 100)}% | task-aligned: ${w.evidence.taskAligned ? 'yes' : 'no'}`);
    if (w.evidence.affectedResources.length > 0) lines.push(`                   touches: ${w.evidence.affectedResources.join(', ')}`);
    if (w.recommendation) lines.push(`    RECOMMENDATION ${w.recommendation}`);
    lines.push(`    IF YES         ${w.consequences.approve}`);
    lines.push(`    IF NO          ${w.consequences.reject}`);
  }
  if (d.options.length > 0) {
    lines.push('  Options:');
    for (const opt of d.options) {
      lines.push(`    (${opt.id}) ${opt.label}${opt.isRecommended ? ' <= recommended' : ''}`);
    }
  }
  if (d.resolution) {
    lines.push(`  Resolved by ${d.resolution.resolvedBy} as ${d.resolution.status}`);
    if (d.resolution.customValue) lines.push(`  Answer: ${d.resolution.customValue}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 10 — attention cockpit, explanations, and delegation rendering.
// All derived views; existing commands above are untouched.
// ---------------------------------------------------------------------------

import type { Execution } from '../domain/execution.js';
import type { AttentionModel } from '../attention/attention-orchestrator.js';
import type { AttentionCandidate } from '../attention/attention-candidate.js';
import { dispositionLanguage, priorityFacts } from '../attention/attention-priority.js';
import type { WhyNotInterrupted } from '../attention/non-interruption-why.js';
import type { Delegation } from '../types/delegation.js';
import type { PolicyCategory } from '../types/policy.js';
import type { DecisionQuality } from '../types/decision.js';
import { deriveDecisionQuality } from '../decision/decision-quality.js';
import { formatDuration } from '../summary/attention-metrics.js';

/** Categories a human may explicitly delegate (mirrors PolicyCategory). */
export const POLICY_CATEGORIES: readonly PolicyCategory[] = [
  'filesystem',
  'shell',
  'dependencies',
  'git',
  'deployment',
  'credentials',
  'production_resources',
];

/** `--since <iso|minutes>` → absolute timestamp (minutes = minutes ago). */
export function parseSinceOption(raw: string | undefined, now: number): number | undefined {
  if (raw == null || raw === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return now - Number(raw) * 60_000;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new Error(`--since must be an ISO datetime or a number of minutes, got: ${raw}`);
  return t;
}

type CockpitSection = 'needs-you' | 'waiting' | 'watching' | 'recorded';

function renderCockpitItem(c: AttentionCandidate, now: number): string[] {
  const lang = dispositionLanguage(c.disposition);
  const facts = priorityFacts(c, now)
    .map((f) => `${f.factor}=${f.value}`)
    .join(' · ');
  const out: string[] = [];
  out.push(`  • [${lang.label}] ${c.title}  (${c.agentId})`);
  out.push(`    ${c.id}`);
  out.push(`    ${facts}`);
  if (c.kind === 'decision' && c.refIds.length > 0) {
    const decisionId = c.refIds[0]!;
    out.push(
      `    decision ${decisionId} — decide: conductor resolve ${decisionId}` +
        ` | explain: conductor attention --why ${decisionId}`,
    );
  }
  if (c.whyWaiting) out.push(`    *(${c.whyWaiting})*`);
  return out;
}

/** The cockpit view: ordered sections over the attention model. */
export function renderAttentionCockpit(
  model: AttentionModel,
  executions: Execution[],
  decisions: ConductorDecision[],
  opts: { now: number; all?: boolean; limit?: number },
): string {
  const { now } = opts;
  const limit = opts.limit;
  const pendingExecIds = new Set(decisions.filter((d) => d.status === 'pending').map((d) => d.executionId));
  const HELD = new Set(['PAUSED', 'BLOCKED']);
  const workingAgents = executions
    .filter((e) => !e.isTerminal() && !HELD.has(e.status) && e.status !== 'TAKEN_OVER' && !pendingExecIds.has(e.id))
    .map((e) => e.agent.id);

  const sections: Record<CockpitSection, AttentionCandidate[]> = {
    'needs-you': [],
    waiting: [],
    watching: [],
    recorded: [],
  };
  for (const c of model.items) sections[dispositionLanguage(c.disposition).section].push(c);

  const lines: string[] = [
    '=================================================================',
    '                      CONDUCTOR — ATTENTION                   ',
    '=================================================================',
    `${String(model.map.agents)} agents · ${String(model.map.needsYou)} needs you · ` +
      `${String(model.map.waiting)} waiting · attention load ${model.map.load.level} ` +
      `(${model.map.load.reasons.join('; ')})`,
    '',
  ];

  const renderSection = (header: string, items: AttentionCandidate[], emptyLine: string | null): void => {
    lines.push(header);
    if (items.length === 0) {
      if (emptyLine) lines.push(`  ${emptyLine}`);
    } else {
      const shown = limit != null && limit > 0 ? items.slice(0, limit) : items;
      for (const c of shown) lines.push(...renderCockpitItem(c, now));
      if (shown.length < items.length) {
        lines.push(`  … ${String(items.length - shown.length)} more (--limit to see more)`);
      }
    }
    lines.push('');
  };

  renderSection(
    'NEEDS YOU',
    sections['needs-you'],
    `Nothing needs you — ${String(model.map.working)} working autonomously`,
  );
  renderSection('WAITING', sections.waiting, 'nothing queued');
  renderSection('WATCHING', sections.watching, 'nothing to watch');
  if (opts.all) renderSection('RECORDED', sections.recorded, 'nothing recorded');

  lines.push('WORKING');
  if (workingAgents.length === 0) lines.push('  no agent is running fully on its own right now');
  else lines.push(`  ${String(workingAgents.length)} working autonomously: ${workingAgents.join(', ')}`);
  lines.push('=================================================================');
  return lines.join('\n');
}

/** Decision explanation: existing seven-field why + ranking facts + quality. */
export function renderAttentionWhyDecision(
  d: ConductorDecision,
  model: AttentionModel,
  allDecisions: ConductorDecision[],
  exec: Execution | null,
  now: number,
): string {
  const lines: string[] = [renderDecisionDetail(d)];
  const candidate = model.items.find((c) => c.refIds.includes(d.id));
  if (candidate) {
    lines.push('  Why it is ranked here now:');
    for (const f of priorityFacts(candidate, now)) {
      lines.push(`    ${f.factor.padEnd(16)}${f.value}`);
    }
  }
  if (d.resolution) {
    const quality: DecisionQuality = deriveDecisionQuality(d, allDecisions, exec);
    lines.push('  Quality (observable facts):');
    lines.push(
      `    answered by ${d.resolution.resolvedBy} after ${
        quality.responseMs != null ? formatDuration(quality.responseMs) : '—'
      }`,
    );
    lines.push(`    outcome: ${quality.outcome ?? '—'} | came back: ${quality.recurred ? 'YES' : 'no'}`);
  }
  return lines.join('\n');
}

/** Event explanation: why this did NOT interrupt you. */
export function renderAttentionWhyEvent(e: ConductorEvent, w: WhyNotInterrupted): string {
  const lines: string[] = [
    '=================================================================',
    '            CONDUCTOR — WHY THIS DID NOT INTERRUPT YOU         ',
    '=================================================================',
    `Action:      ${w.action}`,
    `Event:       ${e.id} (${e.type}) at ${new Date(e.timestamp).toISOString()}`,
    `Execution:   ${e.executionId}`,
    w.attention
      ? `Attention:   ${w.attention.level.toLowerCase()} / ${w.attention.action.toLowerCase()}${
          w.attention.ruleId ? ` (rule ${w.attention.ruleId})` : ''
        }`
      : 'Attention:   no stored classification on this event',
    '',
    'Allowed because:',
    ...w.allowedBecause.map((r) => `  • ${r}`),
  ];
  if (w.delegatedBy) {
    lines.push('');
    lines.push(
      `Delegated by: ${w.delegatedBy.id} (category ${w.delegatedBy.category}, granted by ${w.delegatedBy.grantedBy})`,
    );
  }
  lines.push('');
  lines.push(`attention saved: ${w.attentionSaved}`);
  lines.push('=================================================================');
  return lines.join('\n');
}

function delegationTag(d: Delegation, now: number): 'active' | 'expired' | 'revoked' {
  if (d.revokedAt != null) return 'revoked';
  if (d.expiresAt != null && d.expiresAt <= now) return 'expired';
  return 'active';
}

/** Delegation ledger (CLI `delegations`). */
export function renderDelegations(list: Delegation[], now: number): string {
  const lines: string[] = [
    '=================================================================',
    '                      CONDUCTOR — DELEGATIONS                  ',
    '=================================================================',
  ];
  if (list.length === 0) {
    lines.push('No delegations granted — every consequential action interrupts you.');
    lines.push('Grant with:  conductor delegate <category> [--execution <id>] [--hours <n>]');
    lines.push('=================================================================');
    return lines.join('\n');
  }
  lines.push(`${String(list.length)} delegation(s):`);
  lines.push('');
  for (const d of [...list].sort((a, b) => a.grantedAt - b.grantedAt)) {
    const tag = delegationTag(d, now);
    const scope = d.scope === 'execution' ? `execution ${d.executionId}` : 'workspace';
    lines.push(
      `  ${d.id}  [${tag}]  ${scope}  ${d.category}${d.resourcePattern ? ` ~${d.resourcePattern}` : ''}  by ${d.grantedBy}`,
    );
    const expiry =
      d.expiresAt == null
        ? 'never expires'
        : tag === 'expired'
          ? `expired ${formatDuration(Math.max(0, now - d.expiresAt))} ago`
          : `expires in ${formatDuration(Math.max(0, d.expiresAt - now))} (${new Date(d.expiresAt).toISOString()})`;
    lines.push(
      `      granted ${new Date(d.grantedAt).toISOString()} · ${expiry}` +
        (d.revokedAt != null ? ` · revoked by ${d.revokedBy ?? '?'} ${new Date(d.revokedAt).toISOString()}` : ''),
    );
    if (d.note) lines.push(`      note: ${d.note}`);
  }
  lines.push('');
  lines.push('Revoke with:  conductor delegations --revoke <id>');
  lines.push('=================================================================');
  return lines.join('\n');
}

/** Confirmation printed right after `conductor delegate <category>`. */
export function renderDelegationGrant(d: Delegation, now: number): string {
  const lines: string[] = [
    '=================================================================',
    '                   CONDUCTOR — DELEGATION GRANTED              ',
    '=================================================================',
    `Delegated category "${d.category}" — covered actions now run without interrupting you.`,
    `  id:       ${d.id}`,
    `  scope:    ${d.scope === 'execution' ? `execution ${d.executionId}` : 'workspace (every execution on this plane)'}`,
    `  covers:   ${d.resourcePattern ? `actions whose command/path contains "${d.resourcePattern}"` : 'the whole category'}`,
    `  granted:  by ${d.grantedBy} at ${new Date(d.grantedAt).toISOString()}`,
    `  expires:  ${
      d.expiresAt == null
        ? 'never — revoke to end it'
        : `${new Date(d.expiresAt).toISOString()} (in ${formatDuration(Math.max(0, d.expiresAt - now))})`
    }`,
  ];
  if (d.note) lines.push(`  note:     ${d.note}`);
  lines.push('');
  lines.push(`Revoke with:  conductor delegations --revoke ${d.id}`);
  lines.push('=================================================================');
  return lines.join('\n');
}

export interface DelegationOfferView {
  category: string;
  accepted: number;
  rejected: number;
  sampleTitles: string[];
  offer: string;
}

/** Recurrence offers — these OFFER only; nothing is granted from here. */
export function renderDelegationOffers(offers: DelegationOfferView[]): string {
  const lines: string[] = [
    '=================================================================',
    '                  CONDUCTOR — DELEGATION OFFERS                ',
    '=================================================================',
  ];
  if (offers.length === 0) {
    lines.push('No recurring approvals worth delegating yet.');
    lines.push('(This only offers — nothing is ever granted automatically.)');
    lines.push('=================================================================');
    return lines.join('\n');
  }
  lines.push('You keep approving the same kind of thing. Consider delegating it:');
  lines.push('');
  for (const o of offers) {
    lines.push(`  ${o.category} — ${String(o.accepted)} accepted, ${String(o.rejected)} rejected`);
    for (const t of o.sampleTitles) lines.push(`    · ${t}`);
    lines.push(`    ${o.offer}`);
    lines.push(`    grant with: conductor delegate ${o.category}`);
    lines.push('');
  }
  lines.push('These are OFFERS ONLY — nothing above changed any authority.');
  lines.push('=================================================================');
  return lines.join('\n');
}
