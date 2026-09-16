/**
 * Phase-10 — adversarial + concurrency test helpers.
 *
 * OWNED BY tests/p10 ONLY. Nothing here patches, wraps or monkey-mocks
 * production behaviour: every sequence runs the real pipeline
 * (EventAdapter → ExecutionManager → PolicyEngine/AttentionEngine →
 * DecisionQueue → sqlite) and asserts on PERSISTED truth read back from a
 * second connection, never on log output.
 *
 * Deliberately NOT imported: src/cli, src/ui, src/demo and
 * src/summary/attention-history.ts — those are owned by other agents and are
 * in flight. The runtime factory below therefore re-wires the same objects
 * src/cli's createRuntime builds, locally, from the storage layer up.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { ConductorDatabase } from '../../src/storage/database.js';
import { SqliteExecutionRepository } from '../../src/storage/execution-repository.js';
import { SqliteEventRepository } from '../../src/storage/event-repository.js';
import { SqliteDecisionRepository } from '../../src/storage/decision-repository.js';
import { SqliteDelegationRepository } from '../../src/storage/delegation-repository.js';
import { SqliteTakeoverRepository } from '../../src/storage/takeover-repository.js';
import { DecisionQueue } from '../../src/decision/decision-queue.js';
import { DelegationService } from '../../src/delegation/delegation-service.js';
import { ExecutionManager } from '../../src/manager/execution-manager.js';
import { TakeoverService } from '../../src/takeover/takeover-service.js';
import { ConductorBridge } from '../../src/dsh/conductor-bridge.js';
import { EventAdapter } from '../../src/adapter/event-adapter.js';
import { approvalSubject } from '../../src/policy/approval-subject.js';
import { buildAttentionModel } from '../../src/attention/attention-orchestrator.js';
import { compareAttention } from '../../src/attention/attention-priority.js';

import type { AttentionModelInput } from '../../src/attention/attention-orchestrator.js';
import type { AttentionCandidate } from '../../src/attention/attention-candidate.js';
import type { ConductorDecision } from '../../src/types/decision.js';
import type { ConductorEvent } from '../../src/types/event.js';
import type { Execution } from '../../src/domain/execution.js';
import type { ExecutionStatus } from '../../src/types/execution.js';
import type {
  ConductorHostBindings,
  HostApprovalOutcome,
  HostPreStepDecision,
  HostPreToolDecision,
  HostQuestionAnswer,
  HostQuestionRequest,
  HostSessionEvent,
  HostStepPayload,
  HostToolExecution,
  HostToolResult,
} from '../../src/dsh/host-surface.js';

/** Generous-but-real ceiling for every p10 test (contention + worker boot). */
export const T: { timeout: number } = { timeout: 15_000 };

// ---------------------------------------------------------------------------
// Temp file-db scaffolding
// ---------------------------------------------------------------------------

/** Repo root as seen from the COMPILED helper (dist-adv/tests/p10/helpers.js). */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const liveDirs = new Set<string>();

/**
 * Create a scratch directory for a FILE-backed sqlite db.
 * Always `tests/.tmp-p10-<tag>-XXXXXX`; WAL needs a real file.
 */
export function tmpDir(tag: string): string {
  const dir = mkdtempSync(join(REPO_ROOT, 'tests', `.tmp-p10-${tag}-`));
  liveDirs.add(dir);
  return dir;
}

/** Remove every scratch dir created by this module (call from an `after` hook). */
export function cleanTmpDirs(): void {
  for (const dir of [...liveDirs]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    liveDirs.delete(dir);
  }
}

export function repoRoot(): string {
  return REPO_ROOT;
}

// ---------------------------------------------------------------------------
// Runtime factory (local mirror of the production wiring)
// ---------------------------------------------------------------------------

export interface Runtime {
  db: ConductorDatabase;
  execRepo: SqliteExecutionRepository;
  eventRepo: SqliteEventRepository;
  decisionRepo: SqliteDecisionRepository;
  delegationRepo: SqliteDelegationRepository;
  takeoverRepo: SqliteTakeoverRepository;
  delegations: DelegationService;
  decisions: DecisionQueue;
  manager: ExecutionManager;
  takeover: TakeoverService;
  bridge: ConductorBridge;
  host: FakeHost;
  detach: () => void;
  dbPath: string;
  close(): void;
}

/**
 * Open a fully wired conductor runtime on `dbPath` (':memory:' allowed, but the
 * concurrency tests must pass FILE paths so two connections share state).
 */
