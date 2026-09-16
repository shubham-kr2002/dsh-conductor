/* Conductor attention cockpit — vanilla, no framework, no build step.
 * The page renders the ATTENTION MAP the server derives: what matters now
 * (NEEDS YOU), what can safely wait (WAITING), what was batched for later
 * (WATCHING), what is progressing alone (WORKING), and what passed without
 * you (recorded). The browser computes nothing; one control plane, many
 * windows. */
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

let STATE = null;          // /api/state — cards + decision views + budget
let ATT = null;            // /api/attention — the map, items, delegations, offers
let DEC = new Map();       // decision id -> DecisionView (from state.queue)
let seenNy = null;         // ids that were already on the front row (for the one-time pulse)
let awayMode = false;
let detailExec = null;
const dismissedOffers = new Set();
const openClusters = new Set();
let workingOpen = false;
let loggedOpen = false;

/* ── L1: the honest sentence + the load chip ─────────── */
function renderL1() {
  const a = STATE.attention;
  const map = ATT && ATT.model ? ATT.model.map : null;
  const line = $('#attention-line');
  line.textContent = '';
  if (STATE.executions.length === 0) {
    line.append(h('span', null, 'No agents are running.'));
  } else {
    line.append(h('span', null, `${a.working} agent${a.working === 1 ? '' : 's'} working · `));
    if (a.needsYou > 0) {
      line.append(h('span', 'need', `${a.needsYou} need${a.needsYou === 1 ? 's' : ''} your judgment`));
    } else {
      line.append(h('b', null, 'nothing needs you'));
    }
    if (map && map.waiting > 0) line.append(h('span', 'dim', ` · ${map.waiting} waiting`));
  }

  const chip = $('#load-chip');
  chip.textContent = '';
  if (map) {
    chip.hidden = false;
    chip.className = `load-chip load-${map.load.level.toLowerCase()}`;
    chip.append(h('b', null, `Attention load: ${map.load.level}`));
    chip.append(h('span', null, ` — ${map.load.reasons.join('; ')}`));
  } else {
    chip.hidden = true;
  }

  const b = $('#budget-line');
  b.textContent = '';
  b.append(h('span', 'auto', `○ ${fmtDur(a.autonomousMs)} autonomous`));
  b.append(h('span', null, '  /  '));
  b.append(h('span', 'att', `● ${fmtDur(a.humanMs)} attention`));
  b.append(h('span', null, `  ·  ratio ${Math.round(a.attentionRatio * 100)}%`));
  if (ATT && ATT.model.budgetDemoted.length > 0) {
    b.append(h('span', 'demoted', `  ·  ${ATT.model.budgetDemoted.length} held to queue by the budget`));
  }

  $('#deleg-n').textContent = String(ATT ? ATT.delegations.length : 0);
}

/* ── shared pieces ────────────────────────────────────── */
const FACT_SHORT = { 'Agent blocked': 'Blocked', 'Time sensitivity': 'Urgency', 'Work prevented': 'Run held' };
function factChips(item) {
  const row = h('div', 'facts');
  for (const f of (item.facts || [])) {
    const cls = f.factor === 'Consequence' ? `f-cons-${f.value.toLowerCase()}` : f.value === 'YES' ? 'f-hot' : '';
    row.append(h('span', `fact ${cls}`, `${FACT_SHORT[f.factor] || f.factor} ${f.value}`));
  }
  return row;
}

function whyBlock(w) {
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
  for (const r of (w.evidence.affectedResources || []).slice(0, 3)) chips.append(h('span', 'chip', r.length > 48 ? `${r.slice(0, 48)}…` : r));
  if (!w.evidence.taskAligned) chips.append(h('span', 'chip', 'off-goal'));
  v.append(chips);
  ev.append(v);
  why.append(ev);
  row('Recommend', w.recommendation);
  row('If you say yes', w.consequences.approve);
  row('If you say no', w.consequences.reject);
  return why;
}

async function actOn(item, body, el) {
  if (el) el.classList.add('leaving');
  try {
    await api(`/api/decisions/${encodeURIComponent(item.refIds[0])}/resolve`, { answerBy: 'developer', ...body });
    toast('Recorded — the agent moves on the next beat.');
  } catch (err) {
    toast(`Could not resolve: ${err.message}`);
    if (el) el.classList.remove('leaving');
  }
  setTimeout(refresh, 240);
}

