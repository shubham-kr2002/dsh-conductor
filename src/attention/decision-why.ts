/**
 * Decision explanation builder
 *
 * Deterministically constructs the DecisionWhy explanation from the real
 * pipeline inputs (event payload, policy evaluation, attention
 * classification). Nothing is invented: every field is derived from a
 * concrete cause that already exists in the system.
 */

import type { ConductorEvent } from '../types/event.js';
import type { AttentionClassification, Consequence, Reversibility } from '../types/attention.js';
import type { DecisionWhy, DecisionImpact } from '../types/decision.js';
import type { PolicyEvaluationResult } from '../types/policy.js';

const INFRA_PATTERN = /\b(kubectl|terraform|helm|serverless|heroku|vercel|aws|gcloud|az\b|docker|systemctl|service\s|nginx|dns|cloudflare)/i;
const EXTERNAL_PATTERN = /\b(git push|git remote|curl|wget|npm (publish|depublish)|pnpm publish|yarn publish|webhook|smtp|sendgrid|stripe)/i;
const GIT_LOCAL_PATTERN = /\bgit\b/;

export function blastRadiusFor(command: string, toolName: string): DecisionWhy['evidence']['blastRadius'] {
  if (INFRA_PATTERN.test(command)) return 'infrastructure';
  if (EXTERNAL_PATTERN.test(command)) return 'external-system';
  if (toolName === 'bash' || toolName === 'pwsh' ? GIT_LOCAL_PATTERN.test(command) : false) return 'repository';
  if (toolName === 'write' || toolName === 'edit' || toolName === 'str_replace_editor') return 'workspace';
  return 'workspace';
}

const IMPACT_LINE: Record<DecisionImpact, string> = {
  minor: 'Small — easiest to live with',
  moderate: 'Moderate — scoped change with limited reach',
  major: 'Major — changes behavior or shared state',
  critical: 'Critical — potentially destructive or irreversible',
};

function reversibilityNote(r: Reversibility, command: string): string | undefined {
  if (r === 'irreversible') return 'The action itself cannot be undone automatically.';
  if (r === 'reversible') return command !== '' ? 'Ordinary git/file operations can be reverted afterwards.' : 'Can be undone by editing files back.';
  return undefined;
}

export interface BuildWhyInput {
  event: ConductorEvent;
  classification: AttentionClassification;
  policy?: PolicyEvaluationResult;
  /** Ambiguity 0..1 used by the attention engine. */
  ambiguity: number;
  taskAligned: boolean;
  impact: DecisionImpact;
  recommendation?: string;
}

export function buildDecisionWhy(input: BuildWhyInput): DecisionWhy {
  const { event, classification, policy } = input;
  const payload = event.payload as Record<string, unknown>;

  if (event.type === 'agent.question') {
    const question = String(payload.question ?? classification.rationale);
    const hasRecommendation = Boolean(payload.recommendation);
    return {
      what: `The agent asks: ${question}`,
      whyNow: hasRecommendation
        ? 'An answer is needed to choose between meaningfully different paths.'
        : 'The agent is uncertain and continuing without an answer risks the wrong direction.',
      impact: IMPACT_LINE[input.impact],
      reversibility: 'reversible',
      reversibilityNote: 'Answering changes nothing by itself; the agent acts only after.',
      evidence: {
        eventIds: [event.id],
        ruleIds: [classification.ruleId],
        affectedResources: [],
        blastRadius: 'workspace',
        ambiguity: input.ambiguity,
        taskAligned: input.taskAligned,
      },
      ...(input.recommendation
        ? { recommendation: String(input.recommendation) }
        : {}),
      consequences: {
        approve: 'The agent proceeds with your answer.',
        reject: 'The agent continues without this change and finds another way.',
      },
    };
  }

  const toolName = String(payload.toolName ?? '');
  const args = (payload.arguments as Record<string, unknown> | undefined) ?? {};
  const command = String(payload.command ?? args.command ?? '');
  const filePath = String(payload.filePath ?? args.file_path ?? args.path ?? '');
  const isBash = toolName === 'bash' || toolName === 'pwsh' || command !== '';

  const what = command !== ''
    ? `Run \`${command.slice(0, 120)}\`${command.length > 120 ? '…' : ''}`
    : filePath !== ''
      ? `${String(payload.action ?? 'modify')} \`${filePath}\``
      : toolName !== ''
        ? `Use the \`${toolName}\` tool`
        : 'Perform a consequential action';

  const reversibility = (payload.reversibility as Reversibility | undefined)
    ?? (isBash && (INFRA_PATTERN.test(command) || EXTERNAL_PATTERN.test(command)) ? 'irreversible' : 'unknown');

  const affectedResources: string[] = [];
  if (command !== '') affectedResources.push(command.slice(0, 160));
  if (filePath !== '') affectedResources.push(filePath);

  const dangerous = classification.level === 'CRITICAL';
  const approvalNeeds: Consequence = payload.consequence as Consequence;

  return {
    what,
    whyNow: dangerous
      ? 'This action is outside what autonomous policy allows; only a human can safely judge it.'
      : `${classification.rationale}${policy?.reason ? ` Policy: ${policy.reason}.` : ''}`,
    impact: `${IMPACT_LINE[input.impact]}${approvalNeeds === 'critical' ? ' (policy rated it critical)' : ''}`,
    reversibility,
    ...(reversibilityNote(reversibility, command) ? { reversibilityNote: reversibilityNote(reversibility, command) } : {}),
    evidence: {
      eventIds: [event.id],
      ruleIds: [classification.ruleId, ...(policy?.ruleId ? [policy.ruleId] : [])],
      affectedResources,
      blastRadius: blastRadiusFor(command || filePath, toolName || event.type),
      ambiguity: input.ambiguity,
      taskAligned: input.taskAligned,
    },
    ...(input.recommendation ? { recommendation: input.recommendation } : {}),
    consequences: {
      approve: 'The agent runs this exact action once and continues.',
      reject: 'The action stays blocked; the agent keeps working without it.',
    },
  };
}
