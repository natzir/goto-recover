/*
 * goto-recover / resolve.js
 *
 * Reference implementation for pipelines: takes raw Google Search HTML (and,
 * optionally, the bodies of the /async/ responses the page loads afterwards,
 * which is where the AI Overview arrives) and returns the destination URL
 * behind every /goto?url=<token> link it can pair. No DOM, no dependencies,
 * no requests.
 *
 *   const { resolve } = require('./resolve');
 *   const { tokens, stats } = resolve([html, asyncBody1, asyncBody2]);
 *   tokens.get('<token>')  // -> { url, kind, host }
 *
 *   node resolve.js page.html [async1.txt ...]   -> JSON on stdout
 *   node resolve.js --csv page.html              -> token,url,kind
 *
 * Same rules as the bookmarklet (see README): exact > embedded / adjacent >
 * inferred / derived > domain.
 */
'use strict';

const TOKEN_RE = /\/goto\?url(?:=|\\u003d|%3D)([A-Za-z0-9_-]{20,})/;
const TOKEN_RE_G = new RegExp(TOKEN_RE.source, 'g');
const REQ_RE = /[?&]req(?:=|\\u003d|%3D)([A-Za-z0-9_-]{20,})/;
const SKIP_HOST = /(^|\.)(google\.[a-z.]+|gstatic\.com|googleapis\.com|googleusercontent\.com|googleadservices\.com|googlesyndication\.com|doubleclick\.net|ytimg\.com|w3\.org|schema\.org)$/i;
const RANK = { exact: 5, embedded: 4, adjacent: 4, inferred: 3, derived: 3, domain: 1 };
const ENTITY = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'" };
const unescapeHtml = (s) => s.replace(/&quot;|&amp;|&lt;|&gt;|&#39;/g, (e) => ENTITY[e]);

/* ---------- string level ---------- */

function protoField1(b64) {
  try {
    const buf = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf[0] !== 0x0a) return null;
    let len = 0, shift = 0, i = 1, byte;
    do { byte = buf[i++]; len |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return buf.subarray(i, i + len).toString('utf8');
  } catch { return null; }
}

function classify(raw, kind, demoteBareRoot) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol) || SKIP_HOST.test(u.hostname)) return null;
    const bare = u.pathname === '/' && !u.search;
    return { url: u.href, kind: bare && demoteBareRoot ? 'domain' : kind };
  } catch { return null; }
}