export function openRuntime(dbPath: string, autoAnswerRoutine = false): Runtime {
  const db = new ConductorDatabase({ path: dbPath });
  const execRepo = new SqliteExecutionRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const decisionRepo = new SqliteDecisionRepository(db);
  const delegationRepo = new SqliteDelegationRepository(db);
  const takeoverRepo = new SqliteTakeoverRepository(db);
  const delegations = new DelegationService({ delegationRepo, decisionRepo });
  const decisions = new DecisionQueue(decisionRepo, execRepo);
  const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
  manager.delegations = delegations;
  const takeover = new TakeoverService({
    executionRepo: execRepo,
    eventRepo,
    decisionRepo,
    takeoverRepo,
  });
  const bridge = new ConductorBridge({ manager, decisions, autoAnswerRoutine });
  const host = new FakeHost();
  const detach = bridge.attach(host);
  const close = (): void => {
    detach();
    db.close();
  };
  return {
    db,
    execRepo,
    eventRepo,
    decisionRepo,
    delegationRepo,
    takeoverRepo,
    delegations,
    decisions,
    manager,
    takeover,
    bridge,
    host,
    detach,
    dbPath,
    close,
  };
}

// ---------------------------------------------------------------------------
// Execution + event drivers (all go through the real pipeline)
// ---------------------------------------------------------------------------

/**
 * Start a managed execution for a named agent and bind the DSH host key the
 * bridge uses to route that agent's tool calls (`agent:<id>`).
 */
export function startAgent(
  rt: Runtime,
  agentId: string,
  goal = `deliver ${agentId}`,
  workspaceRoot = `/srv/${agentId}`,
): Execution {
  const exec = rt.manager.createExecution({ goal, workspaceRoot, agent: { id: agentId } });
  exec.start('system');
  rt.execRepo.save(exec);
  rt.manager.processEvent(
    EventAdapter.createEvent(exec.id, 'execution.started', { executionId: exec.id, goal }, 'dsh'),
  );
  rt.bridge.bindHostKey(`agent:${agentId}`, exec.id);
  return exec;
}

/** One bash tool call through the pipeline (yields tool.called + command.started). */
export function gateCommand(
  rt: Runtime,
  executionId: string,
  callId: string,
  command: string,
): void {
  for (const evt of EventAdapter.adaptToolCall(executionId, {
    callId,
    name: 'bash',
    arguments: { command },
  })) {
    rt.manager.processEvent(evt);
  }
}

/** Raw tool call (any tool) through the pipeline. */
export function gateTool(
  rt: Runtime,
  executionId: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): void {
  for (const evt of EventAdapter.adaptToolCall(executionId, { callId, name, arguments: args })) {
    rt.manager.processEvent(evt);
  }
}

/** Ask a question the way the agent does (ask_user_question tool event). */
export function gateQuestion(
  rt: Runtime,
  executionId: string,
  callId: string,
  question: string,
  options: string[] = ['yes', 'no'],
  extra: Record<string, unknown> = {},
): void {
  gateTool(rt, executionId, callId, 'ask_user_question', {
    questions: [{ question, options: options.map((label) => ({ label })) }],
    ...extra,
  });
}

/**
 * Drive a tool call the way DSH does: through the mounted bridge
 * (`tools/pre-execute`). `undefined` = allow, `{kind:'deny'}` = gated.
 */
export function dispatchTool(
  rt: Runtime,
  agentId: string,
  callId: string,
  command: string,
): HostPreToolDecision {
  return rt.host.dispatchTool({ callId, name: 'bash', arguments: { command }, agentId });
}

/** What DSH actually sees for a call: the bridge's `undefined` becomes `allow`. */
export function claimKind(
  decision: HostPreToolDecision | undefined,
): 'allow' | 'deny' | 'ask' {
  return decision?.kind ?? 'allow';
}

/** Turn-end (`session/event` → turn/end) exactly as the session log delivers it. */
export function fireTurnEnd(rt: Runtime, reason: 'completed' | 'error' | 'aborted' = 'completed'): void {
  rt.host.emit('session/event', {
    type: 'turn/end',
    time: Date.now(),
    data: { reason: { kind: reason } },
  } satisfies HostSessionEvent);
}

/** The stable approval identity a resolved decision grants a retry against. */
export function subjectOf(command: string): string {
  return approvalSubject('bash', { command });
}

