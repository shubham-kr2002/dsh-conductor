/* Conductor control surface — vanilla, no framework, no build step.
 * Renders the derived views the server computes; the browser computes
 * nothing but formatting. One control plane, many windows. */
'use strict';

const $ = (s) => document.querySelector(s);
const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
};
const api = async (path, body) => {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
};
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let STATE = null;
let awayMode = false;
let detailExec = null;

/* ── L1: the one honest sentence ───────────────────────── */
function renderL1() {
  const a = STATE.attention;
  const line = $('#attention-line');
  line.textContent = '';
  if (a.working === 0 && STATE.executions.length === 0) {
    line.append(h('span', null, 'No agents are running.'));
  } else {
    line.append(h('span', null, `${a.working} agent${a.working === 1 ? '' : 's'} working · `));
    if (a.needsYou > 0) {
      line.append(h('span', 'need', `${a.needsYou} need${a.needsYou === 1 ? 's' : ''} your judgment`));
    } else {
      line.append(h('b', null, 'nothing needs you'));
    }
  }
  const b = $('#budget-line');
  b.textContent = '';
  b.append(h('span', 'auto', `○ ${fmtDur(a.autonomousMs)} autonomous`));
  b.append(h('span', null, '  /  '));
  b.append(h('span', 'att', `● ${fmtDur(a.humanMs)} attention`));
  b.append(h('span', null, `  ·  attention ratio ${Math.round(a.attentionRatio * 100)}%`));
}

/* ── L2: compact execution cards (never a transcript) ──── */
function renderCards() {
  const wrap = $('#cards');
  wrap.textContent = '';
  const ordered = [...STATE.executions].sort((x, y) => (y.needsYou - x.needsYou) || (y.pendingDecisions - x.pendingDecisions) || (y.metrics.totalMs - x.metrics.totalMs));
  if (ordered.length === 0) {
    wrap.append(h('div', 'empty', 'Start an execution — `conductor ui` watches whatever the mounted plugin writes.'));
    return;
  }
  for (const c of ordered) {
    const card = h('article', `panel card tone-${c.tone}${c.needsYou && c.pendingDecisions ? ' needs-attention' : ''}`);
    const head = h('div', 'head');
    head.append(h('div', 'goal', c.goal));
    const st = h('div', 'st');
    st.append(h('span', `dot ${c.tone}`), h('span', null, c.statusLabel));
    head.append(st);
    card.append(head);
    card.append(h('div', 'activity', c.lastActivity));
    const meta = h('div', 'meta');
    meta.append(
      h('span', null, `${c.agent} · ${c.phase}`),
      h('span', null, `${c.filesChanged} files`),
      h('span', null, fmtDur(c.metrics.totalMs)),
      h('span', 'flag', c.pendingDecisions ? `${c.pendingDecisions} awaiting you` : ''),
    );
    card.append(meta);
    const bar = h('div', 'ratio-bar');
    const fill = h('i', c.metrics.attentionRatio > 0.25 ? 'att' : '');
    fill.style.width = `${Math.min(100, Math.round((1 - c.metrics.attentionRatio) * 100))}%`;
    bar.append(fill);
    card.append(bar);
    card.addEventListener('click', () => openDetail(c.executionId));
    wrap.append(card);
  }
}

/* ── L3: decision queue with the seven-field why ───────── */
function whyBlock(d, w) {
  const why = h('div', 'why');
  const row = (k, v) => {
    if (!v) return;
    const r = h('div', 'row');
    r.append(h('div', 'k', k), h('div', 'v', v));
    why.append(r);
  };
  row('What', w.what);
  row('Why now', w.whyNow);
  row('Impact', w.impact);
  row('Reversible', w.reversibility + (w.reversibilityNote ? ` — ${w.reversibilityNote}` : ''));
  const ev = h('div', 'row');
  ev.append(h('div', 'k', 'Evidence'));
  const v = h('div', 'v');
  const chips = h('div', 'evi');
  for (const rid of w.evidence.ruleIds) chips.append(h('span', 'chip rule', rid));
  chips.append(h('span', `chip blast-${w.evidence.blastRadius}`, w.evidence.blastRadius));
  chips.append(h('span', `chip reversibility-${w.evidence.ambiguity > 0.5 ? 'unknown' : 'reversible'}`, `ambiguity ${Math.round(w.evidence.ambiguity * 100)}%`));
  for (const r of w.evidence.affectedResources.slice(0, 3)) chips.append(h('span', 'chip', r.length > 48 ? `${r.slice(0, 48)}…` : r));
  if (!w.evidence.taskAligned) chips.append(h('span', 'chip', 'off-goal'));
  v.append(chips);
  ev.append(v);
  why.append(ev);
  row('Recommend', w.recommendation || (d.recommendation ?? ''));
  row('If you say yes', w.consequences.approve);
  row('If you say no', w.consequences.reject);
  return why;
}

