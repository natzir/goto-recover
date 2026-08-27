(() => {
  "use strict";
  const NS = "__gotoRecover";
  const settings = Object.assign({
    domainFallback: false
  }, window[NS + "Options"] || {});
  if (window[NS]) {
    window[NS].run(settings);
    return;
  }
  const TOKEN_RE = /\/goto\?url(?:=|\\u003d)([A-Za-z0-9_-]{20,})/;
  const REQ_RE = /[?&]req(?:=|\\u003d)([A-Za-z0-9_-]{20,})/;
  const SKIP_HOST = /(^|\.)(google\.[a-z.]+|gstatic\.com|googleapis\.com|googleusercontent\.com|googleadservices\.com|googlesyndication\.com|doubleclick\.net|ytimg\.com|w3\.org|schema\.org)$/i;
  const ENTITY = {
    "&quot;": '"',
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&#39;": "'"
  };
  const RANK = {
    exact: 5,
    embedded: 4,
    adjacent: 4,
    inferred: 3,
    derived: 3,
    domain: 1
  };
  const minRewriteRank = () => settings.domainFallback ? RANK.domain : RANK.derived;
  function protoField1(b64) {
    try {
      const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
      if (bin.charCodeAt(0) !== 10) return null;
      let len = 0, shift = 0, i = 1, byte;
      do {
        byte = bin.charCodeAt(i++);
        len |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      return (new TextDecoder).decode(Uint8Array.from(bin.slice(i, i + len), c => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }
  function classify(raw, kind, demoteBareRoot) {
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol) || SKIP_HOST.test(u.hostname)) return null;
      const bare = u.pathname === "/" && !u.search;
      return {
        url: u.href,
        kind: bare && demoteBareRoot ? "domain" : kind
      };
    } catch {
      return null;
    }
  }
  function inspect(str) {
    const out = {
      token: null,
      cands: [],
      text: null
    };
    const t = TOKEN_RE.exec(str);
    if (t) out.token = t[1];
    const r = REQ_RE.exec(str);
    if (r) {
      const target = protoField1(r[1]);
      if (target && /^https?:\/\//.test(target)) {
        const c = classify(target, "exact", false);
        if (c) out.cands.push(c);
      }
    }
    if (/^https?:\/\/\S+$/.test(str)) {
      const c = classify(str, "embedded", true);
      if (c) out.cands.push(c);
    }
    if (!t && !r && str.length >= 20 && !/https?:\/\//.test(str)) out.text = str;
    return out;
  }
  function balancedJson(text, from) {
    const open = text[from];
    if (open !== "{" && open !== "[") return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true; else if (ch === "{" || ch === "[") depth++; else if (ch === "}" || ch === "]") {
        if (--depth === 0) {
          try {
            return JSON.parse(text.slice(from, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
  function* sources() {
    for (const s of document.scripts) {
      const text = s.textContent;
      if (!text.includes("/goto")) continue;
      const i = text.indexOf("var m={");
      if (i < 0) continue;
      const data = balancedJson(text, i + 6);
      if (data) yield data;
    }
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
    for (let n; n = walker.nextNode(); ) {
      const raw = n.nodeValue;
      const sep = raw.indexOf("|||");
      if (sep < 0 || !raw.includes("/goto")) continue;
      const json = raw.slice(sep + 3).replace(/&quot;|&amp;|&lt;|&gt;|&#39;/g, e => ENTITY[e]);
      const data = balancedJson(json, json.search(/[[{]/));
      if (data) yield data;
    }
  }
  const resolved = new Map;
  function offer(token, cands, texts) {
    if (!cands.size) return;
    const top = [ ...cands.values() ].sort((a, b) => RANK[b.kind] - RANK[a.kind] || b.n - a.n)[0];
    const cur = resolved.get(token);
    if (cur && RANK[cur.kind] >= RANK[top.kind]) return;
    resolved.set(token, {
      url: top.url,
      kind: top.kind,
      host: new URL(top.url).hostname,
      title: texts[0] || cur?.title || null
    });
  }
  function walk(value) {
    if (typeof value === "string") {
      const r = inspect(value);
      return {
        tokens: new Set(r.token ? [ r.token ] : []),
        cands: new Map(r.cands.map(c => [ c.url, {
          ...c,
          n: 1
        } ])),
        texts: r.text ? [ r.text ] : []
      };
    }
    if (!value || typeof value !== "object") return {
      tokens: new Set,
      cands: new Map,
      texts: []
    };
    const tokens = new Set, cands = new Map, texts = [];
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const r = walk(child);
      for (const t of r.tokens) tokens.add(t);
      for (const [url, c] of r.cands) {
        const e = cands.get(url);
        if (e) e.n += c.n; else cands.set(url, {
          ...c
        });
      }
      if (texts.length < 3) texts.push(...r.texts.slice(0, 3 - texts.length));
    }
    if (tokens.size === 1) offer(tokens.values().next().value, cands, texts);
    return {
      tokens: tokens,
      cands: cands,
      texts: texts
    };
  }
  const normTitle = t => (t || "").toLowerCase().replace(/\s*(\.\.\.|…)\s*$/, "").replace(/\s+/g, " ").trim();
  const sameTitle = (a, b) => {
    a = normTitle(a);
    b = normTitle(b);
    return a.length >= 25 && b.length >= 25 && (a.includes(b) || b.includes(a));
  };
  function inferFromSiblings() {
    const full = [ ...resolved.values() ].filter(r => RANK[r.kind] >= RANK.embedded && r.title);
    for (const [token, r] of resolved) {
      if (r.kind !== "domain" || !r.title) continue;
      const match = full.find(f => f.host === r.host && sameTitle(f.title, r.title));
      if (match) resolved.set(token, {
        ...r,
        url: match.url,
        kind: "inferred"
      });
    }
  }
  function deriveKeyMoments() {
    for (const a of document.querySelectorAll('a[data-time][href*="/goto?url="]')) {
      const token = tokenOf(a);
      if (!token || resolved.has(token)) continue;
      for (let el = a.parentElement; el && el !== document.body; el = el.parentElement) {
        const parent = [ ...el.querySelectorAll('a[href*="/goto?url="]:not([data-time]), a[data-goto-token]:not([data-time])') ].map(x => resolved.get(tokenOf(x))).find(r => r && RANK[r.kind] >= RANK.embedded);
        if (!parent) continue;
        const u = new URL(parent.url);
        u.searchParams.set("t", a.getAttribute("data-time"));
        resolved.set(token, {
          url: u.href,
          kind: "derived",
          host: u.hostname,
          title: null
        });
        break;
      }
    }
  }
  function firstUrlOfComment(node) {
    if (!node || node.nodeType !== Node.COMMENT_NODE) return null;
    const v = node.nodeValue;
    const sep = v.indexOf("|||");
    if (sep < 0) return null;
    const json = v.slice(sep + 3, sep + 400).replace(/&quot;|&amp;/g, e => ENTITY[e]);
    const m = /^\s*\[\s*\[\s*"(https?:\/\/[^"]+)"/.exec(json);
    return m ? classify(m[1], "adjacent", true) : null;
  }
  function pairAdjacentComments() {
    const labels = new Map;
    const anchors = [ ...document.querySelectorAll('a[href*="/goto?url="], a[data-goto-token]') ];
    for (const a of anchors) {
      const token = tokenOf(a);
      const label = (a.getAttribute("aria-label") || a.textContent || "").replace(/\s+/g, " ").trim();
      if (token && label.length >= 20 && !/link preview/i.test(label) && label.length > (labels.get(token) || "").length) labels.set(token, label);
    }
    for (const a of anchors) {
      const token = tokenOf(a);
      const cur = token && resolved.get(token);
      if (!token || cur && RANK[cur.kind] >= RANK.adjacent) continue;
      let hit = null;
      for (let n = a.nextSibling, i = 0; n && i < 3 && !hit; n = n.nextSibling, i++) hit = firstUrlOfComment(n);
      if (!hit || hit.kind === "domain") continue;
      const host = new URL(hit.url).hostname;
      if (cur && cur.host !== host) continue;
      resolved.set(token, {
        url: hit.url,
        kind: "adjacent",
        host: host,
        title: cur?.title || labels.get(token) || null
      });
    }
  }
  function tokenOf(a) {
    if (a.dataset.gotoToken) return a.dataset.gotoToken;
    const m = TOKEN_RE.exec(a.getAttribute("href") || "");
    return m ? m[1] : null;
  }
  function rewrite() {
    let n = 0;
    for (const a of document.querySelectorAll('a[href*="/goto?url="]')) {
      const token = tokenOf(a);
      const r = token && resolved.get(token);
      if (!r || RANK[r.kind] < minRewriteRank()) continue;
      a.dataset.gotoToken = token;
      a.dataset.gotoKind = r.kind;
      a.href = r.url;
      a.removeAttribute("ping");
      n++;
    }
    return n;
  }
  function run(options) {
    Object.assign(settings, options || {});
    const t0 = performance.now();
    resolved.clear();
    for (const data of sources()) walk(data);
    pairAdjacentComments();
    inferFromSiblings();
    deriveKeyMoments();
    const rewritten = rewrite();
    const left = {
      ads: 0,
      domainOnly: 0,
      noData: 0
    };
    for (const a of document.querySelectorAll('a[href*="/goto?url="]')) {
      const r = resolved.get(tokenOf(a));
      if (a.closest("[data-text-ad], [data-pcu], [data-rw]")) left.ads++; else if (r) left.domainOnly++; else left.noData++;
    }
    const pending = left.ads + left.domainOnly + left.noData;
    const toRoot = settings.domainFallback ? document.querySelectorAll('a[data-goto-kind="domain"]').length : 0;
    console.info(`goto-recover: ${rewritten} links rewritten` + (toRoot ? ` (${toRoot} of them to the site root only)` : "") + `, ${pending} left (${left.ads} ads, ${left.domainOnly} with only the domain in the page, ${left.noData} with no data in the page) ` + `in ${Math.round(performance.now() - t0)} ms`);
    return {
      rewritten: rewritten,
      toRoot: toRoot,
      pending: pending,
      left: left
    };
  }
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.querySelector('a[href*="/goto?url="]')) run();
    }, 400);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  window[NS] = {
    run: run,
    stop: () => observer.disconnect(),
    resolved: resolved
  };
  run();
})();
