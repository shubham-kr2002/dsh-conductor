# DSH Conductor — Architecture & Integration Specification

**Product:** Conductor — The Human-Control Layer for Autonomous Coding Agents  
**Target Runtime:** DeepSeek Harness (DSH) on Node.js v24+  
**Workspace:** `/run/media/shubh/New Volume/company/dsh/dsh-conductor`  
**Date:** living document — updated through Phase 9  
**Author:** Antigravity / DeepSeek Engineering  

---

## 1. Executive Summary & Core Promise

Conductor is the **execution control plane** managing the boundary between autonomous agent execution and human attention.

> **Core Promise:** Let the agent work continuously. Interrupt the developer only when human judgment is genuinely required.

Conductor optimizes for **minimum human attention minutes per successfully completed task**. The developer should be able to trigger a substantial task, step away, return to resolve only high-consequence decisions, take over or hand off execution seamlessly, and trust the persistent state of the workspace.

---

## 2. DSH Archaeology & Runtime Architecture

Through Phase 0 repository archaeology of `@deepseek-ai/dsh` and the Cordis runtime, we have mapped the complete extension topography:

### 2.1 Cordis Plugin Framework
- **Fibers & Contexts:** Runtime capabilities exist as plugins registered in a Cordis `Context` (`ctx`).
- **Planes:**
  - **Host Plane:** Long-lived process-wide services (`agents`, `sessions`, `tools`, `storage`, `approval`, `commands`, `llm`, `systemPrompt`).
  - **Agent Preset Plane:** Session-scoped additions (agent tools, persona prompt sections, compaction rules) mounted under an agent scope.
- **Dependency Management:** Plugins declare hard dependencies via `inject: [...]` or access optional services via `ctx.get('serviceName')`.

### 2.2 Event System & Waterfalls
The runtime exposes two distinct event dispatch patterns:
1. **Emit Events (Fire-and-forget notification):**
   - `session/event`: Every mutation to a session log (`turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/message`, `tool/call`, `tool/result`).
   - `agent/status`: Agent running/idle transitions.
   - `agent/error`: Turn or step errors.
   - `tools/result`: Final frozen lossless tool results.
   - `subagent/start`, `subagent/end`: Delegated child lifecycle.
2. **Waterfall Events (Interception and Gatekeeping):**
   - `tools/pre-execute`: Evaluates every pending tool call before execution. Returns `PreToolDecision`: `{ kind: 'allow' } | { kind: 'deny', reason: string } | { kind: 'ask', reason?: string }`. This is a primary policy and attention gate for Conductor.
   - `tools/post-execute`: Intercepts and transforms tool execution results.
   - `user-questions/request`: Intercepts the `ask_user_question` tool calls before they reach the user, allowing automated answering, queueing as structured decisions, or delegation.
   - `approval/request`: Intercepts user permission prompts before presentation.
   - `agent/pre-step`: Evaluates and filters messages entering a step; can return `{ kind: 'reject' }` (pausing/blocking the turn) or `{ kind: 'enter', messages }`.

### 2.3 Agent & Session Lifecycle
- `Agent`:
  - `agent.id`: SessionId
  - `agent.session`: Session instance with append-only event log (`session.seq`, `session.eventAt`, `session.append`).
  - `agent.whenIdle()`: Returns a promise resolving when all active execution quiesces.
  - `agent.followup(message)`: Queues user input for the next turn.
  - `agent.steer(message)`: Injects steering input for the next step.
  - `agent.cancel(cause, options)`: Aborts active turns; `keepInbox: true` preserves queued messages.

### 2.4 Persistence Architecture
- Node.js v24 includes native `node:sqlite` (`DatabaseSync`) with transaction support, WAL mode, and zero external binary dependencies.
- Conductor utilizes SQLite for local, atomic persistence behind clean repository interfaces.

---

## 3. Baseline Test Suite Status