function decisionItem(d) {
  const resolved = d.status !== 'pending';
  const item = h('div', `panel decision ${resolved ? 'resolved' : ''}${d.status === 'rejected' || d.status === 'expired' ? ' rejected-d' : ''}`);
  const head = h('div', 'd-head');
  const meta = h('div');
  meta.append(
    h('div', 'impact ' + d.impact, `${d.impact} · ${d.urgency} urgency`),
    h('div', 'title', d.title),
    h('div', 'ex-goal', `${d.executionGoal} · ${fmtClock(d.createdAt)} · ${d.statusLabel}${d.resolvedBy ? ` · by ${d.resolvedBy}` : ''}`),
  );
  head.append(meta);
  item.append(head);
  item.append(h('div', 'question', d.question));
  if (d.why && !resolved) item.append(whyBlock(d, d.why));
  if (d.why && resolved) item.append(whyBlock(d, d.why));

  const acts = h('div', 'actions');
  if (!resolved) {
    const review = h('button', 'ghost', 'Review');
    review.append(h('span', 'sub', 'full context'));
    review.addEventListener('click', () => openDetail(d.executionId));
    acts.append(review);

    const reject = h('button', 'danger', 'Reject');
    reject.append(h('span', 'sub', 'explain, then continue'));
    reject.addEventListener('click', () => actOn(d, { outcome: 'rejected' }));
    acts.append(reject);

    if (d.isQuestion) {
      const input = h('input', 'custom-in');
      input.placeholder = 'Answer… (or pick an option)';
      input.id = `custom-${d.id}`;
      acts.append(input);
      for (const opt of d.options) {
        const b = h('button', opt.isRecommended ? 'primary' : '', opt.label);
        b.addEventListener('click', () => {
          const val = document.getElementById(input.id);
          actOn(d, { outcome: 'custom', selectedOptionId: opt.id, customValue: (val && val.value) || opt.label });
        });
        acts.append(b);
      }
    } else {
      const approve = h('button', 'primary', 'Approve once');
      approve.append(h('span', 'sub', 'this action only'));
      approve.addEventListener('click', () => actOn(d, { outcome: 'accepted', selectedOptionId: 'approve-once' }));
      acts.append(approve);
    }
  } else if (d.customValue) {
    acts.append(h('span', 'amb', `answer: ${d.customValue}`));
  }
  if (d.quality && d.quality.responseMs != null) {
    acts.append(h('span', 'amb', `answered in ${fmtDur(d.quality.responseMs)}`));
  }
  item.append(acts);
  return item;
}

async function actOn(d, body) {
  try {
    await api(`/api/decisions/${encodeURIComponent(d.id)}/resolve`, { answerBy: 'developer', ...body });
    toast('Decision recorded — the agent moves on the next beat.');
    await refresh();
  } catch (err) { toast(`Could not resolve: ${err.message}`); }
}

function renderQueue() {
  const list = $('#decision-list');
  list.textContent = '';
  const pending = STATE.queue.filter((d) => d.status === 'pending');
  const done = STATE.queue.filter((d) => d.status !== 'pending').slice(0, 4);
  const count = $('#queue-count');
  count.textContent = pending.length ? String(pending.length) : '';
  count.classList.toggle('hot', pending.length > 0);
  if (pending.length === 0) {
    list.append(h('div', 'empty', 'Nothing needs your judgment. Go do your actual work.'));
  } else {
    for (const d of pending) list.append(decisionItem(d));
  }
  if (done.length) {
    list.append(h('h2', 'sec', 'Answered'));
    for (const d of done) list.append(decisionItem(d));
  }
  const q = $('#quality-strip');
  q.textContent = '';
  const roll = STATE.quality;
  if (roll && roll.resolved > 0) {
    q.append(
      h('span', null, `${roll.resolved} answered`),
      h('span', null, roll.medianResponseMs != null ? `median response ${fmtDur(roll.medianResponseMs)}` : ''),
      h('span', null, roll.recurredCount ? `${roll.recurredCount} came back — answer didn't stick` : 'none came back'),
    );
  }
  // mark pending decisions as presented (observable fact, once)
  for (const d of pending) api(`/api/decisions/${encodeURIComponent(d.id)}/present`, {}).catch(() => {});
}

