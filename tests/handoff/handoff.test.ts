import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { SqliteHandoffRepository } from '../../src/storage/handoff-repository.js';
import { DecisionQueue } from '../../src/decision/decision-queue.js';
import { HandoffService, renderHandoffBrief } from '../../src/handoff/handoff-service.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';

function setup(dbPath: string = ':memory:') {
  const db = new ConductorDatabase({ path: dbPath });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const handoffRepo = new SqliteHandoffRepository(db);
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  const handoff = new HandoffService({ executionRepo: execRepo, eventRepo, decisionRepo, handoffRepo });
  return { db, manager, decisions, handoff, execRepo, eventRepo, handoffRepo };
}

const setupFile = (dbPath: string) => setup(dbPath);

describe('HandoffService — structured state (no transcripts)', () => {
  test('captures goal, constraints, completed work, files, decisions, failures, tests, risks', () => {
    const s = setup();
    const exec = workedExampleSync(s);

    const h = s.handoff.createHandoff(exec.id, { fromAgentId: 'agent-alpha', toAgentId: 'agent-beta' });

    assert.equal(h.goal, 'add csv export to reports');
    assert.deepEqual(h.constraints, ['no new runtime deps']);
    assert.deepEqual(h.completedWork, ['csv writer core implemented']);
    assert.ok(h.workspace.filesCreated.includes('src/csv.ts'));
    assert.equal(h.importantDecisions.length, 1);
    assert.equal(h.importantDecisions[0].resolution?.customValue, 'Stream; files can exceed RAM');
    assert.ok(h.failedAttempts.some((f) => f.error.includes('quotes not escaped')));
    assert.deepEqual(h.tests.passing, ['csv basic']);
    assert.deepEqual(h.tests.failing, ['csv escaping']);
    assert.deepEqual(h.risks, ['escaping edge cases unresolved']);
    assert.ok(h.recommendedNextAction.length > 0);
    assert.ok(h.contextSummary.includes('Stream'));
    s.db.close();
  });

  test('handoff persists, reloads identically, and marks execution HANDOFF_PENDING', () => {
    const s = setup();
    const exec = workedExampleSync(s);
    const h = s.handoff.createHandoff(exec.id, { fromAgentId: 'a', toAgentId: 'b' });

    const loaded = s.handoffRepo.findById(h.handoffId);
    // Persistence is JSON — normalize undefined-valued keys out of the comparison.
    assert.deepEqual(
      JSON.parse(JSON.stringify(loaded)),
      JSON.parse(JSON.stringify(h)),
    );

    const stored = s.execRepo.findById(exec.id)!;
    assert.equal(stored.status, 'HANDOFF_PENDING');
    s.db.close();
  });

  test('adopt transfers the execution to the new agent and resumes it', () => {
    const s = setup();
    const exec = workedExampleSync(s);
    const h = s.handoff.createHandoff(exec.id, { fromAgentId: 'agent-alpha' });

    const { handoff: adopted, brief } = s.handoff.adoptHandoff(h.handoffId, 'agent-beta');
    assert.equal(adopted.toAgentId, 'agent-beta');

    const stored = s.execRepo.findById(exec.id)!;
    assert.equal(stored.status, 'RUNNING');
    assert.equal(stored.agent.id, 'agent-beta');

    const text = renderHandoffBrief(adopted);
    assert.match(text, /Trust this brief over any memory/);
    assert.match(text, /Completed \(do NOT redo\)[\s\S]*csv writer core implemented/);
    assert.match(text, /Failed approaches[\s\S]*quotes not escaped/);
    assert.match(text, /Decisions made \(binding\)[\s\S]*Stream; files can exceed RAM/);
    s.db.close();
  });

  test('cross-process handoff: a fresh runtime loads the full brief from disk', () => {
    const ws = mkdtempSync(join(tmpdir(), 'conductor-handoff-'));
    const dbFile = join(ws, 'c.db');

    const s1 = setupFile(dbFile);
    const exec = workedExampleSync(s1);
    const h = s1.handoff.createHandoff(exec.id, { fromAgentId: 'alpha' });
    s1.db.close();

    // Runtime #2 (new process equivalent): loads by id from disk alone.
    const s2 = setupFile(dbFile);
    const reloaded = s2.handoff.loadHandoff(h.handoffId);
    assert.equal(reloaded.goal, 'add csv export to reports');
    assert.deepEqual(reloaded.completedWork, ['csv writer core implemented']);
    assert.equal(reloaded.importantDecisions[0].resolution?.customValue, 'Stream; files can exceed RAM');
    assert.deepEqual(reloaded.tests.failing, ['csv escaping']);
    const { brief } = s2.handoff.adoptHandoff(h.handoffId, 'beta');
    assert.match(brief, /csv writer core implemented/);
    s2.db.close();
    rmSync(ws, { recursive: true, force: true });
  });
});

function workedExampleSync(s: ReturnType<typeof setup>) {
  const exec = s.manager.createExecution({
    goal: 'add csv export to reports',
    workspaceRoot: '/srv/reports',
    constraints: ['no new runtime deps'],
    agent: { id: 'agent-alpha' },
  });
  s.manager.processEvent(
    EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal: 'x' }),
  );
  s.manager.processEvent(
    EventAdapter.createEvent(exec.id, 'file.changed', {
      executionId: exec.id, filePath: 'src/csv.ts', action: 'created',
      toolName: 'write', consequence: 'low', reversibility: 'reversible',
    }),
  );
  s.manager.processEvent(
    EventAdapter.createEvent(exec.id, 'test.failed', {
      executionId: exec.id, testName: 'csv escaping', error: 'quotes not escaped',
    }),
  );
  s.manager.processEvent(
    EventAdapter.createEvent(exec.id, 'test.passed', { executionId: exec.id, testName: 'csv basic' }),
  );
  s.manager.processEvent(
    EventAdapter.createEvent(exec.id, 'agent.question', {
      executionId: exec.id, question: 'Stream or buffer large exports?', consequence: 'high',
    }),
  );
  const d = s.decisions.pending()[0];
  s.decisions.resolve(d.id, 'custom', { customValue: 'Stream; files can exceed RAM' });
  const stored = s.execRepo.findById(exec.id)!;
  stored.addCompletedWork('csv writer core implemented');
  stored.addRisk('escaping edge cases unresolved');
  s.execRepo.save(stored);
  return exec;
}
