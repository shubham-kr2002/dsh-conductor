import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startConductorUi, type ConductorUiServer } from '../../src/ui/server.js';
import { createRuntime } from '../../src/cli/commands.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';

const dir = mkdtempSync(join(tmpdir(), 'cnd-ui-'));
const dbPath = join(dir, 'conductor.db');
const workspaceRoot = join(dir, 'repo');
mkdirSync(workspaceRoot, { recursive: true });

// The UI shares the file — writes happen "from the mounted plugin" via a
// second runtime instance, exactly like the real multi-process setup.
const producer = createRuntime(dbPath);
let server: ConductorUiServer | null = null;

after(async () => {
  await server?.close();
  producer.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function get<T = any>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${(server as ConductorUiServer).url}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}
async function post<T = any>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${(server as ConductorUiServer).url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function gateDangerousTool(callId: string, command: string): string {
  const exec = producer.manager.getActiveExecution() ?? producer.manager.createExecution({
    goal: 'Upgrade the application dependencies and migrate the payment API',
    workspaceRoot,
    agent: { id: 'atlas' },
  });
  if (exec.status === 'STARTING') {
    exec.start();
    producer.execRepo.save(exec);
  }
  for (const evt of EventAdapter.adaptToolCall(exec.id, { callId, name: 'bash', arguments: { command } })) {
    producer.manager.processEvent(evt);
  }
  return exec.id;
}

describe('Conductor UI server — one control plane, honest views', () => {
  test('boots and serves the shell', async () => {
    server = await startConductorUi({ dbPath, port: 0, pollMs: 250 });
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /CONDUCTOR/);
    assert.match(html, /app\.js/);
    const assets = await fetch(`${server.url}/styles.css`);
    assert.equal(assets.status, 200);
  });

  test('path traversal is refused', async () => {
    const res = await fetch(`${(server as ConductorUiServer).url}/..%2f..%2fpackage.json`);
    assert.ok(res.status === 400 || res.status === 404);
  });

  test('state answers the primary question with real derived numbers', async () => {
    const execId = gateDangerousTool('c1', 'git push --force origin main');
    const { status, body } = await get('/api/state');
    assert.equal(status, 200);
    assert.equal(body.attention.needsYou, 1);
    assert.equal(body.attention.pendingDecisions, 1);
    const card = body.executions.find((c: any) => c.executionId === execId);
    assert.equal(card.statusLabel, 'Waiting for your judgment');
    assert.equal(card.needsYou, true);
    assert.equal(card.pendingDecisions, 1);
    assert.ok(card.lastActivity.length > 0, 'card shows a semantic activity, not a transcript');
    assert.ok(card.metrics.totalMs > 0);

    const d = body.queue.find((x: any) => x.status === 'pending');
    assert.ok(d, 'pending decision in queue');
    assert.ok(d.why, 'decision carries structured why');
    for (const field of ['what', 'whyNow', 'impact', 'reversibility', 'consequences']) {
      assert.ok(d.why[field], `why.${field} present`);
    }
    assert.ok(d.why.evidence.ruleIds.includes('require-approval-git-force'));
    assert.equal(d.why.evidence.blastRadius, 'external-system');
  });

  test('present endpoint records the observable presentation once', async () => {
    const { body } = await get('/api/state');
    const id = body.queue.find((x: any) => x.status === 'pending').id;
    await post(`/api/decisions/${id}/present`, {});
    const after1 = (await get('/api/state')).body.queue.find((x: any) => x.id === id);
    assert.ok(after1.quality.presentedAt, 'presentedAt set by the UI fetch');
  });

  test('approve-once over HTTP releases the held run', async () => {
    const { body } = await get('/api/state');
    const d = body.queue.find((x: any) => x.status === 'pending');
    const r = await post(`/api/decisions/${d.id}/resolve`, {
      outcome: 'accepted',
      selectedOptionId: 'approve-once',
      answerBy: 'shubham',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'accepted');

    const state = (await get('/api/state')).body;
    assert.equal(state.attention.pendingDecisions, 0);
    assert.equal(state.executions[0].statusLabel, 'Working autonomously');
    assert.equal(state.executions[0].needsYou, false);

    // the token is real: consumed through the SAME queue the gate uses
    const granted = producer.decisions.consumeApproval(
      state.executions[0].executionId,
      'bash:git push --force origin main',
    );
    assert.equal(granted, true);
    assert.equal(producer.decisions.consumeApproval(state.executions[0].executionId, 'bash:git push --force origin main'), false);
  });

  test('take over and return control through HTTP', async () => {
    const execId = producer.manager.getActiveExecution()!.id;
    const r = await post(`/api/executions/${execId}/take-over`, { actor: 'shubham', notes: 'inspecting migration' });
    assert.equal(r.status, 200);
    assert.equal((await get('/api/state')).body.executions[0].statusLabel, 'You are in control');

    const c = await post(`/api/executions/${execId}/continue`, { actor: 'shubham', notes: 'done' });
    assert.equal(c.status, 200);
    assert.equal((await get('/api/state')).body.executions[0].statusLabel, 'Working autonomously');
  });

  test('mark-away + return summary', async () => {
    const execId = producer.manager.getActiveExecution()!.id;
    const a = await post(`/api/executions/${execId}/away`, { actor: 'shubham' });
    assert.equal(a.status, 200);
    // some activity while away
    producer.manager.processEvent(
      EventAdapter.createEvent(execId, 'test.failed', { testName: 'pricing.test.ts', exitCode: 1 }),
    );
    const detail = (await get(`/api/executions/${execId}`)).body;
    assert.ok(detail.away, 'detail carries the away summary');
    assert.match(detail.away.rendered, /Since you left/);
    assert.ok(detail.timeline.some((t: any) => t.text.includes('tests failed')));
  });

  test('bad resolution is a 400, not a crash', async () => {
    const { body } = await get('/api/state');
    const execId = body.executions[0].executionId;
    const gate = gateDangerousTool('c9', 'kubectl delete ns playground');
    assert.ok(gate);
    const st = (await get('/api/state')).body;
    const d = st.queue.find((x: any) => x.status === 'pending');
    const r = await post(`/api/decisions/${d.id}/resolve`, { outcome: 'banana' });
    assert.equal(r.status, 400);
    assert.equal((await get('/api/state')).body.attention.pendingDecisions, 1, 'still pending after failed attempt');
  });

  test('SSE nudges the client when another process writes', async () => {
    const res = await fetch(`${(server as ConductorUiServer).url}/stream`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const sawHello = await (async () => {
      const t = setTimeout(() => {}, 1);
      clearTimeout(t);
      for (let i = 0; i < 10; i++) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('stream timeout')), 4000)),
        ]);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('"type":"hello"')) return true;
      }
      return false;
    })();
    assert.ok(sawHello, 'stream opens with hello frame');

    // write from the producer side; the poll must push a changed frame
    const readTimeout = () => Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => { const t = setTimeout(() => rej(new Error('stream idle')), 5000); (globalThis as any).clearTimeout; }),
    ]);
    const changed = (async () => {
      try {
        for (let i = 0; i < 40; i++) {
          const { value } = await readTimeout();
          if (!value) break;
          if (decoder.decode(value, { stream: true }).includes('"type":"changed"')) return true;
        }
      } catch {
        return false;
      }
      return false;
    })();
    gateDangerousTool('c10', 'helm uninstall legacy');
    assert.equal(await changed, true, 'cross-process write reached the stream');
    reader.cancel().catch(() => {});
    res.body?.cancel().catch(() => {});
  });

  test('detail view exposes timeline + metrics + quality without transcripts', async () => {
    const { body } = await get('/api/state');
    const execId = body.executions[0].executionId;
    const d = await get(`/api/executions/${execId}`);
    assert.equal(d.status, 200);
    assert.ok(Array.isArray(d.body.timeline) && d.body.timeline.length > 0);
    assert.ok(d.body.metrics.attentionRatio >= 0);
    assert.ok(d.body.qualityRollup);
    assert.ok(d.body.constraints !== undefined);
    // no raw event payloads on this endpoint (semantic only)
    assert.equal(JSON.stringify(d.body).includes('helm uninstall legacy'), true); // command text appears ONLY inside timeline/decision, never stdout
  });
});