- **DSH Installation Checkout (`/home/shubh/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh`):**
  - Checked `package.json`: Contains no `"test"` script (`npm error Missing script: "test"`).
  - Production npm installation does not include source test suites.
- **Workspace (`/run/media/shubh/New Volume/company/dsh/dsh-conductor`):**
  - Initially empty workspace initialized with Git (`main` branch) and `pnpm`.
  - Node.js v24.20.0 provides native `node:test` runner and built-in type-stripping for TypeScript.
  - Development toolchain established: `pnpm`, `typescript 7.0.2` for strict static analysis, and `node:test` + `node:assert` for unit and integration testing.

---

## 4. Conductor Architecture & Proposed Modules

Conductor is architected as a modular, decoupled execution control plane:

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 DSH Conductor CLI / UX                  │
                  │  (status | decisions | take-over | continue | history)   │
                  └───────────────────────────┬─────────────────────────────┘
                                              │
┌─────────────────────────────────────────────▼─────────────────────────────────────────────┐
│                                   Execution Manager                                       │
│    Lifecycle States: STARTING, RUNNING, WAITING, PAUSED, TAKEN_OVER,                      │
│                      BLOCKED, HANDOFF_PENDING, COMPLETED, FAILED, CANCELLED               │
├──────────────────────┬──────────────────────┬──────────────────────┬──────────────────────┤
│    Event Adapter     │   Attention Engine   │    Policy Engine     │    Decision Queue    │
│  Normalizes runtime  │   Classifies consequence,│  Validates safety of │  Stores prioritized  │
│  events to internal  │   reversibility & task   │  fs, shell, git, deps│  human questions &   │
│  ConductorEvents     │   relevance:             │  allow/deny/require  │  applies resolutions │
│                      │   SILENT/BG/DECISION/CRIT│                      │                      │
├──────────────────────┼──────────────────────┴──────────────────────┼──────────────────────┤
│  Takeover / Continue │                      Away Mode              │    Agent Handoff     │
│  Freezes execution,  │             Decision-oriented concise       │  Structured context  │
│  snapshots workspace,│             progress summaries              │  transfer between    │
│  reconciles changes  │                                             │  agents              │
├──────────────────────┴─────────────────────────────────────────────┴──────────────────────┤
│                                  Storage Layer                                            │
│   SQLite Repository (executions, events, decisions, interventions, policies, handoffs)    │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

### Module Breakdown:

1. **`src/types/` — Domain Types & Interfaces**
   - `ConductorEvent`: Normalized event schema.
   - `ExecutionState`: Complete persistent snapshot (goal, status, phase, workspace, metrics, decisions, risks).
   - `Decision`: Human decision schema with options, recommendation, impact, and status.
   - `Policy`: Policy definitions and rule sets.
   - `Handoff`: Structured agent-to-agent transition state.

2. **`src/domain/` — Core Domain Models & State Machine**
   - Deterministic state machine governing the 10 execution states.
   - Transition validation rejecting invalid state changes.
   - Domain errors (`InvalidStateTransitionError`, `ExecutionNotFoundError`, `DecisionNotFoundError`).

3. **`src/storage/` — SQLite Storage Repositories**
   - SQLite database initialization (`node:sqlite`).
   - Tables: `executions`, `execution_events`, `decisions`, `interventions`, `policies`, `handoffs`.
   - Repository interfaces (`ExecutionRepository`, `DecisionRepository`, `EventRepository`, `PolicyRepository`, `HandoffRepository`).

4. **`src/adapter/` — Event Adapter**
   - Subscribes to DSH events: `session/event`, `tools/pre-execute`, `tools/result`, `user-questions/request`, `agent/status`, `agent/error`.
   - Translates raw harness events into canonical `ConductorEvent`s.

