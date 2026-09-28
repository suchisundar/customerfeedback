/* FlowPilot Triage UI. Plain DOM, no framework. */
(function () {
  'use strict';

  const A = window.FlowPilotAnalysis;
  const R = window.FlowPilotReviews;
  const { parseCsv } = window.FlowPilotCsv;
  const SAMPLES = window.FLOWPILOT_SAMPLES || {};

  const $ = sel => document.querySelector(sel);
  const PREFS_KEY = 'flowpilot.prefs.v1';
  const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
  const TIER_LABEL = Object.fromEntries(A.PRIORITY_TIERS.map(t => [t.id, t.label]));

  const store = R.createStore();

  // ------------------------------------------------------------ state

  const prefs = loadPrefs();
  const state = {
    datasetId: SAMPLES[prefs.datasetId] ? prefs.datasetId : 'dataset',
    uploads: {},             // id -> { label, csv }
    rows: [],
    weights: { ...A.DEFAULT_WEIGHTS, ...(prefs.weights || {}) },
    filters: {},
    sort: prefs.sort || 'score',
    tab: prefs.tab || 'priorities',
    editing: null,            // issue key with the review form open
    evIssue: '',
    evSearch: '',
    result: null,
    issues: [],
  };

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        datasetId: state.datasetId.startsWith('upload:') ? 'dataset' : state.datasetId,
        weights: state.weights, sort: state.sort, tab: state.tab, reviewer: reviewerName(),
      }));
    } catch (e) { /* storage unavailable */ }
  }
  const reviewerName = () => $('#reviewer-name').value.trim();

  // ------------------------------------------------------------ helpers

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => {
    if (n === null || n === undefined) return '—';
    if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`;
    if (n >= 1000) return `$${Math.round(n / 1000)}k`;
    return `$${n}`;
  };
  const fmtDate = iso => {
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const prioChip = (p, withLabel) => `<span class="prio ${esc(p)}">${esc(p)}${withLabel ? ` <small>${esc(TIER_LABEL[p] || '')}</small>` : ''}</span>`;

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  function copyText(text, label) {
    const done = () => toast(`${label} copied to clipboard`);
    const fallback = () => {
      const ta = $('#copy-fallback');
      ta.value = text; ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (ok) done(); else toast('Copy is blocked here. The text is selected; press Ctrl+C or Cmd+C.');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  function issueName(key) {
    if (key === 'praise') return 'Praise (not an issue)';
    const i = state.issues.find(x => x.key === key);
    if (i) return i.effective.name;
    const t = A.THEMES.find(x => x.key === key);
    if (t) return t.name;
    return key === 'other' ? 'Uncategorized feedback' : key.replace(/^area:/, '');
  }

  // ------------------------------------------------------------ data loading

  function currentCsv() {
    if (state.datasetId.startsWith('upload:')) return state.uploads[state.datasetId].csv;
    return SAMPLES[state.datasetId] ? SAMPLES[state.datasetId].csv : '';
  }

  function loadDataset() {
    state.rows = A.normalizeRecords(parseCsv(currentCsv()).records);
    state.filters = {};
    buildDatasetSelect();
    buildFilters();
    render();
  }

  function buildDatasetSelect() {
    const sel = $('#dataset-select');
    const opts = Object.entries(SAMPLES).map(([id, s]) => [id, s.label])
      .concat(Object.entries(state.uploads).map(([id, u]) => [id, u.label]));
    sel.innerHTML = opts.map(([id, label]) => `<option value="${esc(id)}"${id === state.datasetId ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const f = A.detectFields(state.rows);
    const missing = ['rating', 'acv', 'segment', 'canceled'].filter(k => !f[k]);
    $('#dataset-hint').textContent = missing.length
      ? `${state.rows.length} items. No ${missing.join(', ')} columns, so the score relies on wording, breadth and recency.`
      : `${state.rows.length} items with ratings, segments, contract values and churn signals.`;
  }

  function buildFilters() {
    const set = (id, field, label) => {
      const values = [...new Set(state.rows.map(r => r[field]).filter(Boolean))].sort();
      const el = $(id);
      el.innerHTML = `<option value="">All ${label}</option>` + values.map(v => `<option>${esc(v)}</option>`).join('');
      el.disabled = !values.length;
      el.closest('.field').title = values.length ? '' : 'Not in this dataset';
    };
    set('#f-segment', 'segment', 'segments');
    set('#f-plan', 'plan', 'plans');
    set('#f-source', 'source', 'sources');
    const dates = state.rows.map(r => r.date).filter(Boolean).sort();
    ['#f-from', '#f-to'].forEach(id => {
      const el = $(id);
      el.value = '';
      el.min = dates[0] || ''; el.max = dates[dates.length - 1] || '';
    });
  }

  function buildWeights() {
    $('#weights').innerHTML = A.COMPONENTS.map((c, i) => `
      <div class="weight" data-key="${c.key}" title="${esc(c.help)}">
        <span class="swatch" style="background:${SERIES[i]}"></span>
        <label for="w-${c.key}">${esc(c.label)}</label>
        <span class="val" id="wv-${c.key}">${state.weights[c.key]}</span>
        <input type="range" id="w-${c.key}" min="0" max="50" step="5" value="${state.weights[c.key]}" aria-describedby="wv-${c.key}">
      </div>`).join('');
  }

  // ------------------------------------------------------------ render

  function render() {
    state.result = A.analyze(state.rows, {
      weights: state.weights,
      filters: state.filters,
      itemCorrections: store.activeCorrections(),
    });
    state.issues = R.applyDecisions(state.result.issues, store.latestByIssue());

    document.querySelectorAll('.weight').forEach(el => {
      el.classList.toggle('off', !state.result.available[el.dataset.key]);
    });

    renderSummary();
    renderSlope();
    renderLegend();
    renderIssues();
    renderPraise();
    renderEvidence();
    renderChecks();
    renderHistory();
  }

  function renderSummary() {
    const res = state.result;
    const issues = state.issues;
    const top = issues[0];
    const urgent = issues.filter(i => ['P0', 'P1'].includes(i.effective.priority));
    const reviewed = issues.filter(i => i.review).length;
    const complaints = issues.reduce((s, i) => s + i.count, 0);
    const exposed = res.fields.acv ? urgent.reduce((s, i) => s + i.arrAtRisk, 0) : null;

    let headline = 'No feedback matches the current filters.';
    if (top) {
      const why = top.reasons[0] || `${top.count} feedback items`;
      headline = `Top priority: <em>${esc(top.effective.name)}</em>. ${esc(why)}.`;
    }

    const notices = [];
    if (!res.fields.rating || !res.fields.acv) {
      notices.push(`<div class="notice"><span><strong>Comment text only.</strong> Without ratings, segments, contract values or cancellations, severity is estimated from wording and the ranking leans on volume. Switch to the full dataset to see how business impact reorders the list.</span></div>`);
    }
    const stale = issues.filter(i => i.stale);
    if (stale.length) {
      notices.push(`<div class="notice"><span><strong>${stale.length} reviewed issue${stale.length === 1 ? '' : 's'} changed tier since review.</strong> The human decision still applies, but the system now recommends something different. Look for the yellow flag below.</span></div>`);
    }

    $('#summary').innerHTML = `
      <h1 class="headline">${headline}</h1>
      <div class="stats">
        <div class="stat"><span class="stat-value">${res.rows.length}</span><span class="stat-label">feedback items${res.rows.length !== res.totalRows ? ` of ${res.totalRows}` : ''}</span></div>
        <div class="stat"><span class="stat-value">${complaints}</span><span class="stat-label">complaints in ${issues.length} issues</span></div>
        <div class="stat"><span class="stat-value">${urgent.length}</span><span class="stat-label">at P0 or P1</span></div>
        ${exposed !== null ? `<div class="stat"><span class="stat-value">${money(exposed)}</span><span class="stat-label">contract value behind P0–P1</span></div>` : ''}
        <div class="stat"><span class="stat-value">${reviewed}/${issues.length}</span><span class="stat-label">issues human-reviewed</span></div>
      </div>
      ${notices.join('')}`;
  }

  function renderSlope() {
    const issues = state.issues;
    const card = $('#rank-compare-card');
    card.hidden = issues.length < 2;
    if (issues.length < 2) return;
    const rowH = 30, top = 34, W = 760, H = top + issues.length * rowH + 6;
    const xL = 300, xR = 460;
    const y = r => top + (r - 1) * rowH + rowH / 2;
    const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const rows = issues.map(i => {
      const dir = i.rank < i.frequencyRank ? 'up' : i.rank > i.frequencyRank ? 'down' : '';
      const color = dir === 'up' ? 'var(--accent)' : dir === 'down' ? 'var(--p1)' : 'var(--line-strong)';
      return `<g class="row"><title>${esc(i.name)}: #${i.frequencyRank} by frequency (${i.count} items), #${i.rank} by impact (score ${i.score.toFixed(0)})</title>
        <line class="line ${dir}" x1="${xL}" y1="${y(i.frequencyRank)}" x2="${xR}" y2="${y(i.rank)}"></line>
        <circle class="dot" cx="${xL}" cy="${y(i.frequencyRank)}" r="5" fill="${color}"></circle>
        <circle class="dot" cx="${xR}" cy="${y(i.rank)}" r="5" fill="${color}"></circle>
        <text x="${xL - 14}" y="${y(i.frequencyRank) + 4}" text-anchor="end">${esc(trunc(i.name, 34))} <tspan class="rank">${i.count}</tspan></text>
        <text x="${xR + 14}" y="${y(i.rank) + 4}"><tspan class="rank">${i.score.toFixed(0)}</tspan> ${esc(trunc(i.name, 34))}</text>
      </g>`;
    }).join('');
    $('#slope').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Issue rank by frequency compared with rank by impact score">
      <text class="col-title" x="${xL}" y="16" text-anchor="end">By frequency · items</text>
      <text class="col-title" x="${xR}" y="16">By impact · score</text>
      ${rows}</svg>`;
  }

  function renderLegend() {
    $('#score-legend').innerHTML = '<span style="color:var(--muted)">Score built from:</span>' + A.COMPONENTS.map((c, i) =>
      `<span title="${esc(c.help)}"><i class="swatch" style="background:${SERIES[i]}"></i>${esc(c.label)}</span>`).join('');
  }

  function sortedIssues() {
    const list = state.issues.slice();
    if (state.sort === 'decision') list.sort((a, b) => a.effective.priority.localeCompare(b.effective.priority) || b.score - a.score);
    if (state.sort === 'frequency') list.sort((a, b) => a.frequencyRank - b.frequencyRank);
    return list;
  }

  function scoreBar(issue) {
    const segs = A.COMPONENTS.map((c, i) => {
      const pts = issue.points[c.key];
      if (pts <= 0.05) return '';
      return `<span style="width:${pts}%;background:${SERIES[i]}" title="${esc(c.label)}: ${pts.toFixed(1)} pts (${Math.round(issue.components[c.key] * 100)}% of max)"></span>`;
    }).join('');
    const parts = A.COMPONENTS.map(c => `${c.label} ${issue.points[c.key].toFixed(1)}`).join(', ');
    return `<div class="bar" role="img" aria-label="Score breakdown: ${esc(parts)}">${segs}</div>
      <div class="bar-scale" aria-hidden="true"><span>0</span><span>50</span><span>100</span></div>`;
  }

  function evidenceTable(rows) {
    const f = state.result.fields;
    return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>ID</th><th>Date</th><th>Account</th>${f.segment ? '<th>Segment</th>' : ''}${f.rating ? '<th>Rating</th>' : ''}${f.acv ? '<th>ACV</th>' : ''}${f.churnRisk ? '<th>Churn risk</th>' : ''}<th>Feedback</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="id">${esc(r.id)}</td><td class="num">${esc(r.date)}</td><td class="id">${esc(r.account)}</td>
        ${f.segment ? `<td>${esc(r.segment)}</td>` : ''}
        ${f.rating ? `<td class="num">${r.rating ?? '—'}</td>` : ''}
        ${f.acv ? `<td class="num">${money(r.acv)}</td>` : ''}
        ${f.churnRisk ? `<td>${esc(r.churnRisk)}${r.canceled ? ' · canceled' : ''}</td>` : ''}
        <td class="text">${esc(r.text)}${r.method === 'reviewer' ? '<span class="method-tag reviewer">Moved here by reviewer</span>' : ''}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  function renderIssues() {
    const f = state.result.fields;
    const categories = [...new Set([...A.THEMES.map(t => t.area), ...state.rows.map(r => r.area).filter(Boolean), 'Other'])].sort();
    const list = sortedIssues();

    $('#issues').innerHTML = list.length ? list.map(issue => {
      const e = issue.effective;
      const renamed = issue.review && e.name !== issue.name;
      const facts = [
        `<span class="fact"><b>${issue.count}</b> items</span>`,
        `<span class="fact"><b>${issue.accounts}</b> accounts</span>`,
        f.acv ? `<span class="fact"><b>${money(issue.arrAtRisk)}</b> ACV</span>` : '',
        issue.canceledAccounts ? `<span class="fact flag"><b>${issue.canceledAccounts}</b> canceled</span>` : '',
        f.escalated ? `<span class="fact"><b>${issue.escalations}</b> escalated</span>` : '',
        issue.avgRating !== null ? `<span class="fact"><b>${issue.avgRating.toFixed(1)}</b> avg rating</span>` : '',
        issue.regression ? `<span class="fact flag">Release <b>${esc(issue.topRelease)}</b> regression</span>` : '',
        `<span class="fact">#<b>${issue.frequencyRank}</b> by frequency</span>`,
      ].join('');

      return `<li class="issue${issue.review ? ' is-reviewed' : ''}" id="issue-${esc(issue.key)}">
        <div class="sys">
          <div class="sys-head">
            <div class="rank-no" aria-label="Rank">${issue.rank}</div>
            <div>
              <span class="origin system">System analysis</span>
              <h3 class="issue-name">${renamed ? `<s>${esc(issue.name)}</s>` : esc(issue.name)}</h3>
              <div class="issue-meta"><span>${esc(issue.category)}</span>${issue.firstDate ? `<span>${esc(issue.firstDate)} → ${esc(issue.lastDate)}</span>` : ''}<span>Recommends ${prioChip(issue.priority, true)}</span></div>
            </div>
            <div class="score-box"><div class="score-num">${issue.score.toFixed(0)}</div><div class="score-label">impact score</div></div>
          </div>
          ${scoreBar(issue)}
          <div class="facts">${facts}</div>
          <div class="two-col">
            <div>
              <div class="mini-title">Why it ranks here</div>
              <ul class="reasons">${issue.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
              <div class="mini-title" style="margin-top:10px">Suggested next step</div>
              <p class="next-step">${esc(issue.nextStep)}</p>
              <p class="conf" style="margin-top:8px">Confidence: <b>${esc(issue.confidence.level)}</b>${issue.confidence.notes.length ? ` · ${esc(issue.confidence.notes.join(' '))}` : ''}</p>
            </div>
            <div>
              <div class="mini-title">Evidence</div>
              <ul class="quotes">${issue.evidence.map(r => `<li class="quote"><p>“${esc(r.text)}”</p>
                <span class="src">${esc(r.id)} · ${esc(r.account)}${r.segment ? ` · ${esc(r.segment)}` : ''}${r.rating !== null ? ` · ${r.rating}★` : ''}${r.acv ? ` · ${money(r.acv)}` : ''}${r.canceled ? ' · canceled' : ''}</span></li>`).join('')}</ul>
            </div>
          </div>
          <details class="all-evidence"><summary>All ${issue.count} feedback items</summary>${evidenceTable(issue.rows)}</details>
        </div>
        ${renderHuman(issue, categories)}
      </li>`;
    }).join('') : '<li class="notice">No complaints match the current filters.</li>';
  }

  function renderHuman(issue, categories) {
    const r = issue.review;
    const e = issue.effective;
    let head;
    if (!r) {
      head = `<div class="human-state"><span class="origin system">Not reviewed</span><span>The system recommendation stands until a reviewer approves or changes it.</span></div>`;
    } else {
      const changed = r.changes.length
        ? r.changes.map(f => f === 'priority' ? `priority ${prioChip(r.system.priority)} <span class="arrow">→</span> ${prioChip(r.final.priority)}` : f === 'name' ? 'renamed' : `category → <b>${esc(r.final.category)}</b>`).join(', ')
        : `approved ${prioChip(r.final.priority, true)}`;
      head = `<div class="human-state"><span class="origin human">Human decision</span>
        <span><b>${esc(r.reviewer)}</b> ${changed} · ${esc(fmtDate(r.at))}</span></div>`;
    }
    const nameLine = r && r.changes.includes('name') ? `<p class="issue-name">${esc(e.name)}</p>` : '';
    const note = r && r.note ? `<p class="human-note">${esc(r.note)}</p>` : '';
    const stale = issue.stale ? `<p class="stale">Since this review the system's recommendation moved from ${esc(r.system.priority)} to ${esc(issue.priority)}. Re-review to confirm.</p>` : '';

    const form = state.editing === issue.key ? `
      <form class="review-form" data-form="${esc(issue.key)}" novalidate>
        <label class="field" for="rf-prio-${esc(issue.key)}"><span>Priority</span>
          <select id="rf-prio-${esc(issue.key)}" name="priority">${A.PRIORITY_TIERS.map(t => `<option value="${t.id}"${t.id === e.priority ? ' selected' : ''}>${t.id} · ${t.label}${t.id === issue.priority ? ' (system)' : ''}</option>`).join('')}</select>
        </label>
        <label class="field" for="rf-cat-${esc(issue.key)}"><span>Category</span>
          <input id="rf-cat-${esc(issue.key)}" name="category" list="cat-${esc(issue.key)}" value="${esc(e.category)}">
          <datalist id="cat-${esc(issue.key)}">${categories.map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>
        </label>
        <label class="field wide" for="rf-name-${esc(issue.key)}"><span>Issue name</span>
          <input id="rf-name-${esc(issue.key)}" name="name" value="${esc(e.name)}">
        </label>
        <label class="field wide" for="rf-note-${esc(issue.key)}"><span>Reviewer note (required when you change something)</span>
          <textarea id="rf-note-${esc(issue.key)}" name="note" placeholder="Why this decision? This note is shown in the history and reused as context."></textarea>
        </label>
        <p class="form-error wide" data-error hidden></p>
        <div class="actions wide">
          <button class="btn primary" type="submit">Save decision</button>
          <button class="btn" type="button" data-action="cancel">Cancel</button>
        </div>
      </form>` : `
      <div class="actions">
        <button class="btn approve" type="button" data-action="approve" data-key="${esc(issue.key)}">${!r ? `Approve ${esc(issue.priority)}` : r.decision === 'changed' ? `Revert to system ${esc(issue.priority)}` : `Re-approve ${esc(issue.priority)}`}</button>
        <button class="btn" type="button" data-action="edit" data-key="${esc(issue.key)}">Change priority, name or category</button>
      </div>`;

    return `<div class="human${r ? '' : ' unreviewed'}">
      <div class="human-head">${head}</div>${nameLine}${note}${stale}${form}</div>`;
  }

  function renderPraise() {
    const p = state.result.praise;
    const el = $('#praise');
    el.hidden = !p.count;
    if (!p.count) return;
    const quotes = [...p.rows].sort((a, b) => (b.acv || 0) - (a.acv || 0)).slice(0, 6);
    el.innerHTML = `
      <div>
        <h2 class="section-title">What customers value</h2>
        <p class="section-sub">${p.count} positive items, kept out of the ranking. Protect these when changing the product${p.renewed ? `; ${p.renewed} tie directly to a renewal` : ''}.
        ${p.themes.map(t => `${esc(t.value)} ${t.count}`).join(' · ')}</p>
      </div>
      <ul class="quotes praise-grid">${quotes.map(r => `<li class="quote"><p>“${esc(r.text)}”</p><span class="src">${esc(r.id)} · ${esc(r.account)}${r.area ? ` · ${esc(r.area)}` : ''}</span></li>`).join('')}</ul>`;
  }

  function renderEvidence() {
    const res = state.result;
    const keys = [...state.issues.map(i => i.key), 'praise'];
    const sel = $('#ev-issue');
    sel.innerHTML = `<option value="">All issues</option>` + keys.map(k => `<option value="${esc(k)}"${k === state.evIssue ? ' selected' : ''}>${esc(issueName(k))}</option>`).join('');
    const q = state.evSearch.toLowerCase();
    const rows = res.rows.filter(r => (!state.evIssue || r.issueKey === state.evIssue) &&
      (!q || `${r.id} ${r.account} ${r.text}`.toLowerCase().includes(q)));
    const f = res.fields;
    const methodLabel = { product_area: 'from product area', keywords: 'from keywords', sentiment: 'positive rating & wording', reviewer: 'moved by reviewer', unmatched: 'no match' };
    const options = keys.map(k => [k, issueName(k)]);
    $('#evidence-table').innerHTML = `
      <thead><tr><th>ID</th><th>Date</th><th>Account</th>${f.segment ? '<th>Segment</th><th>Plan</th>' : ''}${f.rating ? '<th>Rating</th>' : ''}${f.acv ? '<th>ACV</th>' : ''}${f.area ? '<th>Product area</th>' : ''}<th>Feedback</th><th>Assigned issue</th></tr></thead>
      <tbody>${rows.length ? rows.map(r => `<tr>
        <td class="id">${esc(r.id)}</td><td class="num">${esc(r.date)}</td><td class="id">${esc(r.account)}</td>
        ${f.segment ? `<td>${esc(r.segment)}</td><td>${esc(r.plan)}</td>` : ''}
        ${f.rating ? `<td class="num">${r.rating ?? '—'}</td>` : ''}
        ${f.acv ? `<td class="num">${money(r.acv)}</td>` : ''}
        ${f.area ? `<td>${esc(r.area)}</td>` : ''}
        <td class="text">${esc(r.text)}</td>
        <td><select aria-label="Issue for ${esc(r.id)}" data-row="${esc(r.id)}">${options.map(([k, n]) => `<option value="${esc(k)}"${k === r.issueKey ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <span class="method-tag${r.method === 'reviewer' ? ' reviewer' : ''}">${esc(methodLabel[r.method] || r.method)}</span></td>
      </tr>`).join('') : `<tr><td class="empty" colspan="12">No feedback matches.</td></tr>`}</tbody>`;
  }

  function reviewChecks() {
    const issues = state.issues;
    const urgent = issues.filter(i => ['P0', 'P1'].includes(i.priority));
    const unreviewedUrgent = urgent.filter(i => !i.review);
    const stale = issues.filter(i => i.stale);
    const overrides = issues.filter(i => i.review && i.review.decision === 'changed');
    const moved = store.activeCorrections().length;
    return [
      { group: 'Review', id: 'urgent-reviewed', title: 'Every P0 and P1 recommendation has a human decision',
        status: unreviewedUrgent.length ? 'fail' : 'pass',
        detail: unreviewedUrgent.length ? `${unreviewedUrgent.length} of ${urgent.length} urgent issues are still system-only.` : `All ${urgent.length} urgent issues reviewed.`,
        items: unreviewedUrgent.map(i => `${i.priority}: ${i.name}`) },
      { group: 'Review', id: 'stale', title: 'Reviews still match the current recommendation',
        status: stale.length ? 'warn' : 'pass',
        detail: stale.length ? `${stale.length} decision(s) were made when the system recommended a different tier.` : 'No reviewed issue has changed tier.',
        items: stale.map(i => `${i.name}: reviewed at ${i.review.system.priority}, now ${i.priority}`) },
      { group: 'Review', id: 'overrides', title: 'Human overrides and corrections',
        status: 'info',
        detail: `${overrides.length} issue decision(s) differ from the system; ${moved} feedback item wording(s) re-categorized. High override rates point at scoring rules worth revisiting.`,
        items: overrides.map(i => `${i.name}: ${i.review.changes.join(', ')} changed. ${i.review.note}`) },
    ];
  }

  function renderChecks() {
    const all = [...state.result.checks, ...reviewChecks()];
    const groups = ['Output', 'Input', 'Review'];
    const titles = { Output: 'Output checks', Input: 'Input data checks', Review: 'Human review checks' };
    $('#checks').innerHTML = groups.map(g => {
      const cs = all.filter(c => c.group === g);
      if (!cs.length) return '';
      return `<div class="check-group"><h3 class="subsection-title">${titles[g]}</h3>${cs.map(c => `
        <div class="check">
          <span class="check-status ${c.status}">${c.status}</span>
          <div>
            <div class="check-title">${esc(c.title)}</div>
            <p class="check-detail">${esc(c.detail)}</p>
            ${c.items.length ? `<details><summary>${c.items.length} item${c.items.length === 1 ? '' : 's'}</summary><ul>${c.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>` : ''}
          </div>
        </div>`).join('')}</div>`;
    }).join('');
    const problems = all.filter(c => c.status === 'fail' || c.status === 'warn').length;
    const badge = $('#checks-count');
    badge.textContent = problems || '';
    badge.classList.toggle('alert', all.some(c => c.status === 'fail'));
  }

  function renderHistory() {
    const reviews = store.reviews().slice().reverse();
    $('#history-count').textContent = reviews.length || '';
    const mark = (r, f, v) => (r.changes.includes(f) ? `<span class="chg">${v}</span>` : v);
    $('#history-table').innerHTML = `
      <thead><tr><th>When</th><th>Reviewer</th><th>System recommended</th><th>Human decision</th><th>Why</th></tr></thead>
      <tbody>${reviews.length ? reviews.map(r => `<tr>
        <td class="num">${esc(fmtDate(r.at))}</td>
        <td>${esc(r.reviewer)}</td>
        <td><span class="origin system">System</span><div>${prioChip(r.system.priority)} ${esc(r.system.name)}</div>
          <div class="hint">${esc(r.system.category)} · score ${r.system.score} · rank ${r.system.rank}</div></td>
        <td><span class="origin human">${r.decision === 'approved' ? 'Approved' : 'Changed'}</span>
          <div>${mark(r, 'priority', prioChip(r.final.priority))} ${mark(r, 'name', esc(r.final.name))}</div>
          <div class="hint">${mark(r, 'category', esc(r.final.category))}</div></td>
        <td class="text">${r.note ? esc(r.note) : '<span class="hint">No note</span>'}</td>
      </tr>`).join('') : '<tr><td class="empty" colspan="5">No reviews yet. Approve or change an issue on the Priorities tab to start the history.</td></tr>'}</tbody>`;

    const corr = store.corrections().slice().reverse();
    $('#corrections-table').innerHTML = `
      <thead><tr><th>When</th><th>Reviewer</th><th>Feedback</th><th>System issue</th><th>Moved to</th><th>Status</th></tr></thead>
      <tbody>${corr.length ? corr.map(c => `<tr>
        <td class="num">${esc(fmtDate(c.at))}</td><td>${esc(c.reviewer)}</td>
        <td class="text"><span class="id mono">${esc(c.feedbackId)}</span> ${esc(c.text)}</td>
        <td>${esc(issueName(c.fromIssueKey))}</td><td>${esc(issueName(c.toIssueKey))}</td>
        <td>${c.active ? `Applied <button class="link-btn" type="button" data-revoke="${esc(c.id)}">Undo</button>` : '<span class="hint">Replaced or undone</span>'}</td>
      </tr>`).join('') : '<tr><td class="empty" colspan="6">No items moved yet. Use the Evidence tab to reassign a feedback item.</td></tr>'}</tbody>`;

    $('#context-text').textContent = R.reviewerContext(store.reviews(), store.corrections(), issueName);
  }

  // ------------------------------------------------------------ method tab

  function renderMethod() {
    $('#method-components').innerHTML = A.COMPONENTS.map((c, i) =>
      `<dt><i class="swatch" style="background:${SERIES[i]}"></i>${esc(c.label)} · ${c.weight}</dt><dd>${esc(c.help)}</dd>`).join('');
    $('#method-tiers').innerHTML = A.PRIORITY_TIERS.map((t, i, arr) =>
      `<li>${prioChip(t.id, true)} score ${i === 0 ? `${t.min} or more` : `${t.min} to ${arr[i - 1].min - 1}`}</li>`).join('');
  }

  // ------------------------------------------------------------ events

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('[role="tab"]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('[role="tabpanel"]').forEach(p => { p.hidden = p.id !== `panel-${tab}`; });
    savePrefs();
  }

  function bind() {
    document.querySelector('.tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (b) { setTab(b.dataset.tab); try { history.replaceState(null, '', '#' + b.dataset.tab); } catch (err) { /* sandboxed */ } }
    });

    $('#reviewer-name').value = prefs.reviewer || '';
    $('#reviewer-name').addEventListener('change', savePrefs);

    $('#dataset-select').addEventListener('change', e => { state.datasetId = e.target.value; savePrefs(); loadDataset(); });

    $('#csv-upload').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = parseCsv(reader.result);
        if (!parsed.headers.includes('feedback_text')) {
          toast(`"${file.name}" has no feedback_text column. Add one (plus optional feedback_id, account_id, date, rating…) and upload again.`);
          return;
        }
        const id = 'upload:' + file.name;
        state.uploads[id] = { label: `Uploaded: ${file.name}`, csv: reader.result };
        state.datasetId = id;
        loadDataset();
        toast(`Loaded ${state.rows.length} items from ${file.name}`);
      };
      reader.onerror = () => toast(`Could not read ${file.name}. Check that it is a plain-text CSV file.`);
      reader.readAsText(file);
      e.target.value = '';
    });

    const filterMap = { '#f-segment': 'segment', '#f-plan': 'plan', '#f-source': 'source', '#f-from': 'from', '#f-to': 'to' };
    Object.entries(filterMap).forEach(([sel, key]) => {
      $(sel).addEventListener('change', e => { state.filters[key] = e.target.value; render(); });
    });

    $('#weights').addEventListener('input', e => {
      const w = e.target.closest('.weight');
      if (!w) return;
      state.weights[w.dataset.key] = Number(e.target.value);
      $(`#wv-${w.dataset.key}`).textContent = e.target.value;
      render(); savePrefs();
    });
    $('#reset-weights').addEventListener('click', () => {
      state.weights = { ...A.DEFAULT_WEIGHTS };
      buildWeights(); render(); savePrefs();
    });

    $('#sort-mode').value = state.sort;
    $('#sort-mode').addEventListener('change', e => { state.sort = e.target.value; renderIssues(); savePrefs(); });

    $('#issues').addEventListener('click', e => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const key = b.dataset.key;
      if (b.dataset.action === 'approve') {
        const issue = state.issues.find(i => i.key === key);
        store.addReview(issue, { reviewer: reviewerName(), datasetId: state.datasetId, final: { name: issue.name, category: issue.category, priority: issue.priority } });
        render();
        toast(`Approved ${issue.priority} for "${issue.name}"`);
      } else if (b.dataset.action === 'edit') {
        state.editing = key; renderIssues();
        const input = document.getElementById(`rf-prio-${key}`);
        if (input) input.focus();
      } else if (b.dataset.action === 'cancel') {
        state.editing = null; renderIssues();
      }
    });

    $('#issues').addEventListener('submit', e => {
      e.preventDefault();
      const form = e.target.closest('[data-form]');
      const key = form.dataset.form;
      const issue = state.issues.find(i => i.key === key);
      const data = new FormData(form);
      const final = {
        priority: data.get('priority'),
        name: String(data.get('name') || '').trim() || issue.name,
        category: String(data.get('category') || '').trim() || issue.category,
      };
      const note = String(data.get('note') || '').trim();
      const changed = ['priority', 'name', 'category'].some(f => final[f] !== issue[f]);
      const err = form.querySelector('[data-error]');
      if (changed && !note) {
        err.textContent = 'Add a note explaining the change. It is what future reviewers and the reviewer context will see.';
        err.hidden = false;
        form.querySelector('textarea').focus();
        return;
      }
      store.addReview(issue, { reviewer: reviewerName(), datasetId: state.datasetId, final, note });
      state.editing = null;
      render();
      toast(changed ? `Saved your change to "${final.name}"` : `Approved ${issue.priority} for "${issue.name}"`);
    });

    $('#ev-issue').addEventListener('change', e => { state.evIssue = e.target.value; renderEvidence(); });
    $('#ev-search').addEventListener('input', e => { state.evSearch = e.target.value; renderEvidence(); });
    $('#evidence-table').addEventListener('change', e => {
      const sel = e.target.closest('select[data-row]');
      if (!sel) return;
      const row = state.result.rows.find(r => r.id === sel.dataset.row);
      const textKey = A.normText(row.text);
      const same = state.result.rows.filter(r => A.normText(r.text) === textKey).length;
      store.addCorrection(row, sel.value, { reviewer: reviewerName(), textKey });
      render();
      toast(sel.value === row.systemIssueKey
        ? `Returned ${row.id} to the system's assignment`
        : `Moved ${same > 1 ? `${same} items with this wording` : row.id} to "${issueName(sel.value)}"`);
    });

    $('#corrections-table').addEventListener('click', e => {
      const b = e.target.closest('[data-revoke]');
      if (!b) return;
      store.revokeCorrection(b.dataset.revoke);
      render();
      toast('Correction undone');
    });

    $('#export-csv').addEventListener('click', () => copyText(R.reviewsToCsv(store.reviews()), 'Review table (CSV)'));
    $('#export-json').addEventListener('click', () => copyText(store.exportJson(), 'Review history (JSON)'));
    $('#copy-context').addEventListener('click', () => copyText($('#context-text').textContent, 'Reviewer context'));
    $('#import-json').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const n = store.importJson(reader.result);
          render();
          toast(`Imported ${n.reviews} reviews and ${n.corrections} corrections`);
        } catch (err) {
          toast(err instanceof SyntaxError ? `${file.name} is not valid JSON.` : err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
    $('#clear-history').addEventListener('click', () => { $('#clear-confirm').hidden = false; });
    $('#clear-no').addEventListener('click', () => { $('#clear-confirm').hidden = true; });
    $('#clear-yes').addEventListener('click', () => {
      store.clear(); $('#clear-confirm').hidden = true; render(); toast('Deleted all reviews and corrections');
    });
  }

  // ------------------------------------------------------------ boot

  bind();
  buildWeights();
  renderMethod();
  const hashTab = (location.hash || '').slice(1);
  setTab(['priorities', 'evidence', 'checks', 'history', 'method'].includes(hashTab) ? hashTab : state.tab);
  loadDataset();
})();
