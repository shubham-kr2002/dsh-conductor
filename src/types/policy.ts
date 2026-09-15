/**
 * Conductor Policy Types
 *
 * Policies governing filesystem, shell, dependencies, git, secrets, etc.
 */

export type PolicyCategory =
  | 'filesystem'
  | 'shell'
  | 'dependencies'
  | 'git'
  | 'deployment'
  | 'credentials'
  | 'production_resources';

export type PolicyAction = 'allow' | 'deny' | 'require_approval';

export interface PolicyRule {
  id: string;
  name: string;
  category: PolicyCategory;
  description: string;
  action: PolicyAction;
  match: {
    patterns?: string[];
    commands?: string[];
    paths?: string[];
    envKeys?: string[];
  };
  reason?: string;
}

export interface PolicyEvaluationResult {
  action: PolicyAction;
  ruleId?: string;
  category: PolicyCategory;
  reason?: string;
}
