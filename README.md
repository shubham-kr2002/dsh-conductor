# DSH Conductor

**The human-control layer for autonomous coding agents.**

Let the agent work continuously. Interrupt the developer only when human
judgment is genuinely required. Conductor optimizes one metric above all:
**human attention minutes per successfully completed task.**

Conductor is **not** another coding agent, memory system, dashboard, or chat
UI. It is a *control plane* that sits between an autonomous agent and the one
human who must occasionally exercise judgment.

```
        ┌────────────────────────────────────────────────┐
        │                    YOU                         │
        │   decisions · take-over · return summaries     │
        └───────────────▲────────────────────────────────┘
                        │ only when judgment is required
                 ┌──────┴───────┐
                 │  CONDUCTOR   │  policy · attention · queue
                 │ control plane│  state · handoff · summary
                 └──────┬───────┘
                        │ observes & gates every action
                 ┌──────┴───────┐
                 │   CODING     │  via DSH extension points
                 │   AGENT      │  (tool hooks, events, questions)
                 └──────────────┘
```

## What it does

| Capability | What you experience |
|---|---|
| **Execution state** | Every run is a durable state machine (`RUNNING`, `PAUSED`, `BLOCKED`, `TAKEN_OVER`, …) with full history — in local SQLite, nothing in the cloud. |
| **Event pipeline** | Agent activity (tool calls, file edits, commands, tests, questions) is normalized into a uniform event stream and classified. |
| **Policy engine** | Deterministic rules decide what's routine, what needs approval, what's denied outright (secrets access, `sudo`, system writes). |
| **Attention engine** | Rules classify every event SILENT / BACKGROUND / DECISION / CRITICAL. Low-consequence work stays silent; critical or ambiguous work pauses the run. Self-healing retries are *not* interruptions. |
| **Decision queue** | Pauses become concrete, prioritized, answerable questions — never log noise. Accept / reject / custom answer; resolving the last pending decision resumes the agent automatically. |
| **Take over / continue** | Freeze the agent, capture workspace state, edit files yourself, hand back. Conductor reconciles your changes into the execution state and tells the agent the current workspace is authoritative. |
| **Away mode** | Come back to a decision-oriented summary of what happened while you were gone — *not* a transcript. |
| **Handoff** | Structured state transfer between agents: goal, completed work, binding decisions, failed approaches, test rollup, risks, next action. No transcript dumping. |

## Quick start

```bash
pnpm install
pnpm build

# start an execution
conductor run "refactor the billing module"

# what's going on / what needs me?
conductor status
conductor summary          # while-you-were-away brief (decision-oriented)

# things that need your judgment, highest priority first
conductor decisions
conductor resolve dec-… --reject --feedback "never force-push to main"
conductor resolve dec-… --accept

# jump in yourself, then give control back
conductor take-over exec-… --notes "the migration is wrong"
#   …edit files in the workspace…
conductor continue exec-… --notes "use the .sql I committed, not the ORM"

# move an execution to another agent (or a fresh session)
conductor handoff exec-… --from agent-alpha
conductor adopt hov-… --to agent-beta

# audit trail
conductor history -l 100
```

State lives in `./.conductor/conductor.db` (override with `CONDUCTOR_DB_PATH`).

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and the DSH
extension-point archaeology. The short version:

- `src/domain` — pure state machines & aggregates (no deps)
- `src/storage` — SQLite (native `node:sqlite`) behind repository interfaces
- `src/adapter` — normalizes raw runtime activity into `ConductorEvent`s
- `src/policy` — deterministic allow/approve/deny rules
- `src/attention` — deterministic attention classification (LLM escalation
  is an *option*, gated by `needsLlmReview`, never a default)
- `src/decision` — prioritized queue, resolution semantics, auto-resume
- `src/takeover` — freeze/capture/continue/reconcile
- `src/summary` — away-mode briefs
- `src/handoff` — structured agent-to-agent state transfer
- `src/manager` — orchestrates the above
- `src/dsh` — the integration layer (the *only* DSH-facing code): normalized
  host contracts → pure `ConductorBridge` → cordis mounting layer. It gates
  `tools/pre-execute`, freezes `agent/pre-step` (re-injecting claimed inbox
  messages so nothing is lost), mirrors `user-questions/request` into the
  decision queue, vetoes `approval/request` while a human holds the run, and
  ingests the post-commit `session/event` log.

Conductor core never depends on DSH tools; DSH integration lives behind
injected host bindings so the core stays testable standalone.

### Mounting into DSH

Add a composition row to your profile and share the same SQLite file with
the CLI — the agent keeps working, the CLI is your control surface:

```yaml
- name: 'dsh-conductor'   # dist/src/dsh/cordis-plugin.js (see ARCHITECTURE.md §8)
  config:
    goal: 'finish the payments migration'
    workspaceRoot: /srv/payments
    dbPath: /srv/payments/.conductor/conductor.db
```

## Development

```bash
pnpm test        # builds to dist/ then runs node:test (93 tests)
pnpm run typecheck
pnpm run lint
pnpm run build
```

Status: Phases 0–8 complete. `pnpm test` → 93/93.

## License

MIT
