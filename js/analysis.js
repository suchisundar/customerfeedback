/* FlowPilot feedback analysis engine.
 *
 * Turns raw feedback rows into a ranked list of product issues. It follows the
 * "Better" prompt: frequency alone does not decide importance, so every issue is
 * scored on severity, revenue exposure, churn signal, breadth, escalations and
 * momentum, and every recommendation cites the feedback rows behind it.
 *
 * Pure functions only; no DOM access. Works in the browser (window.FlowPilotAnalysis)
 * and in Node (module.exports) for tests. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- taxonomy

  /** Known issue themes. `keywords` let the engine classify text-only datasets
   *  (e.g. the comments export) where product_area is missing. Order breaks ties. */
  const THEMES = [
    { key: 'integrations', area: 'Integrations', name: 'Salesforce sync is unreliable',
      keywords: ['salesforce', 'sync', 'integration', 'records arrive', 'totals do not match', 'duplicate contacts', 'ownership changes'] },
    { key: 'mobile', area: 'Mobile', name: 'Mobile login fails after release 3.8',
      keywords: ['mobile', 'log in', 'login', 'sign in', 'ios', 'android', 'face id', 'session expired', 'reinstall'] },
    { key: 'permissions', area: 'Permissions', name: 'Permissions and admin controls block enterprise rollout',
      keywords: ['permission', 'admin', 'access', 'audit log', 'role-based', 'approval controls', 'security review', 'compensation'] },
    { key: 'performance', area: 'Performance', name: 'Performance degrades on large workspaces',
      keywords: ['slow', 'take too long', 'sluggish', 'time out', 'freez', 'performance', 'load'] },
    { key: 'billing', area: 'Billing', name: 'Billing is confusing or incorrect',
      keywords: ['charged', 'billing', 'invoice', 'pricing', 'bill', 'purchase order'] },
    { key: 'onboarding', area: 'Onboarding', name: 'Setup steps are unclear for new teams',
      keywords: ['setup', 'set up', 'onboarding', 'tutorial', 'inviting teammates', 'data source', 'required versus optional'] },
    { key: 'reporting', area: 'Reporting', name: 'Users do not know which metrics to report',
      keywords: ['report', 'kpi', 'metrics', 'measures', 'leadership', 'client update', 'project health', 'what needs attention'] },
    { key: 'dashboards', area: 'Dashboards', name: 'Dashboard customization is limited',
      keywords: ['dashboard', 'color', 'colour', 'theme', 'layout', 'widget', 'dark mode', 'font', 'rearrange', 'home screen', 'polished', 'cards around', 'palette'] },
  ];
  const THEME_BY_AREA = Object.fromEntries(THEMES.map(t => [t.area.toLowerCase(), t]));
  const THEME_BY_KEY = Object.fromEntries(THEMES.map(t => [t.key, t]));

  /** Score components, in display order. `weight` is the default weight (sums to 100). */
  const COMPONENTS = [
    { key: 'revenue',    label: 'Revenue at risk', weight: 25, help: 'Annual contract value of affected accounts, relative to the most exposed issue.' },
    { key: 'churn',      label: 'Churn signal',    weight: 25, help: 'Cancellations and churn-risk flags on the affected feedback.' },
    { key: 'severity',   label: 'Severity',        weight: 20, help: 'How low the ratings are (1 star = most severe).' },
    { key: 'breadth',    label: 'Breadth',         weight: 10, help: 'Distinct accounts affected, relative to the widest issue.' },
    { key: 'escalation', label: 'Escalations',     weight: 10, help: 'Share of feedback escalated to support leadership.' },
    { key: 'momentum',   label: 'Momentum',        weight: 10, help: 'Share of feedback from the last 30 days of the dataset.' },
  ];
  const DEFAULT_WEIGHTS = Object.fromEntries(COMPONENTS.map(c => [c.key, c.weight]));

  const PRIORITY_TIERS = [
    { id: 'P0', min: 60, label: 'Act now' },
    { id: 'P1', min: 40, label: 'Next up' },
    { id: 'P2', min: 22, label: 'Plan' },
    { id: 'P3', min: 0,  label: 'Monitor' },
  ];

  // Language that signals a request or complaint, even with a good rating.
  const REQUEST_RE = /\b(need|needs|want|wish|would|please|can we|can the|cannot|can't|too|not|no longer|fail\w*|lack|stopped|lost|wrong|harder|confusing|gave up)\b/i;
  const PRAISE_RE = /\b(easy|helped|clear|useful|excellent|save|saves|shorter|renewed|hub|replaced|clearer|solved|click|followed up|every client|understood)\b/i;
  const SEVERE_RE = /\b(cancel\w*|cannot|can't|fail\w*|lost|wrong|charged|trust|blocking|stopped|drops|freez\w*|time out)\b/i;

  // ---------------------------------------------------------------- normalize

  const num = v => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(String(v).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const yesNo = v => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    return /^(yes|y|true|1)$/i.test(String(v).trim());
  };
  const str = v => (v === undefined || v === null ? '' : String(v).trim());

  /** Normalize parsed CSV records into typed feedback rows. */
  function normalizeRecords(records) {
    return records
      .filter(r => str(r.feedback_text))
      .map((r, i) => ({
        id: str(r.feedback_id) || `ROW-${i + 1}`,
        account: str(r.account_id),
        date: str(r.date),
        text: str(r.feedback_text),
        source: str(r.source),
        segment: str(r.customer_segment),
        plan: str(r.plan),
        acv: num(r.annual_contract_value),
        tenure: num(r.tenure_months),
        area: str(r.product_area),
        rating: num(r.rating),
        usage: str(r.usage_level),
        canceled: yesNo(r.canceled),
        churnRisk: str(r.churn_risk),
        escalated: yesNo(r.support_escalation),
        release: str(r.release_version),
        status: str(r.resolution_status),
        action: str(r.action_taken),
        outcome: str(r.outcome_after_action),
      }));
  }

  /** Which optional signals the dataset actually carries. */
  function detectFields(rows) {
    const has = f => rows.some(r => r[f] !== null && r[f] !== '');
    return {
      rating: has('rating'), acv: has('acv'), segment: has('segment'), area: has('area'),
      canceled: has('canceled'), churnRisk: has('churnRisk'), escalated: has('escalated'),
      date: has('date'), release: has('release'), plan: has('plan'), source: has('source'),
    };
  }

  const normText = t => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // ---------------------------------------------------------------- classify

  /** Classify text alone against the theme keywords. Returns {theme, hits}. */
  function classifyText(text) {
    const t = text.toLowerCase();
    let best = null;
    let bestHits = 0;
    for (const theme of THEMES) {
      const hits = theme.keywords.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
      if (hits > bestHits) { best = theme; bestHits = hits; }
    }
    return { theme: best, hits: bestHits };
  }

  /** Is this row praise (something to protect) rather than a problem to fix? */
  function isPraise(row) {
    if (REQUEST_RE.test(row.text)) return false;
    if (row.rating !== null) return row.rating >= 4;
    return PRAISE_RE.test(row.text);
  }

  const areaKey = area => 'area:' + area.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  /** Assign each row to an issue key (or 'praise'). Reviewer corrections that move
   *  a specific comment to another issue are honored first, matched by normalized
   *  text so they carry over to future datasets. */
  function assignRows(rows, itemCorrections) {
    const byText = new Map();
    (itemCorrections || []).forEach(c => byText.set(c.textKey, c));
    return rows.map(row => {
      const textMatch = classifyText(row.text);
      const praise = isPraise(row);
      let issueKey;
      let method;
      if (praise) {
        issueKey = 'praise'; method = 'sentiment';
      } else if (row.area && THEME_BY_AREA[row.area.toLowerCase()]) {
        issueKey = THEME_BY_AREA[row.area.toLowerCase()].key; method = 'product_area';
      } else if (row.area) {
        issueKey = areaKey(row.area); method = 'product_area';
      } else if (textMatch.theme) {
        issueKey = textMatch.theme.key; method = 'keywords';
      } else {
        issueKey = 'other'; method = 'unmatched';
      }
      const correction = byText.get(normText(row.text));
      const systemIssueKey = issueKey;
      if (correction && correction.toIssueKey) { issueKey = correction.toIssueKey; method = 'reviewer'; }
      return { ...row, issueKey, systemIssueKey, method, textTheme: textMatch.theme ? textMatch.theme.key : null, praise };
    });
  }

  // ---------------------------------------------------------------- score

  const CHURN_VALUE = { high: 0.8, medium: 0.4, low: 0 };

  function churnValue(row) {
    if (row.canceled) return 1;
    const v = CHURN_VALUE[row.churnRisk.toLowerCase()];
    return v === undefined ? null : v;
  }

  function severityValue(row) {
    if (row.rating !== null) return Math.min(1, Math.max(0, (5 - row.rating) / 4));
    return SEVERE_RE.test(row.text) ? 0.8 : 0.4; // estimated from wording
  }

  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const DAY = 86400000;

  function issueMeta(key, rows) {
    if (THEME_BY_KEY[key]) {
      const t = THEME_BY_KEY[key];
      return { name: t.name, category: t.area };
    }
    if (key === 'other') return { name: 'Uncategorized feedback', category: 'Other' };
    const area = rows[0] && rows[0].area ? rows[0].area : key.replace(/^area:/, '');
    return { name: `${area} complaints`, category: area };
  }

  /** Aggregate raw signals for one issue. Normalized components are filled in later
   *  because revenue and breadth are relative to the other issues. */
  function aggregate(key, rows, ctx) {
    const accounts = new Map();
    rows.forEach(r => {
      const k = r.account || r.id;
      const prev = accounts.get(k);
      accounts.set(k, {
        acv: Math.max(prev ? prev.acv : 0, r.acv || 0),
        canceled: (prev && prev.canceled) || !!r.canceled,
        segment: r.segment || (prev && prev.segment) || '',
      });
    });
    const accountList = [...accounts.values()];
    const churnVals = rows.map(churnValue).filter(v => v !== null);
    const releases = countBy(rows, r => r.release);
    const segments = countBy(accountList, a => a.segment);
    const plans = countBy(rows, r => r.plan);
    const recent = ctx.maxDate
      ? rows.filter(r => r.date && Date.parse(r.date) >= ctx.maxDate - 30 * DAY).length
      : 0;
    const dates = rows.map(r => r.date).filter(Boolean).sort();
    const topRelease = releases[0];

    return {
      key,
      ...issueMeta(key, rows),
      count: rows.length,
      accounts: accounts.size,
      arrAtRisk: accountList.reduce((s, a) => s + a.acv, 0),
      canceledAccounts: accountList.filter(a => a.canceled).length,
      highRisk: rows.filter(r => r.churnRisk.toLowerCase() === 'high').length,
      escalations: rows.filter(r => r.escalated).length,
      avgRating: mean(rows.map(r => r.rating).filter(v => v !== null)),
      raw: {
        severity: mean(rows.map(severityValue)),
        churn: churnVals.length ? mean(churnVals) : null,
        escalation: ctx.fields.escalated ? rows.filter(r => r.escalated).length / rows.length : null,
        momentum: ctx.maxDate ? recent / rows.length : null,
      },
      recent,
      segments,
      plans,
      releases,
      firstDate: dates[0] || '',
      lastDate: dates[dates.length - 1] || '',
      regression: !!(topRelease && ctx.latestRelease && topRelease.value === ctx.latestRelease &&
        topRelease.count / rows.length >= 0.75 && ctx.releaseShare[ctx.latestRelease] < 0.6 && rows.length >= 3),
      topRelease: topRelease ? topRelease.value : '',
      rows,
    };
  }

  function countBy(xs, fn) {
    const m = new Map();
    xs.forEach(x => { const k = fn(x); if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  }

  function tierFor(score) {
    return PRIORITY_TIERS.find(t => score >= t.min).id;
  }

  const money = n => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);

  /** Human-readable reasons behind the score, strongest first. */
  function rationale(issue, fields) {
    const out = [];
    if (fields.acv) {
      out.push(issue.arrAtRisk > 0
        ? `${money(issue.arrAtRisk)} in annual contract value across ${issue.accounts} account${issue.accounts === 1 ? '' : 's'}`
        : `No contract value at risk: every account is on the ${issue.plans[0] ? issue.plans[0].value : 'free'} plan`);
    }
    if (issue.canceledAccounts) out.push(`${issue.canceledAccounts} account${issue.canceledAccounts === 1 ? ' has' : 's have'} already canceled`);
    if (issue.highRisk) out.push(`${issue.highRisk} of ${issue.count} items flagged high churn risk`);
    if (issue.escalations) out.push(`${issue.escalations} of ${issue.count} items escalated`);
    if (issue.regression) out.push(`${Math.round(issue.releases[0].count / issue.count * 100)}% of reports are on release ${issue.topRelease}, the newest release: likely regression`);
    if (issue.avgRating !== null) out.push(`Average rating ${issue.avgRating.toFixed(1)} / 5`);
    const ent = issue.segments.find(s => s.value === 'Enterprise');
    if (ent && ent.count / issue.accounts >= 0.5) out.push(`Concentrated in Enterprise accounts (${ent.count} of ${issue.accounts})`);
    const expansion = issue.rows.filter(r => /expansion delayed/i.test(r.outcome) || /expand|roll this out|more departments/i.test(r.text)).length;
    if (expansion) out.push(`${expansion} item${expansion === 1 ? '' : 's'} tie the issue to blocked expansion`);
    return out;
  }

  /** A suggested next step. Deliberately rule-based so reviewers can see why. */
  function nextStep(issue) {
    if (issue.regression) return `Treat as a release regression: bisect release ${issue.topRelease}, ship a hotfix, and tell affected accounts about the reinstall workaround until then.`;
    if (issue.canceledAccounts) return 'Assign an engineering owner for root cause, and have account managers contact every at-risk account with a recovery plan.';
    if (issue.key === 'permissions' || issue.rows.some(r => /expansion delayed/i.test(r.outcome))) return 'Scope an enterprise admin package (roles, audit logs, external-collaborator approvals) and share a dated roadmap with blocked accounts.';
    if (issue.arrAtRisk === 0 && issue.count >= 5) return 'Low revenue impact. Keep in the backlog and consider it as an upgrade incentive rather than a free-tier fix.';
    if (issue.key === 'reporting') return 'Research the underlying job: users ask for templates, but the need is guidance on which metrics matter. Prototype a goal-based report.';
    if (issue.escalations / issue.count >= 0.3) return 'Investigate the escalated cases first; confirm the scope with support before committing roadmap time.';
    return 'Validate with 3 to 5 customer conversations before committing roadmap time.';
  }

  /** Pick the most telling quotes: canceled or high risk first, then lowest rating, then biggest account. */
  function pickEvidence(rows, n) {
    return [...rows]
      .sort((a, b) => (churnValue(b) ?? 0) - (churnValue(a) ?? 0)
        || (a.rating ?? 3) - (b.rating ?? 3)
        || (b.acv ?? 0) - (a.acv ?? 0))
      .slice(0, n);
  }

  function confidenceFor(issue, fields) {
    let level = issue.count >= 8 ? 'High' : issue.count >= 4 ? 'Medium' : 'Low';
    const notes = [];
    if (!fields.rating || !fields.acv) {
      notes.push('Dataset lacks rating or contract value, so severity and revenue are estimated or omitted.');
      if (level === 'High') level = 'Medium';
    }
    if (issue.count < 4) notes.push(`Only ${issue.count} feedback item${issue.count === 1 ? '' : 's'}.`);
    const mismatched = issue.rows.filter(r => r.textTheme && r.textTheme !== issue.key && THEME_BY_KEY[issue.key]).length;
    if (mismatched) notes.push(`${mismatched} item${mismatched === 1 ? ' reads' : 's read'} like a different issue; check the evidence.`);
    return { level, notes };
  }

  // ---------------------------------------------------------------- analyze

  /**
   * Run the full analysis.
   * @param {object[]} rows normalized rows
   * @param {object} opts { weights, filters, itemCorrections }
   */
  function analyze(rows, opts = {}) {
    const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
    const filtered = applyFilters(rows, opts.filters || {});
    const fields = detectFields(rows);
    const assigned = assignRows(filtered, opts.itemCorrections);

    const dates = assigned.map(r => Date.parse(r.date)).filter(Number.isFinite);
    const maxDate = dates.length ? Math.max(...dates) : null;
    const releaseCounts = countBy(assigned, r => r.release);
    const latestRelease = releaseCounts.map(r => r.value).sort(compareVersions).pop() || '';
    const releaseShare = Object.fromEntries(releaseCounts.map(r => [r.value, r.count / (assigned.length || 1)]));
    const ctx = { fields, maxDate, latestRelease, releaseShare };

    const groups = new Map();
    assigned.forEach(r => {
      if (!groups.has(r.issueKey)) groups.set(r.issueKey, []);
      groups.get(r.issueKey).push(r);
    });

    const praiseRows = groups.get('praise') || [];
    groups.delete('praise');

    let issues = [...groups.entries()].map(([key, rs]) => aggregate(key, rs, ctx));

    // Relative components.
    const maxArr = Math.max(0, ...issues.map(i => i.arrAtRisk));
    const maxAccounts = Math.max(1, ...issues.map(i => i.accounts));
    const available = {
      revenue: fields.acv,
      churn: fields.canceled || fields.churnRisk,
      severity: true,
      breadth: true,
      escalation: fields.escalated,
      momentum: fields.date,
    };
    const activeWeight = COMPONENTS.reduce((s, c) => s + (available[c.key] ? Number(weights[c.key]) || 0 : 0), 0) || 1;

    issues = issues.map(issue => {
      const components = {
        revenue: maxArr > 0 ? Math.sqrt(issue.arrAtRisk) / Math.sqrt(maxArr) : 0,
        churn: issue.raw.churn ?? 0,
        severity: issue.raw.severity ?? 0,
        breadth: issue.accounts / maxAccounts,
        escalation: issue.raw.escalation ?? 0,
        momentum: issue.raw.momentum ?? 0,
      };
      // Points each component contributes, rescaled so available weights sum to 100.
      const points = {};
      COMPONENTS.forEach(c => {
        points[c.key] = available[c.key] ? components[c.key] * (Number(weights[c.key]) || 0) * 100 / activeWeight : 0;
      });
      const score = Object.values(points).reduce((a, b) => a + b, 0);
      const out = { ...issue, components, points, score, priority: tierFor(score) };
      out.reasons = rationale(out, fields);
      out.nextStep = nextStep(out);
      out.evidence = pickEvidence(issue.rows, 3);
      out.confidence = confidenceFor(out, fields);
      return out;
    });

    issues.sort((a, b) => b.score - a.score || b.count - a.count);
    issues.forEach((i, idx) => { i.rank = idx + 1; });
    const byFrequency = [...issues].sort((a, b) => b.count - a.count || b.accounts - a.accounts);
    byFrequency.forEach((i, idx) => { i.frequencyRank = idx + 1; });

    return {
      fields,
      available,
      weights,
      rows: assigned,
      totalRows: rows.length,
      issues,
      praise: summarizePraise(praiseRows),
      maxDate: maxDate ? new Date(maxDate).toISOString().slice(0, 10) : '',
      latestRelease,
      checks: runChecks(rows, assigned, issues, fields),
    };
  }

  function summarizePraise(rows) {
    const themes = countBy(rows, r => r.area || (r.textTheme ? THEME_BY_KEY[r.textTheme].area : 'General'));
    const renewed = rows.filter(r => /renew/i.test(r.outcome) || /renew/i.test(r.text)).length;
    return { count: rows.length, themes, renewed, rows, arr: sumUniqueAcv(rows) };
  }

  function sumUniqueAcv(rows) {
    const m = new Map();
    rows.forEach(r => m.set(r.account || r.id, Math.max(m.get(r.account || r.id) || 0, r.acv || 0)));
    return [...m.values()].reduce((a, b) => a + b, 0);
  }

  function compareVersions(a, b) {
    const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function applyFilters(rows, f) {
    return rows.filter(r =>
      (!f.segment || r.segment === f.segment) &&
      (!f.plan || r.plan === f.plan) &&
      (!f.source || r.source === f.source) &&
      (!f.from || !r.date || r.date >= f.from) &&
      (!f.to || !r.date || r.date <= f.to));
  }

  // ---------------------------------------------------------------- checks

  /** Evaluation checks: does the output hold up, and can the input be trusted? */
  function runChecks(allRows, assigned, issues, fields) {
    const checks = [];
    const add = (group, id, title, status, detail, items) => checks.push({ group, id, title, status, detail, items: items || [] });

    // Output checks
    const assignedIds = new Set(assigned.map(r => r.id));
    const issueRowCount = issues.reduce((s, i) => s + i.count, 0);
    const praiseCount = assigned.filter(r => r.issueKey === 'praise').length;
    add('Output', 'coverage', 'Every feedback item is accounted for',
      issueRowCount + praiseCount === assigned.length ? 'pass' : 'fail',
      `${issueRowCount} items in issues + ${praiseCount} praise = ${issueRowCount + praiseCount} of ${assigned.length}.`);

    const thin = issues.filter(i => i.count < 2);
    add('Output', 'evidence', 'Each ranked issue cites at least 2 feedback items',
      thin.length ? 'warn' : 'pass',
      thin.length ? `${thin.length} issue(s) rest on a single comment.` : 'All issues cite 2 or more items.',
      thin.map(i => `${i.name} (${i.rows[0].id})`));

    const other = issues.find(i => i.key === 'other');
    add('Output', 'unmatched', 'No feedback left uncategorized',
      other ? 'warn' : 'pass',
      other ? `${other.count} item(s) matched no theme and need a reviewer.` : 'Every complaint maps to a theme.',
      other ? other.rows.map(r => `${r.id}: ${r.text}`) : []);

    const top = issues[0];
    const freqTop = [...issues].sort((a, b) => b.count - a.count)[0];
    if (top && freqTop) {
      const diverge = top.key !== freqTop.key;
      add('Output', 'frequency', 'Ranking is not just a vote count',
        'info',
        diverge
          ? `The most frequent issue (${freqTop.name}, ${freqTop.count} items) ranks #${freqTop.rank} by impact. The top impact issue has ${top.count} items.`
          : `The most frequent issue is also the top impact issue (${top.name}).`);
    }

    const praiseMisfiled = assigned.filter(r => r.praise && r.rating !== null && r.rating <= 2);
    add('Output', 'sentiment', 'Praise and complaints are separated consistently',
      praiseMisfiled.length ? 'warn' : 'pass',
      praiseMisfiled.length ? 'Some low-rated items were read as praise.' : `${praiseCount} positive items held out of the issue ranking.`,
      praiseMisfiled.map(r => `${r.id}: ${r.text}`));

    // Data quality checks
    if (fields.area) {
      const disagree = assigned.filter(r => r.area && r.textTheme && THEME_BY_AREA[r.area.toLowerCase()] && THEME_BY_AREA[r.area.toLowerCase()].key !== r.textTheme);
      const praiseArea = assigned.filter(r => r.praise && r.area && /templates|support|collaboration/i.test(r.area))
        .filter(r => {
          const t = r.text.toLowerCase();
          if (/templates/i.test(r.area)) return !/template/.test(t);
          if (/support/i.test(r.area)) return !/support/.test(t);
          return /support|template/.test(t);
        });
      const items = [
        ...disagree.map(r => `${r.id}: labeled ${r.area}, text reads like ${THEME_BY_KEY[r.textTheme].area}. "${r.text}"`),
        ...praiseArea.map(r => `${r.id}: labeled ${r.area}. "${r.text}"`),
      ];
      add('Input', 'labels', 'Product area labels match the comment text',
        items.length ? 'warn' : 'pass',
        items.length ? `${items.length} item(s) look mislabeled. The ranking uses the label; reassign them in Evidence if the text is right.` : 'Labels agree with the text.',
        items);
    }

    const dupes = new Map();
    allRows.forEach(r => {
      const k = (r.account || '') + '|' + normText(r.text);
      if (!dupes.has(k)) dupes.set(k, []);
      dupes.get(k).push(r.id);
    });
    const dupeList = [...dupes.values()].filter(ids => ids.length > 1);
    const sameText = new Map();
    allRows.forEach(r => { const k = normText(r.text); sameText.set(k, (sameText.get(k) || 0) + 1); });
    const templated = [...sameText.values()].filter(n => n > 1).reduce((a, n) => a + n, 0);
    add('Input', 'duplicates', 'No duplicate submissions inflate volume',
      dupeList.length ? 'warn' : 'pass',
      dupeList.length
        ? `${dupeList.length} account(s) submitted the same comment twice; ${templated} items share their exact wording with another item. Breadth counts distinct accounts, so the score is not inflated, but raw counts are.`
        : 'No repeated comments.',
      dupeList.map(ids => ids.join(' = ')));

    if (fields.acv) {
      const byAccount = new Map();
      allRows.forEach(r => {
        if (!r.account || r.acv === null) return;
        if (!byAccount.has(r.account)) byAccount.set(r.account, new Set());
        byAccount.get(r.account).add(r.acv);
      });
      const inconsistent = [...byAccount.entries()].filter(([, s]) => s.size > 1);
      add('Input', 'acv', 'Each account has one contract value',
        inconsistent.length ? 'warn' : 'pass',
        inconsistent.length
          ? `${inconsistent.length} account(s) report different contract values on different rows. Revenue at risk uses the highest value per account.`
          : 'Contract values are consistent per account.',
        inconsistent.map(([a, s]) => `${a}: ${[...s].sort((x, y) => x - y).map(v => '$' + v.toLocaleString('en-US')).join(', ')}`));

      const odd = allRows.filter(r => r.acv !== null && (
        (r.segment === 'Startup' && r.acv > 50000) ||
        (r.segment === 'Enterprise' && r.acv > 0 && r.acv < 10000) ||
        (/free/i.test(r.plan) && r.acv > 0)));
      add('Input', 'segment-acv', 'Contract value fits the customer segment',
        odd.length ? 'warn' : 'pass',
        odd.length ? `${odd.length} row(s) have a contract value unusual for their segment or plan.` : 'Contract values fit their segments.',
        odd.map(r => `${r.id} (${r.account}, ${r.segment} ${r.plan}): $${r.acv.toLocaleString('en-US')}`));
    }

    const actionConflicts = allRows.filter(r =>
      (/closed - no action/i.test(r.status) && r.action) ||
      (/resolved|closed/i.test(r.status) && /still at risk|recurred/i.test(r.outcome)) ||
      (!r.action && r.outcome && !/activated|positive|renewed/i.test(r.outcome)));
    if (fields.release || allRows.some(r => r.status)) {
      add('Input', 'status', 'Resolution status agrees with action and outcome',
        actionConflicts.length ? 'warn' : 'pass',
        actionConflicts.length ? `${actionConflicts.length} row(s) have a status, action and outcome that contradict each other (for example "Closed - no action" with an action recorded, or an outcome with no action).` : 'Status fields are consistent.',
        actionConflicts.map(r => `${r.id}: status "${r.status}", action "${r.action || '(none)'}", outcome "${r.outcome || '(none)'}"`));

      const unowned = allRows.filter(r => (r.canceled || /high/i.test(r.churnRisk)) && !r.action);
      add('Input', 'unowned', 'High-risk feedback has an action on record',
        unowned.length ? 'fail' : 'pass',
        unowned.length ? `${unowned.length} canceled or high-risk item(s) have no action taken.` : 'Every high-risk item has an action.',
        unowned.map(r => `${r.id} (${r.account}): ${r.text}`));
    }

    const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
    add('Input', 'fields', 'Dataset carries the signals the scoring needs',
      missing.length ? (fields.rating ? 'warn' : 'fail') : 'pass',
      missing.length ? `Missing: ${missing.join(', ')}. Components without data are left out and the remaining weights rescaled.` : 'All scoring signals present.');

    return checks;
  }

  // ---------------------------------------------------------------- export

  const api = {
    THEMES, COMPONENTS, DEFAULT_WEIGHTS, PRIORITY_TIERS,
    normalizeRecords, detectFields, classifyText, isPraise, assignRows, analyze, tierFor, normText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowPilotAnalysis = api;
})(this);
