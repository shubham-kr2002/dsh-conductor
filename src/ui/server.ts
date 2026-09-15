/**
 * Conductor control surface — HTTP + event stream
 *
 * A deliberately small server (node:http only, zero new dependencies) that
 * exposes the SAME control plane the CLI uses: one SQLite file, the same
 * repositories, DecisionQueue, TakeoverService and derivations. No state
 * lives in the browser; the page is a window onto the database.
 *
 * Live updates: cheapest propagation that works across processes — a poll
 * of a one-row fingerprint query every ~900ms pushed over Server-Sent
 * Events, plus an in-process nudge via manager.subscribe. No Redis, no
 * WebSocket layer.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createRuntime, type ConductorRuntime } from '../cli/commands.js';
import type { Execution } from '../domain/execution.js';
import type { ConductorDecision } from '../types/decision.js';
import { computeAttentionMetrics, type AttentionMetrics } from '../summary/attention-metrics.js';
import { condenseTimeline, type TimelineEntry } from '../summary/timeline.js';
import { statusLanguage, decisionStatusLabel } from '../summary/status-language.js';
import { buildAwaySummary, type AwaySummary } from '../summary/away-mode.js';
import { deriveDecisionQuality, rollupDecisionQuality } from '../decision/decision-quality.js';
import { decisionPriority } from '../decision/decision-queue.js';

export interface ConductorUiOptions {
  /** SQLite file shared with the mounted plugin and the CLI. */
  dbPath: string;
  /** Port for the UI server (0 = ephemeral, used by tests). */
  port?: number;
  host?: string;
  /** Static asset directory; defaults to the ./public shipped beside this module. */
  publicDir?: string;
  /** Cross-process change-detection interval. */
  pollMs?: number;
  runtime?: ConductorRuntime;
  now?: () => number;
}

export interface ConductorUiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

// ── View models (derived, minimal — the browser renders these, computes nothing) ──

interface CardView {
  executionId: string;
  goal: string;
  status: string;
  statusLabel: string;
  statusMeaning: string;
  tone: string;
  needsYou: boolean;
  agent: string;
  phase: string;
  progress: string;
  lastActivity: string;
  filesChanged: number;
  pendingDecisions: number;
  metrics: Pick<AttentionMetrics, 'totalMs' | 'autonomousMs' | 'heldMs' | 'humanControlMs' | 'attentionRatio' | 'interruptions'>;
}

interface DecisionView {
  id: string;
  executionId: string;
  executionGoal: string;
  status: string;
  statusLabel: string;
  title: string;
  question: string;
  context: string;
  impact: string;
  urgency: string;
  confidence: number;
  recommendation?: string;
  options: ConductorDecision['options'];
  why?: ConductorDecision['why'];
  quality: ConductorDecision['quality'];
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
  selectedOptionId?: string;
  customValue?: string;
  priority: number;
  isQuestion: boolean;
}

interface DetailView extends CardView {
  timeline: TimelineEntry[];
  decisions: DecisionView[];
  away?: AwaySummary & { rendered: string };
  interventions: Execution['interventions'];
  constraints: string[];
  workspace: Execution['workspace'];
  completedWork: string[];
  risks: string[];
  qualityRollup: ReturnType<typeof rollupDecisionQuality>;
}

const nowFn = () => Date.now();

