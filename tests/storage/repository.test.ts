import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { Execution } from '../../src/domain/execution.js';
import type { ConductorEvent } from '../../src/types/event.js';

describe('SQLite Repositories', () => {
  test('persists and reloads execution with full fidelity', () => {
    const db = new ConductorDatabase({ path: ':memory:' });
    const repo = new SqliteExecutionRepository(db);

    const exec = Execution.create({
      goal: 'Write comprehensive test suite',
      workspaceRoot: '/test/workspace',
      constraints: ['TypeScript', 'Node.js 24'],
      agent: { id: 'test-agent', model: 'agy-flash' },
    });

    exec.start();
    exec.recordToolCall();
    exec.recordFileChange('src/test.ts', 'created');
    exec.addCompletedWork('Scaffolded tests');
    exec.takeOver('tester', 'Checking manual conditions');
    exec.continueFromTakeOver('tester', 'Resumed', ['src/test.ts']);

    // Persist
    repo.save(exec);

    // Reload
    const loaded = repo.findById(exec.id);
    assert.ok(loaded !== null);
    assert.equal(loaded.id, exec.id);
    assert.equal(loaded.goal, 'Write comprehensive test suite');
    assert.equal(loaded.status, 'RUNNING');
    assert.equal(loaded.agent.id, 'test-agent');
    assert.equal(loaded.agent.model, 'agy-flash');
    assert.deepEqual(loaded.completedWork, ['Scaffolded tests']);
    assert.equal(loaded.interventions.length, 2);
    assert.equal(loaded.transitions.length, exec.transitions.length);
    assert.equal(loaded.metrics.toolCallCount, 1);

    // Update state and re-save
    loaded.complete('Finished all test work');
    repo.save(loaded);

    const reloaded = repo.findById(exec.id);
    assert.ok(reloaded !== null);
    assert.equal(reloaded.status, 'COMPLETED');
    assert.equal(reloaded.isTerminal(), true);
  });

  test('event listByExecution: limit without offset returns NEWEST N chronologically', () => {
    const db = new ConductorDatabase({ path: ':memory:' });
    const execRepo = new SqliteExecutionRepository(db);
    const eventRepo = new SqliteEventRepository(db);
    const host = Execution.create({ goal: 'limit probe', workspaceRoot: '/r' });
    execRepo.save(host);
    for (let i = 1; i <= 10; i++) {
      const evt: ConductorEvent = {
        id: `evt-${String(i).padStart(2, '0')}`,
        executionId: host.id,
        type: 'file.changed',
        timestamp: 1_000 + i,
        payload: { path: `f${String(i)}` },
        source: 'conductor',
      };
      eventRepo.save(evt);
    }
    const tail = eventRepo.listByExecution(host.id, { limit: 3 });
    assert.deepEqual(tail.map((e) => e.id), ['evt-08', 'evt-09', 'evt-10']);
    assert.ok(tail[0]!.timestamp < tail[2]!.timestamp, 'returned in chronological order');
    // positional pagination (explicit offset) still counts from the start
    const page = eventRepo.listByExecution(host.id, { limit: 3, offset: 2 });
    assert.deepEqual(page.map((e) => e.id), ['evt-03', 'evt-04', 'evt-05']);
    // no limit = full history, unchanged
    assert.equal(eventRepo.listByExecution(host.id).length, 10);
  });

  test('lists and filters executions correctly', () => {
    const db = new ConductorDatabase({ path: ':memory:' });
    const repo = new SqliteExecutionRepository(db);

    const exec1 = Execution.create({ goal: 'Task 1', workspaceRoot: '/w1' });
    exec1.start();
    repo.save(exec1);

    const exec2 = Execution.create({ goal: 'Task 2', workspaceRoot: '/w2' });
    exec2.start();
    exec2.pause();
    repo.save(exec2);

    const exec3 = Execution.create({ goal: 'Task 3', workspaceRoot: '/w3' });
    exec3.start();
    exec3.complete();
    repo.save(exec3);

    const all = repo.list();
    assert.equal(all.length, 3);

    const running = repo.list({ status: 'RUNNING' });
    assert.equal(running.length, 1);
    assert.equal(running[0].id, exec1.id);

    const paused = repo.list({ status: 'PAUSED' });
    assert.equal(paused.length, 1);
    assert.equal(paused[0].id, exec2.id);

    assert.equal(repo.count(), 3);
    assert.equal(repo.count('COMPLETED'), 1);

    // Delete
    const deleted = repo.delete(exec2.id);
    assert.equal(deleted, true);
    assert.equal(repo.findById(exec2.id), null);
    assert.equal(repo.count(), 2);
  });

  test('persists and queries Conductor events', () => {
    const db = new ConductorDatabase({ path: ':memory:' });
    const execRepo = new SqliteExecutionRepository(db);
    const eventRepo = new SqliteEventRepository(db);

    const exec = Execution.create({ goal: 'Event tracking test', workspaceRoot: '/w' });
    execRepo.save(exec);

    const event1: ConductorEvent = {
      id: 'evt-1',
      executionId: exec.id,
      type: 'execution.started',
      timestamp: 1000,
      source: 'conductor',
      payload: { executionId: exec.id, goal: exec.goal },
    };

    const event2: ConductorEvent = {
      id: 'evt-2',
      executionId: exec.id,
      type: 'tool.called',
      timestamp: 2000,
      source: 'agent',
      payload: { toolName: 'read', callId: 'call-1', arguments: { path: 'a.txt' } },
    };

    const event3: ConductorEvent = {
      id: 'evt-3',
      executionId: exec.id,
      type: 'file.changed',
      timestamp: 3000,
      source: 'agent',
      payload: { filePath: 'a.txt', action: 'modified' },
    };

    eventRepo.save(event1);
    eventRepo.save(event2);
    eventRepo.save(event3);

    const events = eventRepo.listByExecution(exec.id);
    assert.equal(events.length, 3);
    assert.equal(events[0].id, 'evt-1');
    assert.equal(events[1].id, 'evt-2');
    assert.equal(events[2].id, 'evt-3');

    const toolEvents = eventRepo.listByExecution(exec.id, { type: 'tool.called' });
    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0].id, 'evt-2');

    assert.equal(eventRepo.countByExecution(exec.id), 3);
  });
});