function inspect(str) {
  const out = { token: null, cands: [], text: null };
  const t = TOKEN_RE.exec(str);
  if (t) out.token = t[1];
  const r = REQ_RE.exec(str);
  if (r) {
    const target = protoField1(r[1]);
    if (target && /^https?:\/\//.test(target)) {
      const c = classify(target, 'exact', false);
      if (c) out.cands.push(c);
    }
  }
  if (/^https?:\/\/\S+$/.test(str)) {
    const c = classify(str, 'embedded', true);
    if (c) out.cands.push(c);
  }
  if (!t && !r && str.length >= 20 && !/https?:\/\//.test(str)) out.text = str;
  return out;
}

/* ---------- sources ---------- */

function balancedJson(text, from) {
  const open = text[from];
  if (open !== '{' && open !== '[') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (--depth === 0) { try { return JSON.parse(text.slice(from, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

function* sources(html) {
  // a) inline state: var m={...}
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m; (m = scriptRe.exec(html));) {
    const text = m[1];
    if (!text.includes('/goto')) continue;
    const i = text.indexOf('var m={');
    if (i < 0) continue;
    const data = balancedJson(text, i + 6);
    if (data) yield data;
  }
  // b) deferred payloads in comments: MARKER|||[...]
  const commentRe = /<!--([\s\S]*?)-->/g;
  for (let m; (m = commentRe.exec(html));) {
    const raw = m[1];
    const sep = raw.indexOf('|||');
    if (sep < 0 || !raw.includes('/goto')) continue;
    const json = unescapeHtml(raw.slice(sep + 3));
    const data = balancedJson(json, json.search(/[[{]/));
    if (data) yield data;
  }
}

/* ---------- resolution ---------- */

function resolve(inputs) {
  const docs = Array.isArray(inputs) ? inputs : [inputs];
  const html = docs.join('\n');
  const resolved = new Map();

  function offer(token, cands, texts) {
    if (!cands.size) return;
    const top = [...cands.values()].sort((a, b) => RANK[b.kind] - RANK[a.kind] || b.n - a.n)[0];
    const cur = resolved.get(token);
    if (cur && RANK[cur.kind] >= RANK[top.kind]) return;
    resolved.set(token, { url: top.url, kind: top.kind, host: new URL(top.url).hostname, title: texts[0] || cur?.title || null });
  }

  function walk(value) {
    if (typeof value === 'string') {
      const r = inspect(value);
      return {
        tokens: new Set(r.token ? [r.token] : []),
        cands: new Map(r.cands.map((c) => [c.url, { ...c, n: 1 }])),
        texts: r.text ? [r.text] : []
      };
    }
    if (!value || typeof value !== 'object') return { tokens: new Set(), cands: new Map(), texts: [] };
    const tokens = new Set(), cands = new Map(), texts = [];
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const r = walk(child);
      for (const t of r.tokens) tokens.add(t);
      for (const [url, c] of r.cands) { const e = cands.get(url); if (e) e.n += c.n; else cands.set(url, { ...c }); }
      if (texts.length < 3) texts.push(...r.texts.slice(0, 3 - texts.length));
    }
    if (tokens.size === 1) offer(tokens.values().next().value, cands, texts);
    return { tokens, cands, texts };
  }

  for (const data of sources(html)) walk(data);

  // Anchors in the markup: token, aria-label, data-time, position.
  const anchors = [];
  const anchorRe = /<a\b([^>]*)>/gi;
  for (let m; (m = anchorRe.exec(html));) {
    const attrs = m[1];
    const t = TOKEN_RE.exec(attrs);
    if (!t) continue;
    const label = /aria-label="([^"]*)"/.exec(attrs);
    const time = /data-time="(\d+)"/.exec(attrs);
    anchors.push({ token: t[1], index: m.index, end: m.index + m[0].length, label: label ? unescapeHtml(label[1]).replace(/\s+/g, ' ').trim() : '', time: time ? time[1] : null });
  }

  // adjacent: link-preview comment right after the anchor.
  const labels = new Map();
  for (const a of anchors) {
    if (a.label.length >= 20 && !/link preview/i.test(a.label) && a.label.length > (labels.get(a.token) || '').length) labels.set(a.token, a.label);
  }
  for (const a of anchors) {
    const cur = resolved.get(a.token);
    if (cur && RANK[cur.kind] >= RANK.adjacent) continue;
    const close = html.indexOf('</a>', a.end);
    if (close < 0) continue;
    const after = html.slice(close + 4, close + 400);
    const m = /^(?:\s|<\/?(?!a\b)[^>]*>){0,3}<!--[^|<]*\|\|\|\s*\[\s*\[\s*(?:"|&quot;)(https?:\/\/[^"&]+)/.exec(after);
    if (!m) continue;
    const hit = classify(m[1], 'adjacent', true);
    if (!hit || hit.kind === 'domain') continue;
    const host = new URL(hit.url).hostname;
    if (cur && cur.host !== host) continue;
    resolved.set(a.token, { url: hit.url, kind: 'adjacent', host, title: cur?.title || labels.get(a.token) || null });
  }

  // inferred: domain-only record + resolved record with same host and title.
  const normTitle = (t) => (t || '').toLowerCase().replace(/\s*(\.\.\.|…)\s*$/, '').replace(/\s+/g, ' ').trim();
  const sameTitle = (x, y) => { x = normTitle(x); y = normTitle(y); return x.length >= 25 && y.length >= 25 && (x.includes(y) || y.includes(x)); };
  const full = [...resolved.values()].filter((r) => RANK[r.kind] >= RANK.embedded && r.title);
  for (const [token, r] of resolved) {
    if (r.kind !== 'domain' || !r.title) continue;
    const match = full.find((f) => f.host === r.host && sameTitle(f.title, r.title));
    if (match) resolved.set(token, { ...r, url: match.url, kind: 'inferred' });
  }

  // derived: key moments = nearest preceding resolved video link + t=<data-time>.
  for (const a of anchors) {
    if (!a.time || resolved.has(a.token)) continue;
    let parent = null;
    for (let i = anchors.indexOf(a) - 1; i >= 0 && a.index - anchors[i].index < 30000; i--) {
      const r = !anchors[i].time && resolved.get(anchors[i].token);
      if (r && RANK[r.kind] >= RANK.embedded && /(^|\.)youtube\.com$/.test(r.host)) { parent = r; break; }
    }
    if (!parent) continue;
    const u = new URL(parent.url);
    u.searchParams.set('t', a.time);
    resolved.set(a.token, { url: u.href, kind: 'derived', host: u.hostname, title: null });
  }

  const seen = new Set(html.match(TOKEN_RE_G)?.map((s) => TOKEN_RE.exec(s)[1]) || []);
  const kinds = {};
  for (const r of resolved.values()) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  const tokens = new Map();
  for (const [t, r] of resolved) tokens.set(t, { url: r.url, kind: r.kind, host: r.host });
  return { tokens, stats: { tokensInInput: seen.size, resolved: tokens.size, kinds } };
}

module.exports = { resolve };

if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const csv = args.includes('--csv');
  const files = args.filter((a) => a !== '--csv');
  if (!files.length) { console.error('usage: node resolve.js [--csv] page.html [async.txt ...]'); process.exit(1); }
  const { tokens, stats } = resolve(files.map((f) => fs.readFileSync(f, 'utf8')));
  if (csv) {
    console.log('token,url,kind');
    for (const [t, r] of tokens) console.log(`${t},${r.url},${r.kind}`);
  } else {
    console.log(JSON.stringify({ stats, tokens: Object.fromEntries(tokens) }, null, 2));
  }
}