function decisionActions(item, el) {
  const acts = h('div', 'actions');
  if (item.kind !== 'decision') {
    // execution-level attention (blocked / handoff / takeover-idle): the
    // decision is to take control or leave the agent its durable authority.
    const review = h('button', 'ghost', 'Review');
    review.append(h('span', 'sub', 'evidence & controls'));
    review.addEventListener('click', () => openDetail(item.executionId));
    acts.append(review);
    if (item.category === 'blocked' || item.category === 'takeover-idle') {
      const take = h('button', item.category === 'blocked' ? 'primary' : '', item.category === 'blocked' ? 'Take over' : 'Return control');
      take.addEventListener('click', async () => {
        try {
          const ep = item.category === 'blocked' ? 'take-over' : 'continue';
          await api(`/api/executions/${encodeURIComponent(item.executionId)}/${ep}`, { actor: 'developer' });
          toast(item.category === 'blocked' ? 'You are in control.' : 'Control returned.');
          await refresh();
        } catch (err) { toast(`Failed: ${err.message}`); }
      });
      acts.append(take);
    }
    if (item.category === 'handoff') {
      const adopt = h('button', 'primary', 'Open handoff');
      adopt.addEventListener('click', () => openDetail(item.executionId));
      acts.append(adopt);
    }
    return acts;
  }
  const d = DEC.get(item.refIds[0]);
  const review = h('button', 'ghost', 'Review');
  review.append(h('span', 'sub', 'full context'));
  review.addEventListener('click', () => openDetail(item.executionId));
  acts.append(review);
  if (!d) {
    acts.append(h('span', 'amb', 'decision no longer pending'));
    return acts;
  }
  if (d.isQuestion || !d.options.some((o) => o.id === 'approve-once')) {
    for (const opt of d.options) {
      const b = h('button', opt.isRecommended ? 'primary' : '', opt.label);
      b.addEventListener('click', () => actOn(item, { outcome: 'custom', selectedOptionId: opt.id, customValue: opt.label }, el));
      acts.append(b);
    }
    const input = h('input', 'custom-in');
    input.placeholder = 'Answer…';
    const send = h('button', 'ghost', '↩');
    send.addEventListener('click', () => {
      if (!input.value.trim()) return;
      actOn(item, { outcome: 'custom', customValue: input.value.trim() }, el);
    });
    acts.append(input, send);
  } else {
    const reject = h('button', 'danger', 'Reject');
    reject.append(h('span', 'sub', 'let the agent find a way'));
    reject.addEventListener('click', () => actOn(item, { outcome: 'rejected' }, el));
    acts.append(reject);
    const approve = h('button', 'primary', 'Approve once');
    approve.append(h('span', 'sub', 'this action only'));
    approve.addEventListener('click', () => actOn(item, { outcome: 'accepted', selectedOptionId: 'approve-once' }, el));
    acts.append(approve);
  }
  return acts;
}

function itemShell(item, cls) {
  const el = h('div', `panel item ${cls} sec-${item.section}`);
  const head = h('div', 'i-head');
  const meta = h('div');
  meta.append(
    h('div', 'title', item.title),
    h('div', 'ex-goal', `${item.agentId} · ${item.goal.length > 58 ? `${item.goal.slice(0, 58)}…` : item.goal}`),
  );
  head.append(meta);
  if (item.label && item.section !== 'needs-you') head.append(h('span', `disp disp-${item.section}`, item.label));
  el.append(head);
  return el;
}

/* ── NEEDS YOU: the front row ─────────────────────────── */
function renderNeedsYou(items) {
  const list = $('#ny-list');
  list.textContent = '';
  const count = $('#ny-count');
  count.textContent = items.length ? String(items.length) : '';
  count.classList.toggle('hot', items.length > 0);
  if (items.length === 0) {
    list.append(h('div', 'empty calm-empty', 'Nothing needs your judgment. Go do your actual work.'));
    return;
  }
  const fresh = new Set(items.map((i) => i.id));
  for (const item of items) {
    const el = itemShell(item, 'ny');
    el.append(h('div', 'summary', item.summary));
    if (item.facts && item.facts.length) el.append(factChips(item));
    if (item.why) el.append(whyBlock(item.why));
    el.append(decisionActions(item, el));
    if (seenNy && !seenNy.has(item.id)) {
      el.classList.add('flash');
      el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true });
    }
    list.append(el);
    if (item.kind === 'decision') api(`/api/decisions/${encodeURIComponent(item.refIds[0])}/present`, {}).catch(() => {});
  }
  seenNy = fresh;
}