5. **`src/attention/` — Attention Engine**
   - Deterministic rule engine evaluating event consequence, reversibility, task relevance, and ambiguity.
   - Level: `SILENT`, `BACKGROUND`, `DECISION`, `CRITICAL`.
   - Action: `CONTINUE`, `RECORD`, `NOTIFY`, `PAUSE`.
   - Suppresses redundant agent questions and low-consequence noise.

6. **`src/policy/` — Policy Engine**
   - Policy sets for Filesystem, Shell Commands, Dependencies, Git, Secrets, Deployments, Production.
   - Actions: `allow`, `deny`, `require_approval`.
   - Intercepts unsafe tool executions before dispatch.

7. **`src/decision/` — Decision Queue**
   - Prioritizes pending human decisions by urgency and consequence.
   - Records resolutions (`accepted`, `rejected`, `custom`, `expired`, `cancelled`).
   - Unblocks waiting executions upon human resolution.

8. **`src/takeover/` — Take Over & Continue Service**
   - Pauses execution and creates workspace state snapshot.
   - Computes git diff / file change reconciliation after developer intervention.
   - Synthesizes authoritative continuation context so the agent continues seamlessly.

9. **`src/away/` — Away Mode**
   - Aggregates historical execution events into concise, actionable summaries.
   - Focuses on completed deliverables, blockers, pending decisions, and next actions.

10. **`src/handoff/` — Structured Agent Handoff**
    - Exports structured handoff payload without dumping raw model conversation tokens.
    - Hydrates new agent execution from prior structured state.

11. **`src/manager/` — Execution Manager**
    - Central coordinator owning the lifecycle, coordinating adapters, policy, attention, and storage.

12. **`src/cli/` — CLI Interface**
    - Implements commands:
      - `dsh conductor run "<task>"` / `conductor run "<task>"`
      - `conductor status`
      - `conductor decisions`
      - `conductor take-over <id>`
      - `conductor continue <id>`
      - `conductor history`

13. **`src/plugin/` — Cordis Plugin Entry Point**
    - Bridges Conductor as a native DSH plugin (`apply(ctx)`).

---

## 5. Dependencies & Technical Constraints

- **Language & Runtime:** TypeScript / ECMAScript Modules (ESM) on Node.js v24.20.0+.
- **Database:** `node:sqlite` (Node.js native SQLite database).
- **CLI Framework:** `commander` v15.
- **Cordis DI:** `@deepseek-ai/cordis` v4.
- **Zero Heavy Infrastructure:** No PostgreSQL, Redis, Docker daemon, or cloud services required.
- **Sandbox Compliance:** Data stored in local `.conductor/` within workspace or `$DSH_HOME/.conductor/`, adhering strictly to `workspace-write` policy.

---

## 6. Assumptions & Risk Matrix

| Risk | Consequence | Mitigation Strategy |
| :--- | :--- | :--- |
| **Agent Pausing Race Conditions** | Unintended step execution while entering `PAUSED` or `TAKEN_OVER`. | Use `agent/pre-step` waterfall and `agent.whenIdle()` to cleanly halt at step boundaries. |
| **Manual Workspace Changes Conflicting with Agent State** | Agent hallucinates old file contents after human edit during Takeover. | Inspect workspace git status upon `CONTINUE`; inject structured continuation context informing agent that human changes are authoritative. |
| **Alert Fatigue from Agent Questions** | Developer bombarded with low-value confirmations. | Attention Engine filters repetitive or low-consequence questions; only critical ambiguities reach the Decision Queue. |
| **Storage Fragmentation** | Execution state lost across session restarts. | synchronous, durable (SQLite WAL + busy_timeout) SQLite storage persists every state transition and decision synchronously before acknowledging actions. |

---

## 7. Phased Delivery Roadmap

