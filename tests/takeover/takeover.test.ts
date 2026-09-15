import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { SqliteTakeoverRepository } from '../../src/storage/takeover-repository.js';
import { DecisionQueue } from '../../src/decision/decision-queue.js';
import { TakeoverService } from '../../src/takeover/takeover-service.js';
import {
  captureWorkspaceSnapshot,
  diffSnapshots,
  scanWorkspaceFiles,
  type GitRunner,
} from '../../src/takeover/workspace-snapshot.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';
import { TakeoverError } from '../../src/domain/errors.js';

/** Non-git runner for pure-fs tests. */
const noGit: GitRunner = () => ({ ok: false, stdout: '' });

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'conductor-ws-'));
}

function setup(workspaceRoot: string) {
  const db = new ConductorDatabase({ path: ':memory:' });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const takeoverRepo = new SqliteTakeoverRepository(db);
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  const takeover = new TakeoverService({
    executionRepo: execRepo,
    eventRepo,
    decisionRepo,
    takeoverRepo,
    git: noGit,
  });
  return { db, manager, decisions, takeover, execRepo, eventRepo, takeoverRepo, workspaceRoot };
}

describe('Workspace snapshots & diffs', () => {
  test('detects created, modified, and deleted files between snapshots', () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'keep.txt'), 'same');
    writeFileSync(join(ws, 'edit.txt'), 'v1');
    writeFileSync(join(ws, 'remove.txt'), 'bye');

    const before = captureWorkspaceSnapshot(ws, noGit);
    writeFileSync(join(ws, 'edit.txt'), 'v2 with much more content');
    rmSync(join(ws, 'remove.txt'));
    writeFileSync(join(ws, 'new.txt'), 'created');
    const after = captureWorkspaceSnapshot(ws, noGit);

    const diff = diffSnapshots(before, after);
    assert.ok(diff.created.includes('new.txt'));
    assert.ok(diff.deleted.includes('remove.txt'));
    assert.ok(diff.modified.includes('edit.txt'));
    assert.ok(!diff.modified.includes('keep.txt'));
    rmSync(ws, { recursive: true, force: true });
  });

  test('scan skips node_modules and is stable-sorted', () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'b.txt'), 'b');
    writeFileSync(join(ws, 'a.txt'), 'a');
    writeFileSync(join(ws, 'node_modules'), 'x'); // file, not dir, still included
    const files = scanWorkspaceFiles(ws);
    assert.deepEqual(
      files.map((f) => f.path),
      ['a.txt', 'b.txt', 'node_modules'],
    );
    rmSync(ws, { recursive: true, force: true });
  });

  test('git-backed snapshot records branch and status when git reports a repo', () => {
    const ws = tempWorkspace();
    const fakeGit: GitRunner = (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return { ok: true, stdout: 'true' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, stdout: 'abc123' };
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'feature/x' };
      if (args[0] === 'status') return { ok: true, stdout: ' M src/a.ts\n?? src/b.ts' };
      return { ok: false, stdout: '' };
    };
    const snap = captureWorkspaceSnapshot(ws, fakeGit);
    assert.equal(snap.isGitRepo, true);
    assert.equal(snap.branch, 'feature/x');
    assert.equal(snap.headCommit, 'abc123');
    assert.equal(snap.gitStatus.length, 2);
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('TakeoverService — freeze / capture / continue / reconcile', () => {
  test('take-over freezes state, captures workspace, and returns a brief', () => {
    const ws = tempWorkspace();
    const { manager, takeover } = setup(ws);
    const exec = manager.createExecution({ goal: 'add rate limiting', workspaceRoot: ws });
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal: 'x' }),
    );
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'file.changed', {
        executionId: exec.id,
        filePath: 'limiter.ts',
        action: 'created',
        toolName: 'write',
        consequence: 'low',
        reversibility: 'reversible',
      }),
    );

    const result = takeover.takeOver(exec.id, { actor: 'shubh', notes: 'boundary bug' });

    assert.equal(result.execution.status, 'TAKEN_OVER');
    assert.ok(result.brief.includes('add rate limiting'));
    assert.ok(result.brief.includes('created: limiter.ts'), 'brief lists current files');
    assert.ok(result.context.workspaceRoot === ws);
    assert.equal(result.record?.status, 'active', 'takeover episode persisted as active');
    rmSync(ws, { recursive: true, force: true });
  });

  test('continue detects human edits, reconciles them, and hands back a merged brief', () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'handler.ts'), 'agent version');
    const { manager, takeover, execRepo } = setup(ws);
    const exec = manager.createExecution({ goal: 'fix webhook handler', workspaceRoot: ws });
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal: 'x' }),
    );
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'file.changed', {
        executionId: exec.id,
        filePath: 'handler.ts',
        action: 'modified',
        toolName: 'edit',
        consequence: 'low',
        reversibility: 'reversible',
      }),
    );

    takeover.takeOver(exec.id, { actor: 'shubh', notes: 'fix myself' });

    // Human edits the workspace out-of-band
    writeFileSync(join(ws, 'handler.ts'), 'human corrected version with more text');
    writeFileSync(join(ws, 'NOTES.md'), 'context for the agent');

    const result = takeover.continue(exec.id, { actor: 'shubh', notes: 'retry with my fix' });

    assert.equal(result.execution.status, 'RUNNING', 'execution returned to agent');
    assert.ok(result.modifications.modified.includes('handler.ts'));
    assert.ok(result.modifications.created.includes('NOTES.md'));
    assert.ok(result.brief.includes('Human modifications made during take-over'));
    assert.ok(result.brief.includes('authoritative'));
    assert.ok(result.brief.includes('retry with my fix'));

    // Reconciled state persisted
    const reloaded = execRepo.findById(exec.id);
    assert.ok(reloaded);
    assert.equal(reloaded.status, 'RUNNING');
    assert.ok(
      reloaded.interventions.some(
        (i) => i.type === 'continue' && i.filesChanged?.includes('handler.ts'),
      ),
    );
    rmSync(ws, { recursive: true, force: true });
  });

  test('take-over of a terminal execution is rejected', () => {
    const ws = tempWorkspace();
    const { manager, takeover } = setup(ws);
    const exec = manager.createExecution({ goal: 'done already', workspaceRoot: ws });
    exec.start();
    exec.complete();
    manager.executionRepo.save(exec);
    assert.throws(() => takeover.takeOver(exec.id), TakeoverError);
    rmSync(ws, { recursive: true, force: true });
  });

  test('continue without an active take-over is rejected', () => {
    const ws = tempWorkspace();
    const { manager, takeover } = setup(ws);
    const exec = manager.createExecution({ goal: 'running', workspaceRoot: ws });
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal: 'x' }),
    );
    assert.throws(() => takeover.continue(exec.id), TakeoverError);
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('Phase 5 acceptance — full take-over/continue workflow (real git repo)', () => {
  test('9-step workflow: work, pause, decide, freeze, human edits, continue, agent resumes on truth', () => {
    const ws = tempWorkspace();
    const gitInit = () => {
      execFileSync('git', ['init', '-q'], { cwd: ws });
      execFileSync('git', ['config', 'user.email', 'conductor@test.local'], { cwd: ws });
      execFileSync('git', ['config', 'user.name', 'Conductor Test'], { cwd: ws });
    };
    gitInit();
    writeFileSync(join(ws, 'payment.ts'), 'export const charge = () => 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: ws });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: ws });

    const db = new ConductorDatabase({ path: ':memory:' });
    const execRepo = new SqliteExecutionRepository(db);
    const eventRepo = new SqliteEventRepository(db);
    const decisionRepo = new SqliteDecisionRepository(db);
    const takeoverRepo = new SqliteTakeoverRepository(db);
    const decisions = new DecisionQueue(decisionRepo, execRepo);
    const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
    const takeover = new TakeoverService({ executionRepo: execRepo, eventRepo, decisionRepo, takeoverRepo });

    // 1. Execution exists with real history
    const exec = manager.createExecution({ goal: 'add idempotency keys to payments', workspaceRoot: ws });
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal: 'x' }),
    );
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'file.changed', {
        executionId: exec.id, filePath: 'payment.ts', action: 'modified',
        toolName: 'edit', consequence: 'medium', reversibility: 'reversible',
      }),
    );
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'test.failed', {
        executionId: exec.id, testName: 'idempotency double-charge', error: 'charged twice',
      }),
    );

    // 2. Agent requests a decision — execution pauses
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'agent.question', {
        executionId: exec.id, question: 'Store idempotency keys in Redis or Postgres?',
        context: 'Redis is ephemeral; Postgres adds a migration', consequence: 'high',
      }),
    );
    assert.equal(manager.getStatus(exec.id).status, 'PAUSED');

    // 3. Human answers
    const pend = decisions.pending();
    assert.equal(pend.length, 1);
    decisions.resolve(pend[0].id, 'custom', { customValue: 'Postgres — durability matters here' });
    assert.equal(manager.getStatus(exec.id).status, 'RUNNING');

    // 4. Developer takes over
    const to = takeover.takeOver(exec.id, { actor: 'shubh', notes: 'migration is wrong' });
    assert.equal(to.execution.status, 'TAKEN_OVER');
    assert.ok(to.brief.includes('Postgres — durability matters here'), 'brief carries decision answer');
    assert.ok(to.brief.includes('idempotency double-charge'), 'brief carries failed approach');
    assert.ok(to.brief.includes('add idempotency keys'), 'brief carries original goal');

    // 5. Workspace snapshot captured at freeze (git state present)
    assert.ok(to.record);
    assert.equal(to.record.snapshot.isGitRepo, true);
    assert.ok(to.record.snapshot.headCommit && to.record.snapshot.headCommit.length === 40);

    // 6. Human edits outside Conductor's knowledge
    writeFileSync(join(ws, 'payment.ts'), 'export const charge = (key: string) => 2; // human fixed\n');
    writeFileSync(join(ws, 'migration.sql'), 'ALTER TABLE payments ADD COLUMN idem_key TEXT;\n');

    // 7. Continue: changes detected + reconciled + new brief
    const back = takeover.continue(exec.id, { actor: 'shubh', notes: 'use the .sql, drop ORM migration' });
    assert.ok(back.modifications.modified.includes('payment.ts'));
    assert.ok(back.modifications.created.includes('migration.sql'));
    assert.ok(back.brief.includes('payment.ts'), 'agent brief names human-edited files');
    assert.ok(back.brief.includes('use the .sql, drop ORM migration'));
    assert.equal(back.execution.status, 'RUNNING');

    // 8. Execution state has the interventions and files
    const state = execRepo.findById(exec.id);
    assert.ok(state);
    assert.equal(state.interventions.filter((i) => i.type === 'take_over').length, 1);
    assert.equal(state.interventions.filter((i) => i.type === 'continue').length, 1);
    assert.ok(state.workspace.filesModified.includes('payment.ts'));

    // 9. History shows the human loop end-to-end
    const history = eventRepo.listByExecution(exec.id, { limit: 100 });
    const kinds = history.filter((e) => e.type === 'human.intervention').map((e) => e.payload.action);
    assert.deepEqual(kinds, ['take_over', 'continue']);
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });
});