// ---------------------------------------------------------------------------
// Durable-state readers (assertions read rows, never logs)
// ---------------------------------------------------------------------------

export function statusOf(rt: Runtime, executionId: string): ExecutionStatus | undefined {
  return rt.execRepo.findById(executionId)?.status;
}

export function rowsFor(rt: Runtime, executionId: string): ConductorDecision[] {
  return rt.decisionRepo.list({ executionId });
}

export function eventRows(rt: Runtime, executionId: string): ConductorEvent[] {
  return rt.eventRepo.listByExecution(executionId, { limit: 1_000 });
}

export function pendingForSubject(rt: Runtime, executionId: string, subject: string): ConductorDecision[] {
  return rt.decisionRepo
    .list({ executionId })
    .filter((d) => d.status === 'pending' && d.subject === subject);
}

/** Attention model rebuilt from durable rows only. */
export function modelFrom(
  rt: Runtime,
  now: number,
  executions?: Execution[],
): ReturnType<typeof buildAttentionModel> {
  const execs = executions ?? rt.execRepo.list({});
  const input: AttentionModelInput = {
    executions: execs,
    decisions: rt.decisionRepo.list({}),
    events: execs.flatMap((e) => rt.eventRepo.listByExecution(e.id, { limit: 300 })),
    now,
  };
  return buildAttentionModel(input);
}

/** Is `items` in the order compareAttention prescribes? (fuzz invariant) */
export function isSortedByAttention(items: AttentionCandidate[], now: number): boolean {
  const cmp = compareAttention(now);
  for (let i = 1; i < items.length; i++) {
    if (cmp(items[i - 1] as AttentionCandidate, items[i] as AttentionCandidate) > 0) return false;
  }
  return true;
}

/**
 * Adjacent pairs that break compareAttention order. The budget pass legally
 * rewrites an `interrupt` into `queue` AFTER sorting, so demoted ids are
 * tolerated; anything else is a real ordering violation.
 */
