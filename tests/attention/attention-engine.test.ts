import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AttentionEngine,
  createAttentionContext,
  levelAtLeast,
  LLM_REVIEW_CONFIDENCE_FLOOR,
} from '../../src/attention/attention-engine.js';
import type { AttentionClassificationInput } from '../../src/types/attention.js';

function baseInput(over: Partial<AttentionClassificationInput> = {}): AttentionClassificationInput {
  return {
    eventType: 'tool.called',
    consequence: 'low',
    reversibility: 'reversible',
    taskAligned: true,
    uncertainty: 0.1,
    policyImpact: 'allow',
    confidence: 0.95,
    ...over,
  };
}

describe('AttentionEngine — spec boundary cases', () => {
  const engine = new AttentionEngine();

  test('LOW consequence + reversible + task-aligned → SILENT', () => {
    const c = engine.classify(
      baseInput({ consequence: 'low', reversibility: 'reversible', taskAligned: true }),
    );
    assert.equal(c.level, 'SILENT');
    assert.equal(c.action, 'CONTINUE');
    assert.equal(c.ruleId, 'low-consequence-silent');
  });

  test('MEDIUM consequence + reversible → BACKGROUND', () => {
    const c = engine.classify(
      baseInput({ consequence: 'medium', reversibility: 'reversible' }),
    );
    assert.equal(c.level, 'BACKGROUND');
    assert.equal(c.action, 'RECORD');
    assert.equal(c.ruleId, 'medium-consequence');
  });

  test('HIGH consequence + ambiguous → DECISION', () => {
    const c = engine.classify(
      baseInput({ consequence: 'high', uncertainty: 0.8 }),
    );
    assert.equal(c.level, 'DECISION');
    assert.equal(c.action, 'PAUSE');
    assert.equal(c.ruleId, 'ambiguous-high');
  });

  test('CRITICAL consequence → PAUSE', () => {
    const c = engine.classify(baseInput({ consequence: 'critical' }));
    assert.equal(c.level, 'CRITICAL');
    assert.equal(c.action, 'PAUSE');
    assert.equal(c.ruleId, 'critical-consequence');
  });
});

describe('AttentionEngine — policy interaction', () => {
  const engine = new AttentionEngine();

  test('policy deny always pauses, even for a low-consequence event', () => {
    const c = engine.classify(
      baseInput({ consequence: 'low', policyImpact: 'deny' }),
    );
    assert.equal(c.level, 'CRITICAL');
    assert.equal(c.action, 'PAUSE');
    assert.equal(c.ruleId, 'policy-deny');
  });

  test('policy require_approval pauses as a decision', () => {
    const c = engine.classify(
      baseInput({ consequence: 'high', policyImpact: 'require_approval' }),
    );
    assert.equal(c.level, 'DECISION');
    assert.equal(c.action, 'PAUSE');
    assert.equal(c.ruleId, 'policy-approval');
  });

  test('policy deny outranks everything (rule priority)', () => {
    const c = engine.classify(
      baseInput({ consequence: 'medium', policyImpact: 'deny' }),
    );
    assert.equal(c.ruleId, 'policy-deny');
  });
});

describe('AttentionEngine — interruption suppression', () => {
  const engine = new AttentionEngine();

  test('low-risk agent question with recommendation is suppressed', () => {
    const c = engine.classify(
      baseInput({
        eventType: 'agent.question',
        consequence: 'low',
        taskAligned: true,
        confidence: 0.9,
      }),
    );
    assert.equal(c.level, 'SILENT');
    assert.equal(c.action, 'CONTINUE');
    assert.equal(c.ruleId, 'low-risk-question-suppressed');
  });

  test('medium agent question is recorded, not surfaced', () => {
    const c = engine.classify(
      baseInput({ eventType: 'agent.question', consequence: 'medium' }),
    );
    assert.equal(c.level, 'BACKGROUND');
    assert.equal(c.action, 'RECORD');
  });

  test('high agent question surfaces as DECISION', () => {
    const c = engine.classify(
      baseInput({ eventType: 'agent.question', consequence: 'high' }),
    );
    assert.equal(c.level, 'DECISION');
    assert.equal(c.action, 'PAUSE');
    assert.equal(c.ruleId, 'blocked-agent');
  });

  test('agent.blocked always requires judgment', () => {
    const c = engine.classify(baseInput({ eventType: 'agent.blocked' }));
    assert.equal(c.level, 'DECISION');
    assert.equal(c.action, 'PAUSE');
  });

  test('a single test failure stays BACKGROUND (agent self-heals)', () => {
    const ctx = createAttentionContext();
    const c = engine.classify(baseInput({ eventType: 'test.failed', consequence: 'medium' }), ctx);
    assert.equal(c.level, 'BACKGROUND');
    assert.equal(c.action, 'RECORD');
    assert.equal(c.ruleId, 'test-failure-self-heal');
  });

  test('three consecutive test failures escalate to DECISION', () => {
    const ctx = createAttentionContext();
    ctx.consecutiveTestFailures = 2;
    const c = engine.classify(baseInput({ eventType: 'test.failed', consequence: 'medium' }), ctx);
    // The manager increments the counter BEFORE classifying, so the third
    // failure arrives with ctx.consecutiveTestFailures === 3.
    const cAfter = engine.classify(
      baseInput({ eventType: 'test.failed', consequence: 'medium' }),
      { ...ctx, consecutiveTestFailures: ctx.consecutiveTestFailures + 1 },
    );
    assert.equal(c.level, 'BACKGROUND');
    assert.equal(cAfter.level, 'DECISION');
    assert.equal(cAfter.action, 'NOTIFY');
    assert.equal(cAfter.ruleId, 'test-failure-streak');
  });
});

