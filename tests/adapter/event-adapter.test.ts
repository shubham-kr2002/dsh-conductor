import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventAdapter } from '../../src/adapter/event-adapter.js';

describe('EventAdapter', () => {
  const execId = 'exec-test-1';

  test('adapts bash tool call to tool.called and command.started', () => {
    const events = EventAdapter.adaptToolCall(execId, {
      callId: 'call-1',
      name: 'bash',
      arguments: { command: 'npm test', workdir: '/app' },
    });

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'tool.called');
    assert.equal(events[0].payload.toolName, 'bash');
    assert.equal(events[1].type, 'command.started');
    assert.equal(events[1].payload.command, 'npm test');
    assert.equal(events[1].payload.cwd, '/app');
  });

  test('adapts file write/edit tool call to file.changed', () => {
    const writeEvents = EventAdapter.adaptToolCall(execId, {
      callId: 'call-w',
      name: 'write',
      arguments: { file_path: 'src/main.ts', content: 'console.log()' },
    });

    assert.equal(writeEvents.length, 2);
    assert.equal(writeEvents[1].type, 'file.changed');
    assert.equal(writeEvents[1].payload.filePath, 'src/main.ts');
    assert.equal(writeEvents[1].payload.action, 'created');

    const editEvents = EventAdapter.adaptToolCall(execId, {
      callId: 'call-e',
      name: 'edit',
      arguments: { file_path: 'src/main.ts', old_string: 'a', new_string: 'b' },
    });

    assert.equal(editEvents.length, 2);
    assert.equal(editEvents[1].type, 'file.changed');
    assert.equal(editEvents[1].payload.filePath, 'src/main.ts');
    assert.equal(editEvents[1].payload.action, 'modified');
  });

  test('adapts ask_user_question to agent.question', () => {
    const events = EventAdapter.adaptToolCall(execId, {
      callId: 'call-q',
      name: 'ask_user_question',
      arguments: {
        questions: [
          { question: 'Do you want to run database migration?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
    });

    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'agent.question');
    assert.equal(events[1].payload.question, 'Do you want to run database migration?');
  });

  test('adapts test command results to test.passed and test.failed', () => {
    // Passed test
    const passEvents = EventAdapter.adaptToolResult(
      execId,
      {
        callId: 'c-pass',
        toolName: 'bash',
        isError: false,
        value: '14 tests passed',
      },
      { command: 'pnpm test' },
    );

    assert.equal(passEvents.length, 2);
    assert.equal(passEvents[0].type, 'command.completed');
    assert.equal(passEvents[1].type, 'test.passed');
    assert.equal(passEvents[1].payload.testName, 'pnpm test');

    // Failed test
    const failEvents = EventAdapter.adaptToolResult(
      execId,
      {
        callId: 'c-fail',
        toolName: 'bash',
        isError: true,
        error: { name: 'TestError', code: '1', message: 'Assertion failed' },
      },
      { command: 'node --test tests/app.test.js' },
    );

    assert.equal(failEvents.length, 2);
    assert.equal(failEvents[0].type, 'command.completed');
    assert.equal(failEvents[1].type, 'test.failed');
    assert.equal(failEvents[1].payload.error, 'Assertion failed');
  });

  test('adapts raw DSH session events', () => {
    // turn/start
    const startEvts = EventAdapter.adaptSessionEvent(execId, {
      type: 'turn/start',
      data: { turn: 1 },
    });
    assert.equal(startEvts.length, 1);
    assert.equal(startEvts[0].type, 'execution.started');

    // tool/call in session
    const toolEvts = EventAdapter.adaptSessionEvent(execId, {
      type: 'tool/call',
      data: {
        callId: 'c-sess',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'app.js' }),
      },
    });
    assert.equal(toolEvts.length, 2);
    assert.equal(toolEvts[0].type, 'tool.called');
    assert.equal(toolEvts[1].type, 'file.changed');

    // turn/end completed
    const endEvts = EventAdapter.adaptSessionEvent(execId, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    assert.equal(endEvts.length, 1);
    assert.equal(endEvts[0].type, 'execution.completed');
  });
});