- **Phase 0:** Repository Archaeology & Baseline Verification (Completed)
- **Phase 1:** Core Domain (Types, Execution State, State Machine, Unit Tests)
- **Phase 2:** Event Pipeline & Adapters (Event Persistence, Status/History CLI)
- **Phase 3:** Attention Engine (Deterministic Consequence Classification & Testing)
- **Phase 4:** Decision Queue (Persistence, Prioritization, CLI Resolution)
- **Phase 5:** Take Over / Continue Workflow (State Freeze, Workspace Reconcile, Resume)
- **Phase 6:** Away Mode (Executive Summaries & Event Aggregation)
- **Phase 7:** Structured Agent Handoff (State Export & Context Hydration)
- **Phase 8:** Production Polish, End-to-End Integration, & Documentation

---

## 8. As-Built Integration Layer (Phase 8)

The `src/dsh/` module is the only place Conductor touches DSH, and it never
imports DSH code — it speaks **structural mirrors** of the verified
extension-point contracts:

| Extension point (waterfall) | Conductor behavior |
| :--- | :--- |
| `tools/pre-execute` | Observes + classifies the call (`EventAdapter`), then gates: `undefined`→delegate, `{kind:'deny', reason}`→claim. Held executions (`PAUSED/BLOCKED/TAKEN_OVER/HANDOFF_PENDING`) deny everything. |
| `agent/pre-step` | While held: `{kind:'reject'}` — and because DSH *consumes claimed inbox messages* on reject, the mount layer first `agent.inject()`s them back so queued work survives the freeze. |
| `user-questions/request` | Mirrors every agent question into the Decision Queue (priority-scored), then delegates to the human UI. `autoAnswerRoutine` mode claims routine low-stakes recommended-option questions with a valid `AskUserQuestionAnswer`. |
| `approval/request` | While a human holds the wheel, DSH approvals are answered `rejected` instead of hanging on an unwatched prompt; otherwise delegated untouched. |
| `session/event` | Post-commit durable log (`tool/result`, `user/message`, `turn/end`) is projected to leaf scalars and fed into the same event pipeline. |

Key decisions:

- **One decision per action.** `tool.called` + `command.started` share the
  originating `callId`; decisions carry a `dedupeKey` so one bash command
  yields exactly one human interruption (loudest signal wins).
- **Approvals are cross-process tokens.** Resolving a decision
  `--custom -o approve-once` (CLI process) persists `status + subject`; the
  mounted gate reads the shared SQLite and lets exactly one retry of that
  normalized subject pass (`consumeApproval`), then re-gates.
- **Layering stays intact:** `host-surface.ts` (normalized contracts),
  `conductor-bridge.ts` (pure policy/attention/queue logic, fake-host
  tested), `cordis-plugin.ts` (real cordis waterfall `next()` semantics,
  live-object leaf projection), `mount.ts` (composition root for a
  `cordis.yml` row).

Mounting (static composition row):

```yaml
- name: 'dsh-conductor'          # or abs path to dist/src/dsh/cordis-plugin.js
  config:
    goal: 'finish the payments migration'
    workspaceRoot: /srv/payments
    dbPath: /srv/payments/.conductor/conductor.db
```

The CLI (`conductor decisions/resolve/status/away/take-over/continue/handoff/adopt`)
shares the same SQLite file from any process — that is the human's control
surface while the agent keeps working.

## 9. Roadmap Status

Phases 0–10 **complete**. Phase 8 delivered the DSH plugin integration: normalized host contracts, the pure Conductor bridge, the cordis mounting layer, and live cross-process approval flow (93/93 tests).

## 10. Control Surface & Attention Intelligence (Phase 9, as built)

Phase 9 turned the control plane into a *mission control* experience without
adding a second source of truth.

### 10.1 The decision explanation model

Every interruption carries a `DecisionWhy` (`src/attention/decision-why.ts`),
built **only** from pipeline inputs that already exist at the moment of the
interruption — no LLM, no prose invention:

