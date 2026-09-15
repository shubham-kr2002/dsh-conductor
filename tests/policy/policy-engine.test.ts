import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, DEFAULT_POLICY_RULES } from '../../src/policy/policy-engine.js';

describe('PolicyEngine', () => {
  const engine = new PolicyEngine();

  test('ships with default rules across all categories', () => {
    assert.ok(DEFAULT_POLICY_RULES.length >= 6);
    const categories = new Set(engine.getRules().map((r) => r.category));
    assert.ok(categories.has('shell'));
    assert.ok(categories.has('git'));
    assert.ok(categories.has('credentials'));
    assert.ok(categories.has('deployment'));
  });

  test('default rules gate dependency installation but spare routine commands', () => {
    for (const cmd of ['pnpm add ioredis', 'npm install lodash', 'yarn add left-pad', 'pip install requests']) {
      const r = engine.evaluateShellCommand(cmd);
      assert.equal(r.action, 'require_approval', `${cmd} must be gated`);
      assert.equal(r.ruleId, 'require-approval-dependency-install');
      assert.equal(r.category, 'dependencies');
    }
    for (const cmd of ['pnpm test', 'git status', 'npm run build']) {
      assert.equal(engine.evaluateShellCommand(cmd).action, 'allow', `${cmd} must stay routine`);
    }
  });

  test('allows routine development commands', () => {
    for (const cmd of ['npm test', 'git status', 'git diff', 'pnpm run build', 'ls -la']) {
      const res = engine.evaluateShellCommand(cmd);
      assert.equal(res.action, 'allow', `Expected "${cmd}" to be allowed`);
    }
  });

  test('requires approval for dangerous git and deployment operations', () => {
    assert.equal(engine.evaluateShellCommand('git push --force origin main').action, 'require_approval');
    assert.equal(engine.evaluateShellCommand('git push -f').action, 'require_approval');
    assert.equal(engine.evaluateShellCommand('git reset --hard HEAD~5').action, 'require_approval');
    assert.equal(engine.evaluateShellCommand('terraform apply').action, 'require_approval');
    assert.equal(engine.evaluateShellCommand('kubectl delete namespace prod').action, 'require_approval');
  });

  test('denies superuser and credential access', () => {
    assert.equal(engine.evaluateShellCommand('sudo rm -rf /var/cache').action, 'deny');
    assert.equal(engine.evaluateFilePath('/home/dev/.aws/credentials', 'read').action, 'deny');
    assert.equal(engine.evaluateFilePath('config/prod.pem', 'read').action, 'deny');
    assert.equal(engine.evaluateFilePath('secrets/server.key', 'write').action, 'deny');
  });

  test('denies writes to system directories', () => {
    assert.equal(engine.evaluateFilePath('/etc/passwd', 'write').action, 'deny');
    assert.equal(engine.evaluateFilePath('/usr/local/bin/tool', 'delete').action, 'deny');
  });

  test('evaluateToolExecution routes by tool name', () => {
    assert.equal(
      engine.evaluateToolExecution('bash', { command: 'rm -rf ~' }).action,
      'require_approval',
    );
    assert.equal(
      engine.evaluateToolExecution('write', { file_path: 'src/app.ts' }).action,
      'allow',
    );
    assert.equal(
      engine.evaluateToolExecution('read', { file_path: '.env.production' }).action,
      'deny',
    );
  });

  test('extensibility: custom rules take effect and can be removed', () => {
    const custom = new PolicyEngine();
    custom.addRule({
      id: 'deny-npm-publish',
      name: 'No publishing packages',
      category: 'deployment',
      description: 'Autonomous agents must not publish packages',
      action: 'deny',
      match: { commands: ['npm publish', 'pnpm publish'] },
      reason: 'Package publication requires human review',
    });

    assert.equal(custom.evaluateShellCommand('npm publish --access public').action, 'deny');
    custom.removeRule('deny-npm-publish');
    assert.notEqual(custom.evaluateShellCommand('npm publish --access public').action, 'deny');
  });

  test('deny beats require_approval when both match', () => {
    const res = engine.evaluateShellCommand('sudo git push --force');
    assert.equal(res.action, 'deny');
    assert.equal(res.ruleId, 'deny-sudo');
  });
});