/* ── WAITING: durable queue, no pressure ──────────────── */
function renderOfferStrip() {
  const strip = $('#offer-strip');
  strip.textContent = '';
  if (!ATT) return;
  for (const s of ATT.suggestions) {
    if (dismissedOffers.has(s.category)) continue;
    const row = h('div', 'offer');
    row.append(h('span', null, `You approved ${s.category} actions ${s.accepted}×`));
    const btn = h('button', 'calm-btn', 'Delegate this category');
    btn.addEventListener('click', async () => {
      try {
        await api('/api/delegate', { scope: 'workspace', category: s.category, note: `accepted a recurrence offer (${s.accepted}× same-category approval)` });
        toast(`Delegated ${s.category} — the agents carry it until you revoke.`);
        await refresh();
      } catch (err) { toast(`Delegate failed: ${err.message}`); }
    });
    const later = h('button', 'ghost', 'Not now');
    later.addEventListener('click', () => { dismissedOffers.add(s.category); renderOfferStrip(); });
    row.append(btn, later);
    strip.append(row);
  }
}

function renderWaiting(items) {
  const list = $('#wt-list');
  list.textContent = '';
  if (items.length === 0) {
    list.append(h('div', 'empty', 'Nothing is waiting.'));
    return;
  }
  for (const item of items) {
    const el = itemShell(item, 'wt');
    const line = h('div', 'wt-line');
    line.append(h('span', 'sum', item.summary));
    line.append(h('span', 'amb', ` · ${fmtDur(Math.max(0, ATT.model.generatedAt - item.createdAt))} waiting`));
    el.append(line);
    if (item.facts && item.facts.length) el.append(factChips(item));
    if (item.whyWaiting) el.append(h('div', 'why-waiting', item.whyWaiting));
    el.append(decisionActions(item, el));
    list.append(el);
  }
}

/* ── WATCHING: batch clusters — click expands members ── */
function memberRows(item, rows) {
  const box = h('div', 'members');
  if (rows.length === 0) {
    box.append(h('div', 'amb', 'member rows are outside the recent window — open the run for the record'));
  }
  for (const r of rows) {
    const row = h('div', 'member');
    row.append(h('span', 'time', fmtClock(r.at)), h('span', null, r.text));
    box.append(row);
  }
  return box;
}

function renderWatching(items) {
  const list = $('#wc-list');
  list.textContent = '';
  if (items.length === 0) {
    list.append(h('div', 'empty', 'No clusters grouped.'));
    return;
  }
  for (const item of items) {
    const el = itemShell(item, 'wc');
    const head2 = h('div', 'wc-line');
    head2.append(h('span', 'sum', item.summary), h('span', 'count', `${item.clusterIds && item.clusterIds.length >= 1 ? item.clusterIds.length + 1 : (item.refIds || []).length} members`));
    el.append(head2);
    if (item.whyWaiting) el.append(h('div', 'why-waiting', item.whyWaiting));
    const body = h('div', 'wc-body collapsed');
    el.append(body);
    const acts = h('div', 'actions');
    const exp = h('button', 'ghost', 'Expand cluster');
    exp.addEventListener('click', async () => {
      if (!body.classList.contains('collapsed')) {
        body.classList.add('collapsed');
        openClusters.delete(item.id);
        return;
      }
      try {
        const d = await api(`/api/executions/${encodeURIComponent(item.executionId)}`);
        let rows = [];
        if (item.category === 'delegated-activity') {
          rows = d.autonomous.map((r) => ({ at: r.at, text: `${r.event}${r.whyNotInterrupted.delegatedBy ? ' · under delegation' : ''}` }));
        } else {
          rows = d.timeline
            .filter((t) => t.kind === 'test' && t.tone === 'bad')
            .map((t) => ({ at: t.at, text: t.text + (t.detail ? ` — ${t.detail}` : '') }));
        }
        body.textContent = '';
        body.append(memberRows(item, rows.slice(-12).reverse()));
        body.classList.remove('collapsed');
        openClusters.add(item.id);
      } catch (err) { toast(`Could not load members: ${err.message}`); }
    });
    const open = h('button', 'ghost', 'Open run');
    open.addEventListener('click', () => openDetail(item.executionId));
    acts.append(exp, open);
    el.append(acts);
    if (openClusters.has(item.id)) exp.click();
    list.append(el);
  }
}