| field | source |
|---|---|
| WHAT | tool/command/question payload |
| WHY NOW | AttentionEngine `rationale` + `PolicyEvaluationResult.reason` |
| IMPACT | impact decision (critical ⟸ policy deny / CRITICAL level) |
| REVERSIBILITY | adapter inference + policy pattern (rm/git push/publish/infra) |
| EVIDENCE | eventIds, attention + policy `ruleIds`, affected resources, deterministic blast radius (workspace → repository → external-system → infrastructure), ambiguity (= attention uncertainty), task alignment |
| RECOMMENDATION | decision recommendation (question payloads / policy guidance) |
| CONSEQUENCE | fixed per-kind approve/reject contract text |

Created immutable at the queue (`DecisionQueue.create` → `why`), persisted in
`decisions.why_json`.

### 10.2 Attention metrics — the one number

`computeAttentionMetrics` (`src/summary/attention-metrics.ts`) reconstructs
state occupancy from the transition log alone: PAUSED+BLOCKED = *waiting for
judgment*, TAKEN_OVER = *you driving*, everything else = autonomous; terminal
transitions stop the clock. Interruptions = decisions + takeovers, counted
once each. The UI's L1 line, `conductor metrics` and the demo end-screen all
read this single function — same derivation, every window.

### 10.3 Decision quality, observable facts only