/* ── detail overlay: progressive disclosure ────────────── */
async function openDetail(execId) {
  try {
    const d = await api(`/api/executions/${encodeURIComponent(execId)}`);
    detailExec = d;
    const box = $('#detail');
    box.textContent = '';
    const close = h('button', 'ghost close', '✕ close');
    close.addEventListener('click', () => { $('#overlay').hidden = true; detailExec = null; });
    box.append(close);
    box.append(h('h3', null, d.goal));
    box.append(h('div', 'ex-goal', `${d.statusLabel} · ${d.agent} · phase ${d.phase} · ${d.statusMeaning}`));

    if (d.away) {
      box.append(h('h4', null, 'While you were away'));
      box.append(h('div', 'away-box', d.away.rendered));
    }

    box.append(h('h4', null, 'Attention budget'));
    const kv = h('div', 'kv');
    const kvrow = (k, v) => { kv.append(h('span', 'k', k), h('span', null, v)); };
    kvrow('total', fmtDur(d.metrics.totalMs));
    kvrow('autonomous', fmtDur(d.metrics.autonomousMs));
    kvrow('waiting for you', fmtDur(d.metrics.heldMs));
    kvrow('you driving', fmtDur(d.metrics.humanControlMs));
    kvrow('attention ratio', `${Math.round(d.metrics.attentionRatio * 100)}%`);
    kvrow('interruptions', `${d.metrics.interruptions} (decisions + takeovers)`);
    if (d.constraints.length) kvrow('constraints', d.constraints.join('; '));
    if (d.risks.length) kvrow('risks', d.risks.join('; '));
    box.append(kv);

    box.append(h('h4', null, 'Timeline — what happened, condensed'));
    const tl = h('ul', 'tl');
    const glyph = { ok: '✓', bad: '✗', warn: '⚠', info: '·' };
    for (const t of d.timeline) {
      const li = h('li', t.tone);
      li.append(h('span', 'time', fmtClock(t.at)), h('span', 'g', glyph[t.tone] || '·'));
      const txt = h('span', null, t.text + (t.count > 1 ? `  ×${t.count}` : ''));
      li.append(txt);
      if (t.detail) li.append(h('span', 'detail', t.detail));
      tl.append(li);
    }
    box.append(tl);

    if (d.interventions.length) {
      box.append(h('h4', null, 'Human interventions'));
      const iv = h('ul', 'tl');
      for (const it of d.interventions) {
        const li = h('li', 'info');
        li.append(h('span', 'time', fmtClock(it.timestamp)), h('span', 'g', '⚑'), h('span', null, `${it.type} — ${it.summary} (${it.actor})`));
        iv.append(li);
      }
      box.append(iv);
    }

    box.append(h('h4', null, 'Control'));
    const acts = h('div', 'acts');
    if (d.status !== 'TAKEN_OVER' && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(d.status)) {
      const t = h('button', null, 'Take over');
      t.addEventListener('click', async () => {
        try {
          const r = await api(`/api/executions/${encodeURIComponent(d.executionId)}/take-over`, { actor: 'developer' });
          toast('You are in control. The agent is frozen.');
          if (r.brief) { box.append(h('h4', null, 'Continuation brief'), h('div', 'away-box', r.brief)); }
          await refresh();
        } catch (err) { toast(`Takeover failed: ${err.message}`); }
      });
      acts.append(t);
    }
    if (d.status === 'TAKEN_OVER') {
      const g = h('button', 'primary', 'Return control to agent');
      g.addEventListener('click', async () => {
        try { await api(`/api/executions/${encodeURIComponent(d.executionId)}/continue`, { actor: 'developer' }); toast('Control returned.'); await refresh(); openDetail(d.executionId); }
        catch (err) { toast(`Continue failed: ${err.message}`); }
      });
      acts.append(g);
    }
    const aw = h('button', 'ghost', 'Mark away');
    aw.addEventListener('click', async () => {
      try { await api(`/api/executions/${encodeURIComponent(d.executionId)}/away`, { actor: 'developer' }); goAway(); } catch (err) { toast(err.message); }
    });
    acts.append(aw);
    box.append(acts);

    $('#overlay').hidden = false;
  } catch (err) {
    toast(`Could not load detail: ${err.message}`);
  }
}

/* ── away / return ─────────────────────────────────────── */
function goAway() {
  awayMode = true;
  document.body.style.opacity = '0.25';
  document.body.style.pointerEvents = 'none';
  toast('Away marked. Click anywhere when you are back.', 60000);
}
document.body.addEventListener('click', () => {
  if (!awayMode) return;
  awayMode = false;
  document.body.style.opacity = '';
  document.body.style.pointerEvents = '';
  refresh().then(() => {
    const a = STATE.attention;
    toast(a.needsYou > 0 ? `Welcome back — ${a.needsYou} execution(s) need your judgment.` : 'Welcome back — nothing needed you.');
  });
}, true);

/* ── shell wiring ──────────────────────────────────────── */
let toastTimer = null;
function toast(msg, ms = 4200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function refresh() {
  try {
    STATE = await api('/api/state');
    renderL1();
    renderCards();
    renderQueue();
  } catch (err) {
    $('#attention-line').textContent = `control plane unreachable: ${err.message}`;
  }
}

$('#btn-away').addEventListener('click', (e) => { e.stopPropagation(); goAway(); });
$('#btn-refresh').addEventListener('click', (e) => { e.stopPropagation(); refresh(); });
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') { $('#overlay').hidden = true; detailExec = null; } });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#overlay').hidden = true; detailExec = null; }
});

/* live propagation: SSE tickle → refetch (throttled) */
let pending = false;
function scheduleRefresh() {
  if (pending) return;
  pending = true;
  setTimeout(async () => {
    pending = false;
    await refresh();
    if (detailExec && !$('#overlay').hidden) openDetail(detailExec.executionId);
  }, 350);
}
function connect() {
  const es = new EventSource('/stream');
  const dot = $('#live-dot');
  es.onopen = () => dot.classList.add('on');
  es.onerror = () => dot.classList.remove('on');
  es.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.type === 'changed') scheduleRefresh();
    } catch { /* comment heartbeats */ }
  };
}

refresh();
connect();