/* ── WORKING: collapsed one-liner → compact cards ─────── */
function renderWorking() {
  const a = STATE.attention;
  const sum = $('#wk-summary');
  sum.textContent = '';
  if (a.working === 0) {
    sum.append(h('span', 'dim', 'No agents are progressing on their own right now.'));
    $('#wk-list').classList.add('collapsed');
    $('#wk-list').textContent = '';
    workingOpen = false;
    return;
  }
  sum.append(
    h('b', null, `${a.working} agent${a.working === 1 ? '' : 's'} progressing`),
    h('span', null, a.needsYou === 0 ? ' — nothing needs you' : ' — while the front row holds'),
    h('span', 'twisty', workingOpen ? ' ▾' : ' ▸'),
  );
  const list = $('#wk-list');
  if (!workingOpen) { list.classList.add('collapsed'); list.textContent = ''; return; }
  list.classList.remove('collapsed');
  list.textContent = '';
  const cards = STATE.executions.filter((c) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(c.status) && !c.needsYou);
  for (const c of cards) {
    const card = h('article', `panel card tone-${c.tone}`);
    const head = h('div', 'head');
    head.append(h('div', 'goal', c.goal));
    const st = h('div', 'st');
    st.append(h('span', `dot ${c.tone}`), h('span', null, c.statusLabel));
    head.append(st);
    card.append(head);
    card.append(h('div', 'activity', c.lastActivity));
    const meta = h('div', 'meta');
    meta.append(h('span', null, `${c.agent} · ${c.phase}`), h('span', null, `${c.filesChanged} files`), h('span', null, fmtDur(c.metrics.totalMs)));
    card.append(meta);
    card.addEventListener('click', () => openDetail(c.executionId));
    list.append(card);
  }
}
$('#wk-summary').addEventListener('click', () => { workingOpen = !workingOpen; renderWorking(); });

/* ── RECORDED: delegated/low items, collapsed ─────────── */
function renderLogged(items) {
  const sum = $('#lg-summary');
  sum.textContent = '';
  const list = $('#lg-list');
  if (items.length === 0) {
    list.classList.add('collapsed');
    list.textContent = '';
    sum.style.display = 'none';
    return;
  }
  sum.style.display = '';
  sum.append(
    h('span', 'dim', `${items.length} recorded without claiming your time`),
    h('span', 'twisty', loggedOpen ? ' ▾' : ' ▸'),
  );
  if (!loggedOpen) { list.classList.add('collapsed'); list.textContent = ''; return; }
  list.classList.remove('collapsed');
  list.textContent = '';
  for (const item of items) {
    const el = h('div', 'lg-row');
    el.append(h('span', 'time', fmtClock(item.createdAt)), h('span', null, item.summary));
    const open = h('button', 'ghost mini', 'run');
    open.addEventListener('click', () => openDetail(item.executionId));
    el.append(open);
    list.append(el);
  }
}
$('#lg-summary').addEventListener('click', () => { loggedOpen = !loggedOpen; if (ATT) renderLogged(bySection('recorded')); });

function bySection(s) {
  return ATT && ATT.model ? ATT.model.items.filter((i) => i.section === s) : [];
}