`src/decision/decision-quality.ts`: `presentedAt` is recorded the first time a
surface actually shows a decision (`DecisionQueue.present`), `responseMs` =
resolved − created, `recurred` = the same normalized `subject` produced a
later decision (the answer didn't stick), `outcome` classifies post-hoc from
the execution's real terminal/active state. No prediction, no scoring.

### 10.4 Semantic timeline & status language

`condenseTimeline` (`src/summary/timeline.ts`) folds the event log into
narrated activities (callId-joined command runs, grouped file edits,
test outcomes, decision surfacings); `status-language.ts` is the one map
(`PAUSED → "Waiting for your judgment"`) shared by CLI and web.

### 10.5 The surface (`src/ui/`)

`node:http` only — zero new dependencies. `startConductorUi` composes the
*same* `createRuntime` the CLI uses (repos, DecisionQueue, TakeoverService,
derivations), exposes JSON + actions (`/api/state`, `/api/executions/:id`,
`resolve|present|take-over|continue|away`) and streams change ticksles over
SSE via a single-row fingerprint poll (`PRAGMA busy_timeout` makes the
multi-writer SQLite safe). The static app (`public/`) renders L1/L2/L3 with
progressive disclosure and never shows raw transcripts. CLI parity:
`conductor ui|init|metrics|timeline`, and `show` prints the seven fields.

### 10.6 Safety hardening found by this phase's audit

- A lifecycle event arriving while the run is **held** no longer throws
  (turn-end during PAUSED keeps the run waiting instead of corrupting state).
- `--accept` / `accepted` now genuinely release the one-time retry token
  (deny picks never do); consumption is a conditional
  `UPDATE … WHERE consumed_at IS NULL` — exactly-once across processes.
- `require_approval` rules match **all** policy categories; new
  `require-approval-dependency-install` rule gates package installs
  (`pnpm add`, `npm install`, `pip install`, …) — the `dependencies` category
  referenced earlier is no longer empty.

Roadmap: Phases 0–9 complete.

## 11. Attention OS v1 (Phase 10, as built)

Phase 9 answered *"does this action need attention?"*. Phase 10 answers the
question that actually governs a human's day: **"of everything happening,
where should my attention go?"** — and just as importantly, *"why didn't you
interrupt me?"* No second state machine, no event bus, no new persistence
engine was added: Attention OS is a **pure derivation layer** on top of the
existing executions / decisions / events / policy / attention tables, computed
on demand and never on the event hot path.

### 11.1 Attention candidates — one canonical derived representation

`src/attention/attention-candidate.ts`. Every attention-worthy thing (a
pending decision, a blocked run, a failure cluster, a delegation-covered
action) is projected into an `AttentionCandidate`: subject, goal, agent,
category, disposition, explainable `AttentionFactors`, and the seven-field
decision *why* when available. Factors carry **explicit `null` when
unmeasurable** (ambiguity of a decision that never stored evidence, blocked
time before we recorded transitions). No numeric "AI attention score" is
computed anywhere; ordering is by factor comparison, never by a blended
scalar.

### 11.2 Deterministic prioritization (`attention-priority.ts`)

A lexicographic total order over real facts:

1. blocking (is an agent stopped *right now*)
2. consequence tier (critical > high > major > medium > low) — safety always leads
3. effective urgency — **age escalates urgency by at most one level after a
   5-minute grace** (anti-starvation), and low can only age up to medium:
   *stale never becomes urgent enough to outrank a real consequence*
4. disposition rank, 5. irreversibility, 6. ambiguity (unmeasured sorts last),
   7. dependents, 8. **oldest-first** among equals.

`priorityFacts()` narrates each placement ("Consequence HIGH · Agent blocked
YES · Waiting 4m") so every ordering is explainable in the UI and CLI alike.

### 11.3 Suppression dispositions & the interruption budget

Dispositions `IGNORE|OBSERVE|SURFACE|BATCH|QUEUE|INTERRUPT|CRITICAL` are a
presentation vocabulary layered over the unchanged SILENT…CRITICAL
classification. **Important ≠ interrupt.** The budget (`attention-suppression.ts`)
gives the developer exactly **one "needs you now" slot when present, zero when
away** — CRITICAL items never demote (safety invariant) and, because they own
the front row, they *consume* the slot so ordinary interrupts queue beneath
them with a `whyWaiting` sentence attached. Demotion changes **presentation
only**: the control-plane pause, the decision row, and the retry token behave
exactly as if the item had interrupted. Nothing is ever suppressed below
`QUEUE`; nothing is destroyed.

### 11.4 Dedupe & batching with forensic honesty

Duplicate deliveries collapse to one candidate (refIds preserved). Related
observations (`test.failed` storms) cluster within a 10-minute window into one
"3 failures grouped" headline whose `clusterIds`/`refIds` still name every
underlying immutable event row — 21 events surface as one item, and the raw
forensics stay one query away.

### 11.5 The inverse explanation (`non-interruption-why.ts`)

Every autonomous pass is explainable after the fact:
`explainNonInterruption(event)` composes the *stored* classification metadata,
a deterministic policy re-evaluation, reversibility, consequence tier, and any
covering delegation into "allowed because …". Attention saved is reported as
**`not measured`**, because we do not measure it — honesty over false
precision. `autonomousHighlights()` lists what the system let through.

### 11.6 Structured delegation — entrustment, distinct from policy

`src/types/delegation.ts`, `src/delegation/delegation-service.ts`,
`delegations` table. A delegation is **scoped** (execution or workspace),
**categorized** (policy category + optional resource substring narrowing),
**expiring**, **revocable**, and **audited** (rows survive revocation). One
authority exists in v1 (`allow-autonomously`), and it always originates from a
human (CLI/UI); agents cannot delegate to themselves. Enforcement is a single
code path: the manager downgrades a covered PAUSE to RECORD + writes an
immutable `policy.delegated` forensic event; the bridge gate honors the same
cover at dispatch. **Safety invariant: an explicit human denial of the same
subject, newer than the grant, shadows the delegation** (newest human verdict
wins; a later explicit approval clears the shadow). Decision memory surfaces
**offers** ("you approved this 3× — delegate?") but the service never grants on
its own.

### 11.7 The orchestrator + surfaces

`buildAttentionModel({executions, decisions, events, now})` returns the fleet
map (`🔴 needs-you / waiting / watching / ✓ working` counts, per-agent rows,
and a transparent **attention load** LOW/MED/HIGH/OVERLOADED *with reasons*).
It is a pure function called by the CLI (`conductor attention`, `--why`,
`--history`) and the UI cockpit (progressive disclosure: what matters → why →
evidence) — same derivation, same numbers, zero hot-path cost, SSE
fingerprint unchanged (delegations folded into it).

### 11.8 What is implemented vs aspirational

**Implemented & tested:** everything above, incl. the deterministic 5-agent
demo, adversarial sequences (denial-beats-delegation, budget-cannot-lose-a-
decision, exactly-once under races, late events to finished runs), metrics
(attention ratio, autonomous actions, deferral counts) — and the standing
invariant that with zero delegations, behavior is identical to Phase 9.
**Experimental:** batch-window auto-clustering headlines (heuristic
subject-matching), the urgency-aging constant, offer phrasing.
**Deliberately not built:** ML prioritization, attention-savings estimation,
multi-user delegation, approval inheritance across sessions, scheduled
digests, per-factor weighting knobs — all would add a second source of truth
or fake precision the mission forbids.


## 12. DSH bundle integration (Phase 10.1, as built)

Conductor ships as one official mechanism: an npm **bundle** a profile pulls
in via `dsh plugin add`. No competing plugin system was invented; the
package simply conforms to the composition chain verified against the live
DSH 0.1.5-rc.1 sources:

```
package.json#dsh.bundle.patch = ./cordis.patch.yml
        │  dsh plugin --profile <p> add <pkg>   (pnpm forward + reconcile →
        ▼   dsh.profile.bundles gains the name)
profile package.json#dsh.profile.bundles
        │  boot: resolveBundleDir → read patch from the INSTALLED package dir
        ▼  (bare names import against the profile directory)
cordis.patch.yml:  - insert: [{ id: dsh-conductor, name: dsh-conductor }]
        ▼
Cordis loader row → dist/src/dsh/bundle-entry.js  (exports['.'])
        │  export const name + export function apply(ctx, config)
        ▼   — the official static shape (NOT a factory returning a plugin;
        ▼     that shape silently no-ops in this loader version)
mountConductor(config)          src/dsh/mount.ts — the ONE composition root
        ▼
ConductorBridge + ExecutionManager + policy + attention + SQLite
```

**Terminology discipline.** *Bundle* = this package (config layer).
*Profile* = a runnable composition (never published by us). *Plugin* = the
module the loader mounts (`bundle-entry.js`). *Runtime* = `ConductorRuntime`
from `composition.ts`. *Control plane* = executions/decisions/policy/SQLite.
*Attention OS* = the pure derivation layer (§11) — none of it knows DSH
exists.

**Execution adoption across processes.** Headless DSH ends the turn the
moment a consequential tool is held (`turn/end {kind:'blocked'}`); the
operator's `conductor resolve` therefore lands *between* runs. Approvals are
execution-scoped, so a remount of the same workspace adopts the newest
non-terminal execution (`reuseOpenExecution` — bundle-only; default mounts
keep P9 semantics byte-identical). Adoption never clears a pause: pending
decisions keep gating the fresh run.

**Lifecycle truths (all lived in the clean room, not assumed):**
- `dsh plugin add <folder>` links; `<tarball>` installs a COPY — the copy
  must be self-sufficient (`files` allow-list: dist/src + patch).
- remove reconciles `dsh.profile.bundles` automatically; reinstall and
  update re-register cleanly; a profile boots fine without the bundle.
- Duplicate registration is refused twice over: the loader hard-fails a
  repeated row id at boot, and `bundle-entry` guards in-process mounts.
- DSH placement env: no XDG; `$DSH_HOME` else `~/.dsh`. No official service
  exposes the active profile name — Conductor deliberately does not need
  it; workspace-scoped `.conductor/conductor.db` (or `CONDUCTOR_DB_PATH`)
  keeps the CLI/UI and the mounted plane shared without profile coupling.
- Validation is gated: `scripts/validate-package.mjs` fails on absolute
  author paths, missing bundle declaration, patch artifacts referencing
  nonexistent files, artifacts outside `files`, duplicate patch ids — run
  via `pnpm validate:package` and automatically in `prepack`.
