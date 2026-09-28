const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../js/csv.js');
const A = require('../js/analysis.js');
const R = require('../js/reviews.js');

const load = f => A.normalizeRecords(parseCsv(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8')).records);
const full = load('flowpilot_feedback_dataset.csv');
const comments = load('flowpilot_feedback_comments.csv');

test('csv parser handles quoted commas and trailing empty columns', () => {
  const { headers, records } = parseCsv('a,b,,\n1,"x, ""y""",,\n');
  assert.deepEqual(headers, ['a', 'b']);
  assert.equal(records[0].b, 'x, "y"');
});

test('loads all 90 rows from both files', () => {
  assert.equal(full.length, 90);
  assert.equal(comments.length, 90);
});

test('frequency does not decide the ranking on the full dataset', () => {
  const res = A.analyze(full);
  assert.equal(res.issues[0].key, 'integrations');
  const dash = res.issues.find(i => i.key === 'dashboards');
  assert.equal(dash.frequencyRank, 1);
  assert.ok(dash.rank > 5, `dashboards should fall in impact rank, got ${dash.rank}`);
  assert.equal(dash.arrAtRisk, 0);
});

test('mobile login issue is flagged as a release regression', () => {
  const mobile = A.analyze(full).issues.find(i => i.key === 'mobile');
  assert.equal(mobile.regression, true);
  assert.equal(mobile.topRelease, '3.8');
});

test('praise is held out of the ranking', () => {
  const res = A.analyze(full);
  assert.equal(res.praise.count, 15);
  assert.ok(res.rows.filter(r => r.id === 'F058')[0].issueKey === 'onboarding', 'mixed feedback stays a complaint');
});

test('every row is accounted for and every issue cites evidence', () => {
  const res = A.analyze(full);
  assert.equal(res.issues.reduce((s, i) => s + i.count, 0) + res.praise.count, 90);
  res.issues.forEach(i => assert.ok(i.evidence.length >= 2));
  assert.equal(res.checks.find(c => c.id === 'coverage').status, 'pass');
});

test('text-only data falls back to keywords and drops missing signals', () => {
  const res = A.analyze(comments);
  assert.equal(res.available.revenue, false);
  assert.equal(res.praise.count, 15);
  assert.ok(res.issues.every(i => i.points.revenue === 0));
  const byId = Object.fromEntries(res.rows.map(r => [r.id, r.issueKey]));
  assert.equal(byId.F025, 'integrations');
  assert.equal(byId.F039, 'mobile');
  assert.equal(byId.F047, 'permissions');
});

test('weights change the ranking', () => {
  const res = A.analyze(full, { weights: { revenue: 0, churn: 0, severity: 0, breadth: 100, escalation: 0, momentum: 0 } });
  assert.equal(res.issues[0].key, 'dashboards');
});

test('filters restrict the rows analyzed', () => {
  const res = A.analyze(full, { filters: { segment: 'Enterprise' } });
  assert.ok(res.rows.every(r => r.segment === 'Enterprise'));
  assert.ok(!res.issues.some(i => i.key === 'dashboards'));
});

test('data quality checks catch known problems in the sample', () => {
  const res = A.analyze(full);
  const byId = Object.fromEntries(res.checks.map(c => [c.id, c]));
  assert.equal(byId.duplicates.status, 'warn');
  assert.equal(byId['segment-acv'].status, 'warn');
  assert.ok(byId['segment-acv'].items.some(s => s.startsWith('F078')));
  assert.equal(byId.unowned.status, 'fail');
});

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

test('review decisions are stored, carried forward and flagged when stale', () => {
  const store = R.createStore(memStorage());
  const res = A.analyze(full);
  const mobile = res.issues.find(i => i.key === 'mobile');
  const rec = store.addReview(mobile, { reviewer: 'Dana', final: { priority: 'P0' }, note: 'Hotfix is cheap' });
  assert.equal(rec.decision, 'changed');
  assert.deepEqual(rec.changes, ['priority']);

  const merged = R.applyDecisions(res.issues, store.latestByIssue());
  const m = merged.find(i => i.key === 'mobile');
  assert.equal(m.effective.priority, 'P0');
  assert.equal(m.stale, false);

  // Re-run with weights that change the system tier: the decision carries over but is flagged.
  const res2 = A.analyze(full, { weights: { revenue: 0, churn: 0, severity: 0, breadth: 5, escalation: 0, momentum: 0 } });
  const m2 = R.applyDecisions(res2.issues, store.latestByIssue()).find(i => i.key === 'mobile');
  assert.equal(m2.effective.priority, 'P0');
  assert.equal(m2.stale, m2.priority !== 'P1');

  const csv = R.reviewsToCsv(store.reviews());
  assert.match(csv.split('\n')[1], /Dana,mobile,changed,priority/);
  assert.match(R.reviewerContext(store.reviews(), store.corrections(), k => k), /CHANGED: priority "P1" -> "P0"\. Why: Hotfix is cheap/);
});

test('item corrections are reused by classification on later runs', () => {
  const store = R.createStore(memStorage());
  const res = A.analyze(full);
  const row = res.rows.find(r => r.id === 'F004');
  assert.equal(row.issueKey, 'dashboards');
  store.addCorrection(row, 'reporting', { reviewer: 'Dana', textKey: A.normText(row.text) });
  const res2 = A.analyze(full, { itemCorrections: store.activeCorrections() });
  const moved = res2.rows.filter(r => r.text === row.text);
  assert.equal(moved.length, 2, 'duplicate wording (F004, F016) moves together');
  moved.forEach(r => { assert.equal(r.issueKey, 'reporting'); assert.equal(r.method, 'reviewer'); });
  // Also applies to the text-only dataset.
  const res3 = A.analyze(comments, { itemCorrections: store.activeCorrections() });
  assert.equal(res3.rows.find(r => r.id === 'F004').issueKey, 'reporting');
});

test('import merges without duplicating records', () => {
  const a = R.createStore(memStorage());
  const issue = A.analyze(full).issues[0];
  a.addReview(issue, { reviewer: 'A' });
  const b = R.createStore(memStorage());
  assert.deepEqual(b.importJson(a.exportJson()), { reviews: 1, corrections: 0 });
  assert.deepEqual(b.importJson(a.exportJson()), { reviews: 0, corrections: 0 });
});