/* ── delegations popover ──────────────────────────────── */
async function renderDelegPopover() {
  const pop = $('#deleg-pop');
  pop.textContent = '';
  let rows = [];
  try {
    rows = (await api('/api/delegations')).delegations;
  } catch { rows = ATT ? ATT.delegations : []; }
  if (rows.length === 0) {
    pop.append(h('div', 'amb', 'No standing delegations. Everything consequential comes to you.'));
    return;
  }
  pop.append(h('div', 'pop-title', 'Active delegations'));
  for (const d of rows) {
    const row = h('div', 'pop-row');
    const scope = d.scope === 'workspace' ? 'all runs' : `run ${String(d.executionId || '').replace(/^exec-/, '').slice(0, 8)}`;
    const exp = d.expiresAt ? `expires ${fmtClock(d.expiresAt)}` : 'until revoked';
    row.append(
      h('span', 'chip', d.category),
      h('span', null, `${scope} · by ${d.grantedBy} · ${exp}`),
    );
    const rev = h('button', 'danger mini', 'Revoke');
    rev.addEventListener('click', async () => {
      try {
        await api(`/api/delegations/${encodeURIComponent(d.id)}/revoke`, { by: 'developer' });
        toast('Revoked — the next such action comes back to you.');
        await refresh();
        renderDelegPopover();
      } catch (err) { toast(`Revoke failed: ${err.message}`); }
    });
    row.append(rev);
    pop.append(row);
  }
}
$('#btn-deleg').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#deleg-pop');
  pop.hidden = !pop.hidden;
  pop.style.top = '54px';
  if (!pop.hidden) renderDelegPopover();
});
document.addEventListener('click', (e) => {
  const pop = $('#deleg-pop');
  if (!pop.hidden && !pop.contains(e.target) && e.target.id !== 'btn-deleg') pop.hidden = true;
});

/* ── detail overlay: evidence under the attention ─────── */
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

    if (d.delegations && d.delegations.length) {
      const wrap = h('div', 'dl-strip');
      wrap.append(h('span', null, 'Covered by: '));
      for (const dl of d.delegations) wrap.append(h('span', 'chip calm-chip', `${dl.category} (${dl.scope === 'workspace' ? 'all runs' : 'this run'})`));
      box.append(wrap);
    }

    if (d.away) {
      box.append(h('h4', null, 'While you were away'));
      box.append(h('div', 'away-box', d.away.rendered));
    }

    if (d.autonomous && d.autonomous.length) {
      const det = h('details', 'aut');
      det.append(h('summary', null, `Allowed autonomously (${d.autonomous.length}) — what ran without interrupting you`));
      for (const r of d.autonomous) {
        const row = h('div', 'aut-row');
        const head = h('div', 'aut-head');
        head.append(h('span', 'time', fmtClock(r.at)), h('span', 'mono', r.event));
        if (r.whyNotInterrupted.delegatedBy) {
          head.append(h('span', 'badge', `delegated · ${r.whyNotInterrupted.delegatedBy.category} by ${r.whyNotInterrupted.delegatedBy.grantedBy}`));
        }
        row.append(head);
        const why = h('div', 'aut-why');
        why.append(h('span', 'k', 'Why not interrupted:'));
        const ul = h('ul');
        for (const reason of r.whyNotInterrupted.allowedBecause) ul.append(h('li', null, reason));
        why.append(ul);
        why.append(h('span', 'amb', `attention saved: ${r.whyNotInterrupted.attentionSaved}`));
        row.append(why);
        det.append(row);
      }
      box.append(det);
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
      li.append(h('span', null, t.text + (t.count > 1 ? `  ×${t.count}` : '')));
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
    if (a.needsYou > 0) toast(`Welcome back — ${a.needsYou} item(s) need your judgment.`);
    else if (a.working > 0) toast('Welcome back — nothing needed you; agents kept working.');
    else if (STATE.executions.length > 0) toast('Welcome back — all runs finished while you were away.');
    else toast('Welcome back.');
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
    const [state, att] = await Promise.all([api('/api/state'), api('/api/attention')]);
    STATE = state;
    ATT = att;
    DEC = new Map((STATE.queue || []).map((d) => [d.id, d]));
    renderL1();
    renderNeedsYou(bySection('needs-you'));
    renderOfferStrip();
    renderWaiting(bySection('waiting'));
    renderWatching(bySection('watching'));
    renderWorking();
    renderLogged(bySection('recorded'));
  } catch (err) {
    $('#attention-line').textContent = `control plane unreachable: ${err.message}`;
  }
}

$('#btn-refresh').addEventListener('click', (e) => { e.stopPropagation(); refresh(); });
$('#btn-away').addEventListener('click', (e) => { e.stopPropagation(); goAway(); });
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') { $('#overlay').hidden = true; detailExec = null; } });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#overlay').hidden = true; detailExec = null; $('#deleg-pop').hidden = true; }
});

/* live propagation: SSE tickle → refetch (throttled). No charts, no timers
 * of their own — the stream says rows changed, we re-read the map. */
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