export async function startConductorUi(options: ConductorUiOptions): Promise<ConductorUiServer> {
  const host = options.host ?? '127.0.0.1';
  const pollMs = options.pollMs ?? 900;
  if (!existsSync(join(options.publicDir ?? fileURLToPath(new URL('./public/', import.meta.url)), 'index.html'))) {
    throw new Error(
      `UI assets missing at ${options.publicDir ?? './public/'} — run \`pnpm build\` before \`conductor ui\`.`,
    );
  }
  const ownRuntime = !options.runtime;
  const runtime = options.runtime ?? createRuntime(options.dbPath);
  const publicDir = options.publicDir ?? fileURLToPath(new URL('./public/', import.meta.url));

  const streams = new Set<ServerResponse>();
  let lastFingerprint = '';
  let closed = false;

  // ── fingerprint: one cheap aggregate query, safe on the hot path ──
  const fpStmt = runtime.db.raw.prepare(`
    SELECT
      (SELECT COUNT(*) FROM execution_events) AS e,
      (SELECT COUNT(*) FROM executions)       AS x,
      (SELECT MAX(updated_at) FROM executions) AS xu,
      (SELECT COUNT(*) FROM decisions)        AS d,
      (SELECT MAX(updated_at) FROM decisions) AS du,
      (SELECT COUNT(*) FROM decisions WHERE consumed_at IS NOT NULL) AS dc,
      (SELECT COUNT(*) FROM takeovers)        AS t
  `);
  function fingerprint(): string {
    const row = (fpStmt.get as () => unknown)() as Record<string, number | null>;
    return Object.values(row).map((v) => String(v ?? 0)).join(':');
  }

  function broadcast(payload: object): void {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of streams) {
      try {
        res.write(frame);
      } catch {
        streams.delete(res);
      }
    }
  }

  // ── read models ──
  function pendingByExec(): Map<string, ConductorDecision[]> {
    const map = new Map<string, ConductorDecision[]>();
    for (const d of runtime.decisionRepo.list({ status: 'pending' })) {
      const list = map.get(d.executionId) ?? [];
      list.push(d);
      map.set(d.executionId, list);
    }
    return map;
  }

  function cardFor(exec: Execution, pending: ConductorDecision[]): CardView {
    const all = runtime.decisionRepo.list({ executionId: exec.id });
    const takeovers = runtime.takeoverRepo.listByExecution(exec.id).length;
    const metrics = computeAttentionMetrics(exec, all, { now: nowFn(), takeoverCount: takeovers });
    const lang = statusLanguage(exec.status);
    const events = runtime.eventRepo.listByExecution(exec.id, { limit: 120 });
    const timeline = condenseTimeline(events, all, { limit: 40 });
    const last = timeline[timeline.length - 1];
    return {
      executionId: exec.id,
      goal: exec.goal,
      status: exec.status,
      statusLabel: lang.label,
      statusMeaning: lang.meaning,
      tone: lang.tone,
      needsYou: lang.needsYou,
      agent: exec.agent.id,
      phase: exec.currentPhase,
      progress: exec.progressSummary,
      lastActivity: last ? last.text : exec.nextAction ?? 'awaiting first activity',
      filesChanged:
        exec.workspace.filesModified.length + exec.workspace.filesCreated.length + exec.workspace.filesDeleted.length,
      pendingDecisions: pending.length,
      metrics: {
        totalMs: metrics.totalMs,
        autonomousMs: metrics.autonomousMs,
        heldMs: metrics.heldMs,
        humanControlMs: metrics.humanControlMs,
        attentionRatio: metrics.attentionRatio,
        interruptions: metrics.interruptions,
      },
    };
  }

  function decisionView(d: ConductorDecision, execGoal: string): DecisionView {
    return {
      id: d.id,
      executionId: d.executionId,
      executionGoal: execGoal,
      status: d.status,
      statusLabel: decisionStatusLabel(d.status),
      title: d.title,
      question: d.question,
      context: d.context,
      impact: d.impact,
      urgency: d.urgency,
      confidence: d.confidence,
      ...(d.recommendation !== undefined ? { recommendation: d.recommendation } : {}),
      options: d.options,
      ...(d.why !== undefined ? { why: d.why } : {}),
      quality: deriveDecisionQuality(d, runtime.decisionRepo.list({ executionId: d.executionId }), null),
      createdAt: d.createdAt,
      ...(d.resolution
        ? {
            resolvedAt: d.resolution.resolvedAt,
            resolvedBy: d.resolution.resolvedBy,
            ...(d.resolution.selectedOptionId !== undefined ? { selectedOptionId: d.resolution.selectedOptionId } : {}),
            ...(d.resolution.customValue !== undefined ? { customValue: d.resolution.customValue } : {}),
          }
        : {}),
      priority: decisionPriority(d),
      isQuestion: d.title.startsWith('Agent question') || (d.options.length > 0 && !d.subject),
    };
  }

  function stateView(): object {
    const executions = runtime.execRepo.list({});
    const pendings = pendingByExec();
    const cards = executions.map((e) => cardFor(e, pendings.get(e.id) ?? []));
    const active = cards.filter((c) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(c.status));
    const needsYou = cards.filter((c) => c.needsYou);
    const totals = active.reduce(
      (acc, c) => {
        acc.totalMs += c.metrics.totalMs;
        acc.humanMs += c.metrics.heldMs + c.metrics.humanControlMs;
        return acc;
      },
      { totalMs: 0, humanMs: 0 },
    );
    const allDecisions = runtime.decisionRepo.list({});
    return {
      now: nowFn(),
      executions: cards,
      attention: {
        working: active.length,
        needsYou: needsYou.length,
        pendingDecisions: allDecisions.filter((d) => d.status === 'pending').length,
        totalMs: totals.totalMs,
        humanMs: totals.humanMs,
        autonomousMs: Math.max(0, totals.totalMs - totals.humanMs),
        attentionRatio: totals.totalMs > 0 ? totals.humanMs / totals.totalMs : 0,
      },
      queue: allDecisions
        .slice()
        .sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1) || decisionPriority(b) - decisionPriority(a))
        .slice(0, 60)
        .map((d) => decisionView(d, executions.find((e) => e.id === d.executionId)?.goal ?? d.executionId)),
      quality: rollupDecisionQuality(allDecisions),
    };
  }

  function detailView(execId: string): DetailView {
    const exec = runtime.execRepo.findById(execId);
    if (!exec) throw new Error(`execution not found: ${execId}`);
    const all = runtime.decisionRepo.list({ executionId: execId });
    const pending = all.filter((d) => d.status === 'pending');
    const card = cardFor(exec, pending);
    const events = runtime.eventRepo.listByExecution(execId, { limit: 500 });
    const takeovers = runtime.takeoverRepo.listByExecution(execId);
    let away: DetailView['away'] | undefined;
    const lastAway = [...events].reverse().find((e) => e.type === 'human.intervention' && (e.payload as Record<string, unknown>).action === 'mark_away');
    if (lastAway) {
      const summary = buildAwaySummary({
        execution: exec,
        events,
        decisions: all,
        since: lastAway.timestamp,
        now: nowFn(),
      });
      away = { ...summary, rendered: renderAway(summary) };
    }
    return {
      ...card,
      timeline: condenseTimeline(events, all, { limit: 80 }),
      decisions: all
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 25)
        .map((d) => decisionView(d, exec.goal)),
      ...(away ? { away } : {}),
      interventions: exec.interventions.slice(-15),
      constraints: exec.constraints,
      workspace: exec.workspace,
      completedWork: exec.completedWork.slice(-10),
      risks: exec.risks,
      qualityRollup: rollupDecisionQuality(all),
    };
  }

  function renderAway(s: AwaySummary): string {
    // server-side canonical text so CLI/web speak with one voice
    const lines: string[] = [];
    if (s.needsYou) {
      lines.push('NEEDS YOUR ATTENTION');
      for (const d of s.decisionsRequired) lines.push(`  - decision: ${d.title}`);
      for (const f of s.failures.slice(0, 3)) lines.push(`  - failure: ${f}`);
    }
    lines.push(`Since you left: ${String(s.completedWork.length)} steps done` +
      (s.significantChanges.length > 0 ? `, ${String(s.significantChanges.length)} significant change(s)` : '') +
      `, ${String(s.decisionsResolved.length)} decision(s) answered`);
    lines.push(`Next: ${s.recommendedNextAction}`);
    lines.push(`Your attention so far: ${String(s.humanAttentionMinutes)} min`);
    return lines.join('\n');
  }

  // ── HTTP plumbing ──
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(code, {
      'content-type': 'application/json',
      'content-length': String(buf.length),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(buf);
  };

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  async function serveStatic(res: ServerResponse, path: string): Promise<void> {
    const rel = path === '/' ? 'index.html' : path.slice(1);
    if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
    const file = join(publicDir, rel);
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'content-length': String(data.length),
        'cache-control': 'no-cache',
      });
      res.end(data);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 64_000) return reject(new Error('body too large'));
        chunks.push(c);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    try {
      if (path === '/api/state' && req.method === 'GET') return json(res, 200, stateView());
      if (path === '/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, must-revalidate',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        res.write('retry: 1500\n\n');
        res.write(`data: ${JSON.stringify({ type: 'hello', now: nowFn() })}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return undefined;
      }
      const detail = /^\/api\/executions\/([^/]+)$/.exec(path);
      if (detail && req.method === 'GET') return json(res, 200, detailView(decodeURIComponent(detail[1]!)));

      const resolve_ = /^\/api\/decisions\/([^/]+)\/resolve$/.exec(path);
      if (resolve_ && req.method === 'POST') {
        const body = await readBody(req);
        const outcome = String(body.outcome ?? '');
        if (outcome !== 'accepted' && outcome !== 'rejected' && outcome !== 'custom') {
          return json(res, 400, { error: "outcome must be 'accepted' | 'rejected' | 'custom'" });
        }
        const d = runtime.decisions.resolve(decodeURIComponent(resolve_[1]!), outcome, {
          ...(typeof body.answerBy === 'string' ? { answerBy: body.answerBy } : {}),
          ...(typeof body.selectedOptionId === 'string' ? { selectedOptionId: body.selectedOptionId } : {}),
          ...(typeof body.customValue === 'string' ? { customValue: body.customValue } : {}),
          ...(typeof body.feedback === 'string' ? { feedback: body.feedback } : {}),
        });
        return json(res, 200, { id: d.id, status: d.status });
      }
      const present = /^\/api\/decisions\/([^/]+)\/present$/.exec(path);
      if (present && req.method === 'POST') {
        runtime.decisions.present(decodeURIComponent(present[1]!));
        return json(res, 200, { ok: true });
      }
      const takeOver = /^\/api\/executions\/([^/]+)\/take-over$/.exec(path);
      if (takeOver && req.method === 'POST') {
        const body = await readBody(req);
        const r = runtime.takeover.takeOver(decodeURIComponent(takeOver[1]!), {
          ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
          ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
        });
        return json(res, 200, { ok: true, takeoverId: r.record?.id ?? null, brief: r.brief.length > 2000 ? `${r.brief.slice(0, 2000)}…` : r.brief });
      }
      const giveBack = /^\/api\/executions\/([^/]+)\/continue$/.exec(path);
      if (giveBack && req.method === 'POST') {
        const body = await readBody(req);
        const r = runtime.takeover.continue(decodeURIComponent(giveBack[1]!), {
          ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
          ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
        });
        return json(res, 200, { ok: true, status: r.execution.status, modifications: r.modifications });
      }
      const away = /^\/api\/executions\/([^/]+)\/away$/.exec(path);
      if (away && req.method === 'POST') {
        const body = await readBody(req);
        const since = runtime.manager.markAway(decodeURIComponent(away[1]!), typeof body.actor === 'string' ? body.actor : 'developer');
        return json(res, 200, { ok: true, since });
      }
      if (path === '/favicon.ico') return json(res, 404, { error: 'none' });
      if (!path.startsWith('/api/') && !path.startsWith('/stream')) {
        return await serveStatic(res, path);
      }
      return json(res, 404, { error: 'unknown endpoint' });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── change propagation: slow cross-process poll + instant in-process nudge ──
  const poller = setInterval(() => {
    if (closed || streams.size === 0) return;
    const fp = fingerprint();
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      broadcast({ type: 'changed', now: nowFn() });
    }
  }, pollMs);
  poller.unref();
  const heartbeat = setInterval(() => {
    for (const res of streams) {
      try {
        res.write(': ping\n\n');
      } catch {
        streams.delete(res);
      }
    }
  }, 15_000);
  heartbeat.unref();
  const unsubscribe = runtime.manager.subscribe(() => {
    const fp = fingerprint();
    if (fp !== lastFingerprint && streams.size > 0) {
      lastFingerprint = fp;
      broadcast({ type: 'changed', now: nowFn() });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 8717, host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : (options.port ?? 8717);

  return {
    url: `http://${host}:${String(port)}`,
    port,
    async close() {
      closed = true;
      clearInterval(poller);
      clearInterval(heartbeat);
      unsubscribe();
      for (const res of streams) res.end();
      streams.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownRuntime) runtime.db.close();
    },
  };
}