export function orderDeviations(
  items: AttentionCandidate[],
  now: number,
  tolerated: Iterable<string> = [],
): string[] {
  const ok = new Set(tolerated);
  const cmp = compareAttention(now);
  const out: string[] = [];
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1] as AttentionCandidate;
    const b = items[i] as AttentionCandidate;
    if (cmp(a, b) > 0 && !(a.disposition === 'queue' && ok.has(a.id))) {
      out.push(`${a.id}(${a.disposition}) before ${b.id}(${b.disposition})`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fake DSH host (minimal mirror of the contract, copied from the bridge test's
// pattern so this suite never touches files owned by other agents)
// ---------------------------------------------------------------------------

type AnyHandler = (...args: never[]) => unknown;

export class FakeHost implements ConductorHostBindings {
  private handlers = new Map<string, AnyHandler[]>();

  on(event: 'session/event', handler: (evt: HostSessionEvent) => void): () => void;
  on(event: 'tools/result', handler: (r: HostToolResult) => void): () => void;
  on(
    event: 'tools/pre-execute',
    handler: (e: HostToolExecution) => HostPreToolDecision | undefined,
  ): () => void;
  on(
    event: 'user-questions/request',
    handler: (q: HostQuestionRequest) => HostQuestionAnswer | undefined,
  ): () => void;
  on(event: 'agent/pre-step', handler: (p: HostStepPayload) => HostPreStepDecision | undefined): () => void;
  on(
    event: 'approval/request',
    handler: (a: { toolName: string; agentId?: string; reason?: string }) => HostApprovalOutcome | undefined,
  ): () => void;
  on(event: string, handler: AnyHandler): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((h) => h !== handler),
      );
    };
  }

  listenerCount(event: string): number {
    return (this.handlers.get(event) ?? []).length;
  }

  private fire(event: string, arg: unknown): unknown {
    let result: unknown;
    for (const h of this.handlers.get(event) ?? []) {
      result = (h as (a: unknown) => unknown)(arg);
      if (result !== undefined) return result; // first claim wins
    }
    return result;
  }

  emit(event: 'session/event', evt: HostSessionEvent): void {
    for (const h of this.handlers.get(event) ?? []) (h as (a: HostSessionEvent) => void)(evt);
  }

  emitResult(r: HostToolResult): void {
    for (const h of this.handlers.get('tools/result') ?? []) (h as (a: HostToolResult) => void)(r);
  }

  dispatchTool(exec: HostToolExecution): HostPreToolDecision {
    const claimed = this.fire('tools/pre-execute', exec);
    return (claimed as HostPreToolDecision) ?? { kind: 'allow' };
  }

  askQuestion(req: HostQuestionRequest): HostQuestionAnswer | undefined {
    return this.fire('user-questions/request', req) as HostQuestionAnswer | undefined;
  }

  nextStep(payload: HostStepPayload): HostPreStepDecision {
    const claimed = this.fire('agent/pre-step', payload);
    return (claimed as HostPreStepDecision) ?? { kind: 'enter' };
  }

  requestApproval(req: { toolName: string; agentId?: string; reason?: string }): HostApprovalOutcome {
    const claimed = this.fire('approval/request', req);
    return (claimed as HostApprovalOutcome) ?? 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Crash simulation: a child process that dies WITHOUT closing the database
// ---------------------------------------------------------------------------

const CRASH_BOOT = /* js */ `
const { pathToFileURL } = await import('node:url');
const imp = (p) => import(pathToFileURL(p).href);
const { ConductorDatabase } = await imp(process.env.MOD_DB);
const { SqliteExecutionRepository } = await imp(process.env.MOD_EXEC);
const { SqliteEventRepository } = await imp(process.env.MOD_EVENT);
const { SqliteDecisionRepository } = await imp(process.env.MOD_DEC);
const { SqliteDelegationRepository } = await imp(process.env.MOD_DELEGREPO);
const { DecisionQueue } = await imp(process.env.MOD_QUEUE);
const { DelegationService } = await imp(process.env.MOD_DELEG);
const { ExecutionManager } = await imp(process.env.MOD_MGR);
const { ConductorBridge } = await imp(process.env.MOD_BRIDGE);
const db = new ConductorDatabase({ path: process.env.DBP });
const execRepo = new SqliteExecutionRepository(db);
const eventRepo = new SqliteEventRepository(db);
const decisionRepo = new SqliteDecisionRepository(db);
const delegations = new DelegationService({ delegationRepo: new SqliteDelegationRepository(db), decisionRepo });
const decisions = new DecisionQueue(decisionRepo, execRepo);
const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
manager.delegations = delegations;
const bridge = new ConductorBridge({ manager, decisions });
const exec = bridge.startExecution(process.env.GOAL, {
  workspaceRoot: process.env.WS,
  hostKey: \'agent:\' + process.env.AGENT,
});
const claim = bridge.preToolExecute({
  callId: process.env.CALL,
  name: \'bash\',
  arguments: { command: process.env.CMD },
  agentId: process.env.AGENT,
});
console.log(JSON.stringify({
  execId: exec.id,
  claim: claim ? claim.kind : \'allow\',
  status: execRepo.findById(exec.id).status,
  pending: decisions.pending().length,
}));
process.exit(0); // no db.close(): the WAL file is left behind like a real crash
`;

/**
 * Run a real process that pauses an execution through the bridge and then dies
 * abruptly. Returns what the dying process observed.
 */
export async function crashPauseChild(
  dbPath: string,
  input: { agentId: string; goal: string; command: string; callId: string; workspaceRoot: string },
): Promise<{ execId: string; claim: string; status: string; pending: number }> {
  const { spawn } = await import('node:child_process');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    DBP: dbPath,
    GOAL: input.goal,
    AGENT: input.agentId,
    CMD: input.command,
    CALL: input.callId,
    WS: input.workspaceRoot,
    MOD_DB: srcModule('storage/database'),
    MOD_EXEC: srcModule('storage/execution-repository'),
    MOD_EVENT: srcModule('storage/event-repository'),
    MOD_DEC: srcModule('storage/decision-repository'),
    MOD_DELEGREPO: srcModule('storage/delegation-repository'),
    MOD_QUEUE: srcModule('decision/decision-queue'),
    MOD_DELEG: srcModule('delegation/delegation-service'),
    MOD_MGR: srcModule('manager/execution-manager'),
    MOD_BRIDGE: srcModule('dsh/conductor-bridge'),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CRASH_BOOT], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('crash child timed out'));
    }, 12_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`crash child exit ${String(code)}: ${err.slice(0, 400)}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '') as never);
      } catch (e) {
        reject(new Error(`bad child output ${JSON.stringify(out.slice(0, 300))}: ${String(e)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Real concurrency: worker threads over the SAME file db
// ---------------------------------------------------------------------------

/** Absolute path of a compiled src module, resolved from this helper's URL. */
export function srcModule(rel: string): string {
  return fileURLToPath(new URL(`../../src/${rel}.js`, import.meta.url));
}

const WORKER_BOOT = /* js */ `
const { parentPort, workerData } = await import('node:worker_threads');
const { pathToFileURL } = await import('node:url');
const imp = (p) => import(pathToFileURL(p).href);
const { ConductorDatabase } = await imp(workerData.mods.db);
const { SqliteExecutionRepository } = await imp(workerData.mods.exec);
const { SqliteEventRepository } = await imp(workerData.mods.event);
const { SqliteDecisionRepository } = await imp(workerData.mods.dec);
const { SqliteDelegationRepository } = await imp(workerData.mods.delegRepo);
const { DecisionQueue } = await imp(workerData.mods.queue);
const { DelegationService } = await imp(workerData.mods.deleg);
const { ExecutionManager } = await imp(workerData.mods.mgr);
const { EventAdapter } = await imp(workerData.mods.adapter);
const db = new ConductorDatabase({ path: workerData.dbPath });
const execRepo = new SqliteExecutionRepository(db);
const eventRepo = new SqliteEventRepository(db);
const decisionRepo = new SqliteDecisionRepository(db);
const delegationRepo = new SqliteDelegationRepository(db);
const delegations = new DelegationService({ delegationRepo, decisionRepo });
const decisions = new DecisionQueue(decisionRepo, execRepo);
const manager = new ExecutionManager(execRepo, eventRepo, undefined, undefined, decisions);
manager.delegations = delegations;
const gate = (execId, callId, command) => {
  for (const ev of EventAdapter.adaptToolCall(execId, { callId, name: 'bash', arguments: { command } })) {
    manager.processEvent(ev);
  }
};
const results = [];
try {
  for (const op of workerData.ops) {
    if (op.kind === 'gate') { gate(op.execId, op.callId, op.command); results.push({ op: op.kind, ok: true }); }
    else if (op.kind === 'resolve') {
      const d = decisions.resolve(op.id, op.outcome, op.optionId ? { selectedOptionId: op.optionId } : {});
      results.push({ op: op.kind, ok: true, status: d.status });
    } else if (op.kind === 'token') {
      results.push({ op: op.kind, ok: true, token: decisions.consumeApproval(op.execId, op.subject) });
    } else if (op.kind === 'peek') {
      const d = decisionRepo.findById(op.id);
      results.push({
        op: op.kind, ok: true, status: d ? d.status : null,
        hasResolution: d ? d.resolution != null : null, consumed: d ? d.consumedAt != null : null,
      });
    } else if (op.kind === 'yield') {
      await new Promise((res) => setTimeout(res, op.ms ?? 1));
      results.push({ op: op.kind, ok: true });
    }
  }
  parentPort.postMessage({ ok: true, results });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message), results });
} finally {
  db.close();
}
`;

function workerMods(): Record<string, string> {
  return {
    db: srcModule('storage/database'),
    exec: srcModule('storage/execution-repository'),
    event: srcModule('storage/event-repository'),
    dec: srcModule('storage/decision-repository'),
    delegRepo: srcModule('storage/delegation-repository'),
    queue: srcModule('decision/decision-queue'),
    deleg: srcModule('delegation/delegation-service'),
    mgr: srcModule('manager/execution-manager'),
    adapter: srcModule('adapter/event-adapter'),
  };
}

export type WorkerOp =
  | { kind: 'gate'; execId: string; callId: string; command: string }
  | { kind: 'resolve'; id: string; outcome: 'accepted' | 'rejected' | 'custom'; optionId?: string }
  | { kind: 'token'; execId: string; subject: string }
  | { kind: 'peek'; id: string }
  | { kind: 'yield'; ms?: number };

export interface WorkerReport {
  ok: boolean;
  error?: string;
  results: Array<Record<string, unknown>>;
}

/** Run `ops` on a SEPARATE thread → a separate sqlite connection on the same file. */
export function runWorkerOps(dbPath: string, ops: WorkerOp[]): Promise<WorkerReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_BOOT, {
      eval: true,
      workerData: { dbPath, mods: workerMods(), ops },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('worker timed out'));
    }, 12_000);
    worker.once('message', (msg: WorkerReport) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(msg);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so the fuzz sequence is reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Yield to the microtask/macrotask queue so two async writers really interleave. */
export function tick(): Promise<void> {
  return new Promise((res) => setImmediate(res));
}