describe('AttentionEngine — reversibility and task alignment boundaries', () => {
  const engine = new AttentionEngine();

  test('high + irreversible + certain → DECISION (irreversibility raises the bar)', () => {
    const c = engine.classify(
      baseInput({ consequence: 'high', reversibility: 'irreversible', uncertainty: 0.05 }),
    );
    assert.equal(c.level, 'DECISION');
    assert.equal(c.ruleId, 'irreversible-high');
  });

  test('high + reversible + certain + aligned → BACKGROUND (agent keeps working)', () => {
    const c = engine.classify(
      baseInput({ consequence: 'high', reversibility: 'reversible', uncertainty: 0.2 }),
    );
    assert.equal(c.level, 'BACKGROUND');
    assert.equal(c.ruleId, 'high-certain-taskaligned');
  });

  test('uncertainty boundary at exactly 0.5 is treated as certain', () => {
    const c = engine.classify(
      baseInput({ consequence: 'high', uncertainty: 0.5 }),
    );
    assert.equal(c.ruleId, 'high-certain-taskaligned');
    assert.equal(c.level, 'BACKGROUND');
  });

  test('uncertainty just above 0.5 crosses into DECISION', () => {
    const c = engine.classify(
      baseInput({ consequence: 'high', uncertainty: 0.51 }),
    );
    assert.equal(c.ruleId, 'ambiguous-high');
    assert.equal(c.level, 'DECISION');
  });

  test('off-task high action pauses for confirmation', () => {
    const c = engine.classify(
      baseInput({ consequence: 'high', taskAligned: false, uncertainty: 0.1, reversibility: 'reversible' }),
    );
    assert.equal(c.level, 'DECISION');
    assert.equal(c.ruleId, 'off-task-medium-plus');
  });

  test('critical is at least DECISION; silent is not', () => {
    assert.equal(levelAtLeast('CRITICAL', 'DECISION'), true);
    assert.equal(levelAtLeast('SILENT', 'DECISION'), false);
    assert.equal(levelAtLeast('DECISION', 'DECISION'), true);
  });
});

describe('AttentionEngine — determinism and extensibility', () => {
  test('classification is a pure function: same inputs, same output', () => {
    const engine = new AttentionEngine();
    const input = baseInput({ consequence: 'high', uncertainty: 0.9 });
    const a = engine.classify(input);
    const b = engine.classify(input);
    assert.deepEqual(a, b);
  });

  test('custom high-priority rule can override defaults', () => {
    const engine = new AttentionEngine();
    engine.addRule({
      id: 'always-decide-writes',
      description: 'In this stricter profile, every write is a decision',
      priority: 2000,
      when: (i) => i.eventType === 'file.changed',
      classify: () => ({
        level: 'DECISION',
        action: 'PAUSE',
        rationale: 'Strict profile: file writes require approval.',
        confidence: 1,
      }),
    });
    const c = engine.classify(baseInput({ eventType: 'file.changed' }));
    assert.equal(c.ruleId, 'always-decide-writes');
    assert.equal(c.level, 'DECISION');
  });

  test('low-confidence classifications are flagged for LLM review', () => {
    const engine = new AttentionEngine();
    engine.addRule({
      id: 'vague-custom',
      description: 'A custom rule that cannot resolve confidently',
      priority: 3000,
      when: (i) => i.eventType === 'file.changed',
      classify: () => ({
        level: 'BACKGROUND',
        action: 'RECORD',
        rationale: 'Unclear intent, needs closer look.',
        confidence: 0.4,
      }),
    });
    const c = engine.classify(baseInput({ eventType: 'file.changed' }));
    assert.equal(c.needsLlmReview, true);
    assert.ok(c.confidence < LLM_REVIEW_CONFIDENCE_FLOOR);
  });
});
