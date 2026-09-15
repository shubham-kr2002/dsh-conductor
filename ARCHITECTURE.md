# DSH Conductor — Architecture & Integration Specification

**Product:** Conductor — The Human-Control Layer for Autonomous Coding Agents  
**Target Runtime:** DeepSeek Harness (DSH) on Node.js v24+  
**Workspace:** `/run/media/shubh/New Volume/company/dsh/dsh-conductor`  
**Date:** September 2024  
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
| **Storage Fragmentation** | Execution state lost across session restarts. | ACID SQLite storage persists every state transition and decision synchronously before acknowledging actions. |

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

Phases 0–8 **complete**. Phase 8 delivered the DSH plugin integration: normalized host contracts, the pure Conductor bridge, the cordis mounting layer, and live cross-process approval flow (93/93 tests).
