/**
 * DSH Conductor — live control-plane demo (dynamic host package, plain JS).
 * In-memory port of the shipped src/dsh bridge semantics: same policy,
 * same attention outcome, same decision queue, same approvals.
 */
const HARMLESS = /^(cat|echo|grep|head|tail|wc|ls\b|pwd$|date|sleep|which|test\b|\[|node -e|node --test|timeout \d+ (node_modules\/\.bin\/tsc|node)|sed -n|git (status|log|show|diff)|git add|git commit|git (checkout -b|push origin (main|feature\/)|merge))\b/
const DESTRUCTIVE = /(rm -rf|git push --force|terraform destroy|kubectl delete|DROP TABLE|drop table|mkfs|dd if=|curl.*\|\s*(ba)?sh|chmod -R 777|>\s*\/etc\/)/
const APPROVALS = /(npm (publish|add)|pnpm (publish|add)|git push origin|docker (push|rm)|brew install|pip install|apt (get|install)|yarn (add|publish))/
const CONDUCTOR_HOLD = /conductor decisions|Conductor holds/i

function classifyTool(name, args) {
  if (name === 'bash' || name === 'pwsh') {
    const cmd = String(args && args.command || '')
    if (HARMLESS.test(cmd) && !DESTRUCTIVE.test(cmd)) return { impact: 'allow' }
    if (DESTRUCTIVE.test(cmd)) return { impact: 'deny', kind: 'dangerous', label: 'command `' + cmd.slice(0, 80) + '`', critical: true }
    if (APPROVALS.test(cmd) && !CONDUCTOR_HOLD.test(cmd)) return { impact: 'approval', kind: 'consequential', label: 'command `' + cmd.slice(0, 80) + '`', critical: false }
    if (/\b(rmdir|rm)\b/.test(cmd)) return { impact: 'allow' }
    return { impact: 'allow' }
  }
  if (name === 'write' || name === 'edit' || name === 'create_file') {
    const path = String((args && (args.file_path || args.path)) || '')
    if (/\/(etc|boot|usr|sys|proc|dev)\//.test(path) || /\.ssh\/|id_rsa|\.env$/.test(path)) return { impact: 'deny', kind: 'dangerous', label: 'write to `' + path + '`', critical: true }
    return { impact: 'allow' }
  }
  return { impact: 'allow' }
}

function approvalSubject(name, args) {
  if (name === 'bash' || name === 'pwsh') return 'bash:' + String((args && args.command) || '').trim().replace(/\s+/g, ' ')
  if (name === 'write' || name === 'edit' || name === 'create_file') return 'file:' + String((args && (args.file_path || args.path)) || '')
  return name + ':other'
}

function makeState() {
  return {
    startedAt: Date.now(),
    goal: 'ship DSH Conductor (demo execution)',
    status: 'RUNNING',
    decisions: [],
    events: 0,
    gated: 0,
    denied: 0,
    passedApprovals: 0,
    autoAllowed: 0,
    tokens: new Map(),
    pendingHost: null,
    graceSteps: 0,
  }
}
const S = makeState()

function logLine(msg) {
  console.log('[conductor] ' + msg)
}

function pauseFor(state, reason) {
  if (state.status !== 'PAUSED') { state.status = 'PAUSED'; logLine('PAUSED — ' + reason) }
}

function queueDecision(state, input) {
  const id = 'dec-' + String(state.decisions.length + 1) + '-' + Date.now().toString(36)
  const d = {
    id: id, title: input.title, question: input.question, options: input.options,
    status: 'pending', createdAt: Date.now(), subject: input.subject || null,
  }
  state.decisions.push(d)
  pauseFor(state, 'decision ' + id + ' queued')
  logLine('decision queued: ' + id + ' — ' + d.title)
  return d
}

function resolveDecision(state, id, choice, note) {
  const d = state.decisions.find(function (x) { return x.id === id })
  if (!d) return { ok: false, error: 'no decision ' + id }
  if (d.status !== 'pending') return { ok: false, error: 'already ' + d.status }
  d.status = choice
  d.resolvedAt = Date.now()
  d.answer = note || null
  if (choice === 'approve-once' && d.subject) {
    state.tokens.set(d.subject, (state.tokens.get(d.subject) || 0) + 1)
    logLine('one-time token granted: ' + d.subject)
  }
  const still = state.decisions.some(function (x) { return x.status === 'pending' })
  if (!still && state.status === 'PAUSED') { state.status = 'RUNNING'; logLine('RESUMED — no pending decisions') }
  return { ok: true, decision: d }
}

const CONTROL_PLANE = /^(conductor_status|conductor_decisions|conductor_resolve)$/

function preExecute(state, exec) {
  state.events += 1
  const name = String((exec && exec.name) || '')
  const args = (exec && exec.arguments && typeof exec.arguments === 'object') ? exec.arguments : {}
  if (CONTROL_PLANE.test(name)) return { kind: 'allow' }
  if (state.status === 'PAUSED' || state.status === 'TAKEN_OVER') {
    state.denied += 1
    return { kind: 'deny', reason: 'Conductor holds this run for your judgment. Pending decisions: ' + state.decisions.filter(function (x) { return x.status === 'pending' }).map(function (x) { return x.id }).join(', ') + '. Use conductor_decisions / conductor_resolve, then the agent will retry.' }
  }
  if (name === 'AskUserQuestion' || name === 'ask_user_question') {
    if (state.pendingHost) return { kind: 'allow' }
    const q = Array.isArray(args && args.questions) ? args.questions[0] : (args || {})
    const dq = queueDecision(state, {
      title: 'Agent question: ' + String((q && q.question) || 'question').slice(0, 60),
      question: String((q && q.question) || ''),
      options: (q && q.options) ? q.options.map(function (o) { return o.label || o }) : [],
    })
    state.pendingHost = { decisionId: dq.id }
    logLine('host question mirrored into the conductor queue')
    return { kind: 'allow' }
  }
  const verdict = classifyTool(name, args)
  if (verdict.impact === 'allow') return { kind: 'allow' }
  if (verdict.impact === 'deny') {
    queueDecision(state, { title: 'Dangerous ' + verdict.label, question: 'The agent wants to run ' + verdict.label + '. Allow this one time, or block?', options: ['approve-once', 'deny'], subject: approvalSubject(name, args) })
    state.gated += 1
    state.denied += 1
    state.graceSteps = 3
    return { kind: 'deny', reason: 'Conductor paused the run for your judgment: ' + verdict.label + '. Check conductor_decisions; approve-once to let exactly one retry through.' }
  }
  const subject = approvalSubject(name, args)
  const toks = state.tokens.get(subject) || 0
  if (toks > 0) {
    state.tokens.set(subject, toks - 1)
    state.passedApprovals += 1
    logLine('approval token consumed — one retry allowed: ' + subject.slice(0, 60))
    return { kind: 'allow' }
  }
  queueDecision(state, { title: 'Consequential ' + verdict.label, question: 'The agent wants to ' + verdict.label + '. Approve once or deny?', options: ['approve-once', 'deny'], subject: subject })
  state.gated += 1
  state.denied += 1
  return { kind: 'deny', reason: 'Conductor needs your judgment before: ' + verdict.label + '. conductor_decisions, then conductor_resolve approve-once — the agent will retry automatically.' }
}

function messageText(m) {
  try {
    const c = m && m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(function (b) { return (b && b.type === 'text' && String(b.text || '')).slice(0, 400) }).join(' ')
  } catch (e) { void e }
  return ''
}

function preStep(state, payload, next) {
  if (state.status !== 'PAUSED' && state.status !== 'TAKEN_OVER') { state.graceSteps = 0; return next() }
  // Grace: let the agent wrap up (finish the turn politely) before freezing.
  if (state.graceSteps > 0) {
    state.graceSteps -= 1
    logLine('grace step (' + String(state.graceSteps) + ' left) while held — agent may wrap up')
    return next()
  }
  // The human can always grab the wheel: if this wake carries an explicit
  // conductor instruction, enter the step so the agent can serve it.
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : []
  const override = msgs.some(function (m) { return /conductor|approve|deny|resolve|override|take over|unfreeze/i.test(messageText(m)) })
  if (override) { logLine('human override in inbound message — entering step while held'); return next() }
  // DSH consumes claimed messages on reject: re-inject (no wake) so no work
  // is lost, then reject -> turn ends 'blocked', driver idles quietly.
  const agent = payload && payload.agent
  if (agent && typeof agent.inject === 'function') {
    for (let i = 0; i < msgs.length; i++) { try { agent.inject(msgs[i]) } catch (e) { void e } }
  }
  logLine('step frozen (' + state.status + '): ' + String(msgs.length) + ' message(s) re-injected, not lost')
  return Promise.resolve({ kind: 'reject' })
}

/* ---- unit checks (run once at mount; failures log loudly) ---- */
function selfTest() {
  const problems = []
  const t = function (cond, msg) { if (!cond) problems.push(msg) }
  t(classifyTool('bash', { command: 'git push --force origin main' }).impact === 'deny', 'force-push must be dangerous')
  t(classifyTool('bash', { command: 'node dist/src/cli/bin.js status' }).impact === 'allow', 'conductor CLI must be harmless')
  t(classifyTool('bash', { command: 'pnpm publish' }).impact === 'approval', 'publish needs approval')
  const s2 = makeState()
  const dr = preExecute(s2, { name: 'bash', arguments: { command: 'git push --force origin testbr' }, callId: 'x' })
  t(dr.kind === 'deny' && s2.status === 'PAUSED' && s2.graceSteps === 3, 'gate must pause with wrap-up grace')
  t(preStep(s2, { messages: [] }, function () { return 'entered' }) === 'entered', 'grace step may enter')
  s2.graceSteps = 0
  let rejected = false
  preStep(s2, { agent: { inject: function () { void 0 } }, messages: [{ content: [{ type: 'text', text: 'routine steer' }] }] }, function () { rejected = true; return 'entered' })
    .then(function (d) { t(d && d.kind === 'reject' && !rejected, 'post-grace step frozen, message re-injected') })
  s2.graceSteps = 0
  preStep(s2, { agent: { inject: function () { void 0 } }, messages: [{ content: [{ type: 'text', text: 'please resolve dec-1 approve-once' }] }] }, function () { rejected = true; return 'entered' })
  t(rejected, 'human override message enters even while frozen')
  const d2 = s2.decisions[0]
  t(preExecute(s2, { name: 'bash', arguments: { command: 'git push --force origin testbr' }, callId: 'y' }).kind === 'deny', 'held state denies more')
  resolveDecision(s2, d2.id, 'approve-once')
  t(s2.status === 'RUNNING', 'approve resumes')
  t(preExecute(s2, { name: 'bash', arguments: { command: 'git push --force origin testbr' }, callId: 'z' }).kind === 'allow', 'token allows exactly one retry')
  t(preExecute(s2, { name: 'bash', arguments: { command: 'git push --force origin testbr' }, callId: 'w' }).kind === 'deny', 'second retry re-gates')
  return problems
}

function buildPlugin() {
  return {
    name: 'conductor-live-demo',
    apply: function (ctx) {
      const problems = selfTest()
      if (problems.length) console.log('[conductor] SELF-TEST FAILURES: ' + problems.join(' | '))
      else console.log('[conductor] self-test: gate/hold/token/resume semantics verified')

      ctx.on('agent/pre-step', function (payload, next) { return preStep(S, payload, next) })
            ctx.on('tools/pre-execute', function (exec, next) {
        const d = preExecute(S, exec)
        return d.kind === 'allow' ? next() : Promise.resolve(d)
      })

      const tools = [
        {
          name: 'conductor_status',
          description: 'DSH Conductor live demo: control-plane status (execution status, counts, pending decisions).',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { status: { type: 'string' }, events: { type: 'number' }, gated: { type: 'number' }, denied: { type: 'number' }, pending: { type: 'number' }, goal: { type: 'string' } }, required: ['status', 'events', 'gated', 'denied', 'pending'] },
            render: function (args, value) { return [String(value.status) + ' — events ' + String(value.events) + ', gated ' + String(value.gated) + ', pending ' + String(value.pending)] },
          },
          execute: function () {
            return { goal: S.goal, status: S.status, events: S.events, gated: S.gated, denied: S.denied, passed: S.passedApprovals, pending: S.decisions.filter(function (x) { return x.status === 'pending' }).length }
          },
        },
        {
          name: 'conductor_decisions',
          description: 'List the live decision queue with options and statuses.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['id', 'title', 'status'] } },
            render: function (args, value) { return value.map(function (d) { return d.id + ' [' + d.status + '] ' + d.title }).join('\n') || 'empty queue' },
          },
          execute: function () {
            return S.decisions.map(function (d) { return { id: d.id, title: d.title, status: d.status, options: d.options, question: d.question, answer: d.answer || null } })
          },
        },
        {
          name: 'conductor_resolve',
          description: 'Resolve a pending decision. choice approve-once lets exactly one retry of that action through; deny blocks permanently; clarify answers a mirrored agent question with custom text.',
          parameters: {
            type: 'object',
            properties: { decisionId: { type: 'string' }, choice: { type: 'string', enum: ['approve-once', 'deny', 'clarify'] }, answer: { type: 'string' } },
            required: ['decisionId', 'choice'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: 'string' }, error: { type: 'string' } }, required: ['ok'] },
            render: function (args, value) { return value.ok ? 'resolved — run status ' + String(value.status) : 'error: ' + String(value.error) },
          },
          execute: function (args) {
            const r = resolveDecision(S, String(args.decisionId), String(args.choice), args.answer ? String(args.answer) : null)
            if (r.ok && S.pendingHost && S.pendingHost.decisionId === String(args.decisionId)) {
              // Mirrored host questions are answered through the normal DSH UI
              // card; this only closes the conductor-side bookkeeping.
              S.pendingHost = null
              S.autoAllowed += 1
            }
            return { ok: r.ok, status: S.status, error: r.error }
          },
        },
      ]
      for (let i = 0; i < tools.length; i++) {
        const off = harness.registerTool(ctx, harness.defineTool(tools[i]))
        ctx.effect(function () { return off })
      }
      ctx.effect(function () {
        return function () { console.log('[conductor] detached — control plane gone with this run') }
      })
      console.log('[conductor] LIVE control plane mounted: gate on tools/pre-execute, freeze on agent/pre-step, 3 model tools registered')
    },
  }
}

const plugin = buildPlugin()
if (harness && typeof harness.handle === 'function') {
  harness.handle('peek', function () {
    return { status: S.status, events: S.events, gated: S.gated, denied: S.denied, passed: S.passedApprovals, mirroredQuestions: S.autoAllowed, decisions: S.decisions.map(function (d) { return { id: d.id, title: d.title, status: d.status, options: d.options } }) }
  })
}
return plugin
