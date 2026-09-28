/* Human review store.
 *
 * Two tables, both append-only so the history is never lost:
 *   reviews      one row per reviewer decision on an issue (approve / change)
 *   corrections  one row per feedback item a reviewer moved to another issue
 *
 * Persisted to localStorage when available, otherwise kept in memory. The latest
 * review per issue is carried forward onto future analyses, and item corrections
 * are fed back into classification (matched by comment text). */
(function (root) {
  'use strict';

  const KEY = 'flowpilot.review-store.v1';

  function memoryStorage() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
  }

  function safeStorage(storage) {
    try {
      const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!s) return memoryStorage();
      const probe = '__fp_probe__';
      s.setItem(probe, '1'); s.removeItem(probe);
      return s;
    } catch (e) {
      return memoryStorage();
    }
  }

  const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  function createStore(storage) {
    const store = safeStorage(storage);
    let state = read();

    function read() {
      try {
        const raw = store.getItem(KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return { reviews: parsed && parsed.reviews || [], corrections: parsed && parsed.corrections || [] };
      } catch (e) {
        return { reviews: [], corrections: [] };
      }
    }
    function write() {
      try { store.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked: keep in memory */ }
    }

    /** Record a decision on an issue.
     *  @param issue  the system issue (from analyze)
     *  @param input  { reviewer, final: {name, category, priority}, note, datasetId } */
    function addReview(issue, input) {
      const system = { name: issue.name, category: issue.category, priority: issue.priority, score: Math.round(issue.score * 10) / 10, rank: issue.rank };
      const final = { ...system, ...(input.final || {}) };
      const changes = ['name', 'category', 'priority'].filter(f => final[f] !== system[f]);
      const rec = {
        id: uid('R'),
        at: new Date().toISOString(),
        reviewer: (input.reviewer || '').trim() || 'Unnamed reviewer',
        datasetId: input.datasetId || '',
        issueKey: issue.key,
        system,
        final: { name: final.name, category: final.category, priority: final.priority },
        decision: changes.length ? 'changed' : 'approved',
        changes,
        note: (input.note || '').trim(),
        evidenceIds: issue.rows.map(r => r.id),
      };
      state.reviews.push(rec);
      write();
      return rec;
    }

    /** Move one feedback item to another issue. */
    function addCorrection(row, toIssueKey, input) {
      const rec = {
        id: uid('C'),
        at: new Date().toISOString(),
        reviewer: (input && input.reviewer || '').trim() || 'Unnamed reviewer',
        feedbackId: row.id,
        textKey: input.textKey,
        text: row.text,
        fromIssueKey: row.systemIssueKey,
        toIssueKey,
        note: (input && input.note || '').trim(),
        active: true,
      };
      // A newer correction for the same text replaces the older one.
      state.corrections.forEach(c => { if (c.textKey === rec.textKey) c.active = false; });
      if (toIssueKey !== row.systemIssueKey) state.corrections.push(rec);
      write();
      return rec;
    }

    function revokeCorrection(id) {
      const c = state.corrections.find(x => x.id === id);
      if (c) { c.active = false; write(); }
    }

    function reviews() { return state.reviews.slice(); }
    function corrections() { return state.corrections.slice(); }
    function activeCorrections() { return state.corrections.filter(c => c.active); }

    /** Latest decision per issue key. */
    function latestByIssue() {
      const m = new Map();
      state.reviews.forEach(r => { if (!m.has(r.issueKey) || m.get(r.issueKey).at <= r.at) m.set(r.issueKey, r); });
      return m;
    }

    function clear() { state = { reviews: [], corrections: [] }; write(); }

    function exportJson() { return JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2); }

    function importJson(text) {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.reviews)) throw new Error('This file has no "reviews" list. Export a review file from FlowPilot Triage and try again.');
      const seen = new Set(state.reviews.map(r => r.id));
      const seenC = new Set(state.corrections.map(c => c.id));
      const newReviews = data.reviews.filter(r => r && r.id && !seen.has(r.id));
      const newCorrections = (data.corrections || []).filter(c => c && c.id && !seenC.has(c.id));
      state.reviews.push(...newReviews);
      state.corrections.push(...newCorrections);
      state.reviews.sort((a, b) => a.at.localeCompare(b.at));
      write();
      return { reviews: newReviews.length, corrections: newCorrections.length };
    }

    return { addReview, addCorrection, revokeCorrection, reviews, corrections, activeCorrections, latestByIssue, clear, exportJson, importJson };
  }

  /** Merge system issues with carried-forward human decisions. */
  function applyDecisions(issues, latest) {
    return issues.map(issue => {
      const review = latest.get(issue.key) || null;
      const stale = !!(review && review.system.priority !== issue.priority);
      return {
        ...issue,
        review,
        stale,
        effective: review ? { ...review.final } : { name: issue.name, category: issue.category, priority: issue.priority },
      };
    });
  }

  const csvCell = v => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function reviewsToCsv(reviews) {
    const header = ['review_id', 'reviewed_at', 'reviewer', 'issue_key', 'decision', 'changed_fields',
      'system_name', 'system_category', 'system_priority', 'system_score', 'system_rank',
      'final_name', 'final_category', 'final_priority', 'reviewer_note', 'dataset', 'evidence_ids'];
    const lines = reviews.map(r => [r.id, r.at, r.reviewer, r.issueKey, r.decision, r.changes.join('|'),
      r.system.name, r.system.category, r.system.priority, r.system.score, r.system.rank,
      r.final.name, r.final.category, r.final.priority, r.note, r.datasetId, (r.evidenceIds || []).join(' ')].map(csvCell).join(','));
    return [header.join(','), ...lines].join('\n');
  }

  /** Text block summarizing past human corrections, to reuse as context for the next
   *  analysis run or to paste into an LLM prompt (Custom GPT, Claude, Cursor). */
  function reviewerContext(reviews, corrections, issueNames) {
    const latest = new Map();
    reviews.forEach(r => latest.set(r.issueKey, r));
    const lines = ['## Prior human review decisions', 'Treat these as corrections from product reviewers. Apply them unless new evidence clearly contradicts them, and say when it does.', ''];
    if (!latest.size && !corrections.length) lines.push('(No reviews recorded yet.)');
    [...latest.values()].forEach(r => {
      if (r.decision === 'approved') {
        lines.push(`- APPROVED: "${r.system.name}" at ${r.system.priority}.${r.note ? ` Reviewer note: ${r.note}` : ''}`);
      } else {
        const parts = r.changes.map(f => `${f} "${r.system[f]}" -> "${r.final[f]}"`);
        lines.push(`- CHANGED: ${parts.join('; ')}.${r.note ? ` Why: ${r.note}` : ''}`);
      }
    });
    const active = corrections.filter(c => c.active);
    if (active.length) {
      lines.push('', '## Feedback items reviewers re-categorized');
      active.forEach(c => lines.push(`- "${c.text}" belongs to ${issueNames(c.toIssueKey)}, not ${issueNames(c.fromIssueKey)}.${c.note ? ` Why: ${c.note}` : ''}`));
    }
    return lines.join('\n');
  }

  const api = { createStore, applyDecisions, reviewsToCsv, reviewerContext };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowPilotReviews = api;
})(this);
