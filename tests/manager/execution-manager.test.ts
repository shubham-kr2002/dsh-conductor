import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';
import { renderStatus, renderHistory } from '../../src/cli/commands.js';

describe('ExecutionManager & CLI', () => {
  function setup() {
    const db = new ConductorDatabase({ path: ':memory:' });
    const execRepo = new SqliteExecutionRepository(db);
    const eventRepo = new SqliteEventRepository(db);
    const manager = new ExecutionManager(execRepo, eventRepo);
    return { db, execRepo, eventRepo, manager };
  }

  test('creates execution and observes live event flow', () => {
    const { manager } = setup();

    const exec = manager.createExecution({
      goal: 'Build authentication microservice',
      workspaceRoot: '/workspace/auth',
    });

    assert.equal(manager.activeExecutionId, exec.id);
    assert.equal(exec.status, 'STARTING');

    // Subscribe to events
    const received: string[] = [];
    const unsubscribe = manager.subscribe((evt) => {
      received.push(evt.type);
    });

    // 1. Process execution.started
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', {
        executionId: exec.id,
        goal: exec.goal,
      }),
    );

    let status = manager.getStatus(exec.id);
    assert.equal(status.status, 'RUNNING');

    // 2. Process tool calls
    const toolEvents = EventAdapter.adaptToolCall(exec.id, {
      callId: 'call-1',
      name: 'write',
      arguments: { file_path: 'src/token.ts' },
    });
    for (const evt of toolEvents) {
      manager.processEvent(evt);
    }

    status = manager.getStatus(exec.id);
    assert.equal(status.toolCallCount, 1);
    assert.equal(status.filesModifiedCount, 1);

    // 3. Process test execution
    const testEvents = EventAdapter.adaptToolResult(
      exec.id,
      { callId: 'call-t', toolName: 'bash', isError: false },
      { command: 'npm test' },
    );
    for (const evt of testEvents) {
      manager.processEvent(evt);
    }

    // 4. Process execution.completed
    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.completed', {
        executionId: exec.id,
        summary: 'All authentication endpoints implemented and verified',
        durationMs: 45000,
        completedWork: ['JWT token generation', 'Password hashing'],
      }),
    );

    status = manager.getStatus(exec.id);
    assert.equal(status.status, 'COMPLETED');
    assert.equal(received.length, 6); // execution.started, tool.called, file.changed, command.completed, test.passed, execution.completed

    unsubscribe();
  });

  test('generates formatted status and history for CLI', () => {
    const { manager } = setup();

    const exec = manager.createExecution({
      goal: 'Create REST API endpoints',
      workspaceRoot: '/workspace/api',
    });

    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'execution.started', {
        executionId: exec.id,
        goal: exec.goal,
      }),
    );

    manager.processEvent(
      EventAdapter.createEvent(exec.id, 'tool.called', {
        toolName: 'read',
        arguments: { file_path: 'package.json' },
      }),
    );

    const summary = manager.getStatus(exec.id);
    const statusText = renderStatus(summary);
    assert.ok(statusText.includes('CONDUCTOR EXECUTION STATUS'));
    assert.ok(statusText.includes(exec.id));
    assert.ok(statusText.includes('Create REST API endpoints'));
    assert.ok(statusText.includes('[RUNNING]'));

    const historyEvents = manager.getHistory(exec.id);
    const historyText = renderHistory(historyEvents);
    assert.ok(historyText.includes('CONDUCTOR EXECUTION HISTORY'));
    assert.ok(historyText.includes('execution.started'));
    assert.ok(historyText.includes('tool.called'));
  });
});
