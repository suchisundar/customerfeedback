/* Minimal RFC 4180 CSV parser. Handles quoted fields, escaped quotes,
 * CRLF line endings and trailing empty columns (as in the comments export). */
(function (root) {
  'use strict';

  function parseRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const s = String(text).replace(/^﻿/, '');

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(v => v.trim() !== ''));
  }

  /** Parse CSV text into an array of objects keyed by (trimmed, lower-cased) header.
   *  Columns with an empty header are dropped. */
  function parseCsv(text) {
    const rows = parseRows(text);
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const records = rows.slice(1).map(r => {
      const o = {};
      headers.forEach((h, i) => { if (h) o[h] = (r[i] ?? '').trim(); });
      return o;
    });
    return { headers: headers.filter(Boolean), records };
  }

  const api = { parseCsv, parseRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowPilotCsv = api;
})(this);
