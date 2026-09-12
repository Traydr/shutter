// Shutter admin design trials, set 3. Fresh start: calm, monochrome, favicon blue as the only accent. CSS-only.
import { writeFileSync } from "node:fs";

const NOW = Date.parse("2026-09-13T09:30:00Z");
const EDGE = "shutter-edge.traydr.dev";
const SPACES = [
  {
    id: "ernesta",
    cls: "public",
    active: true,
    updatedAt: "2026-09-12T08:42:13Z",
    createdAt: "2026-08-13T18:11:08Z",
    qualities: [30, 50, 75],
    dq: 75,
    origins: [
      "https://8w0z32yftd.ufs.sh/f",
      "https://rrsku8h9ue.ufs.sh/f",
      "https://ernesta-images-h594sc5xb.t3.storageapi.dev",
      "https://ernesta-images-gkewpgekhi.t3.storageapi.dev",
    ],
    sources: [
      {
        id: "uploadthing",
        kind: "template",
        to: "https://{project}.ufs.sh/f/{file}",
        ph: { project: ["8w0z32yftd", "rrsku8h9ue"], file: null },
      },
      {
        id: "media",
        kind: "s3",
        to: "ernesta-images-gkewpgekhi.t3.storageapi.dev/{key}",
        cred: "AKIA3QX7…R2ML",
      },
      {
        id: "media-dev",
        kind: "s3",
        to: "ernesta-images-h594sc5xb.t3.storageapi.dev/{key}",
        cred: null,
      },
    ],
    tokens: [
      { label: "production deploy", used: "2026-09-13T09:14:03Z" },
      { label: "preview (vercel)", used: "2026-09-12T22:40:51Z" },
    ],
    revoked: [{ label: "local dev", at: "2026-08-21T09:00:00Z" }],
    keys: [
      {
        id: "k-2026-09-rotation-candidate-for-ernesta-production-do-not-delete",
        since: "2026-09-11T16:05:00Z",
      },
      { id: "k-2026-08", since: "2026-08-13T18:30:00Z" },
    ],
    disabledKeys: [{ id: "k-2026-07-bootstrap", at: "2026-08-14T10:00:00Z" }],
    uncovered: [],
  },
  {
    id: "pane-view",
    cls: "private",
    active: true,
    updatedAt: "2026-09-12T00:03:39Z",
    createdAt: "2026-08-13T18:49:19Z",
    qualities: [30, 75, 80],
    dq: 75,
    origins: ["https://t3.storageapi.dev/balanced-wrap-ocyiwwexhao"],
    sources: [
      {
        id: "originals",
        kind: "s3",
        to: "t3.storageapi.dev/balanced-wrap-ocyiwwexhao/originals/sha256/{shard_a}/{shard_b}/{object}",
        cred: "AKIA7Q…W9PX",
      },
    ],
    tokens: [{ label: "railway production", used: "2026-09-13T09:27:12Z" }],
    revoked: [],
    keys: [{ id: "k-2026-08", since: "2026-08-13T18:55:00Z" }],
    disabledKeys: [],
    uncovered: [],
  },
  {
    id: "latch-works",
    cls: "private",
    active: true,
    updatedAt: "2026-09-11T20:31:45Z",
    createdAt: "2026-09-11T20:14:02Z",
    qualities: [60, 75, 90],
    dq: 75,
    origins: ["https://latch-works-uploads.t3.storageapi.dev", "https://cdn.latch.works/assets"],
    sources: [
      {
        id: "assets",
        kind: "template",
        to: "https://cdn.latch.works/assets/{collection}/{file}",
        ph: { collection: ["site", "docs", "press-kit"], file: null },
      },
    ],
    tokens: [{ label: "latch-works api", used: null }],
    revoked: [],
    keys: [],
    disabledKeys: [],
    uncovered: ["https://latch-works-uploads.t3.storageapi.dev"],
  },
  {
    id: "probe-space",
    cls: "private",
    active: false,
    updatedAt: "2026-08-13T18:08:39Z",
    createdAt: "2026-08-13T18:03:12Z",
    qualities: [75],
    dq: 75,
    origins: ["https://sources.example.com/probe"],
    sources: [],
    tokens: [],
    revoked: [],
    keys: [],
    disabledKeys: [],
    uncovered: [],
  },
];
const E = SPACES[0];
const SRC = E.sources[0];

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
function ago(iso, long = false) {
  const d = (NOW - Date.parse(iso)) / 1000;
  const [n, u] =
    d < 3600
      ? [Math.max(1, Math.round(d / 60)), "minute"]
      : d < 86400
        ? [Math.round(d / 3600), "hour"]
        : [Math.round(d / 86400), "day"];
  return long ? `${n} ${u}${n === 1 ? "" : "s"} ago` : `${n}${u[0]} ago`;
}
const date = (iso) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
/** URLs with placeholders: plain mono, placeholders in the accent colour, no boxes. */
const u = (s) =>
  `<span class="mono">${esc(s).replace(/\{([a-z_]+)\}/g, '<b class="ph">{$1}</b>')}</span>`;
const host = (o) => o.replace(/^https:\/\//, "");
const LOGO = (s) =>
  `<svg viewBox="0 0 64 64" aria-hidden="true" width="${s}" height="${s}"><polygon points="32,4 57,18 50,22 32,12" fill="#258FE0"/><polygon points="57,18 57,46 50,42 50,22" fill="#4268D4"/><polygon points="57,46 32,60 32,52 50,42" fill="#16366B"/><polygon points="32,60 7,46 14,42 32,52" fill="#16366B"/><polygon points="7,46 7,18 14,22 14,42" fill="#4268D4"/><polygon points="7,18 32,4 32,12 14,22" fill="#258FE0"/><g transform="translate(13.12 12.16) scale(0.59 0.62)"><path d="M32 5 48 16v9l-9 9-7-7 7-7-7-5-7 5v5L16 16Z" fill="#258FE0"/><path d="M16 19 48 40v9L32 59 16 48v-9l9-9 7 7-7 7 7 5 7-5v-1L16 28Z" fill="#16366B"/><path d="M16 19.0 48 40.0v9L16 28.0Z" fill="#4268D4"/></g></svg>`;
const I = {
  copy: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M2.5 10.5v-7a1 1 0 0 1 1-1h7"/></svg>`,
  chev: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>`,
  arrow: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 8h11M9.5 4l4 4-4 4"/></svg>`,
  check: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 8.5 3 3 7-7"/></svg>`,
  search: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>`,
  sun: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>`,
  moon: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/></svg>`,
  x: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 4 8 8M12 4l-8 8"/></svg>`,
  plus: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3v10M3 8h10"/></svg>`,
};

// Plain-language state of a Space. One sentence, one tone. No counters.
function state(s) {
  if (!s.active) return { tone: "off", text: "Decommissioned" };
  if (s.uncovered.length)
    return { tone: "warn", text: `${host(s.uncovered[0])} isn't deployed yet` };
  if (s.keys.length === 0) return { tone: "warn", text: "No signing key yet" };
  if (s.sources.some((x) => x.kind === "s3" && !x.cred))
    return {
      tone: "warn",
      text: `${s.sources.find((x) => x.kind === "s3" && !x.cred).id} has no credential`,
    };
  if (s.keys.length > 1) return { tone: "warn", text: "Key rotation in progress" };
  return { tone: "ok", text: "Ready" };
}
const dot = (tone) => `<i class="dot ${tone}"></i>`;

const BASE = `
*{box-sizing:border-box}
:root{
  --bg:#000;--s1:#0a0a0a;--s2:#111;--s3:#1a1a1a;--line:#232323;--line2:#333;--line3:#444;
  --fg:#ededed;--fg2:#a1a1a1;--fg3:#6b6b6b;
  --accent:#258FE0;--accent-fg:#63b3f2;--accent-bg:rgba(37,143,224,.12);
  --warn:#f5a623;--warn-fg:#f5b950;--red:#ff5c5c;--red-fg:#ff7a7a;--red-bg:rgba(255,92,92,.1);
  --btn-fg:#000;--btn-bg:#fff;
  --font:-apple-system,BlinkMacSystemFont,"Inter","Geist","Segoe UI",system-ui,sans-serif;
  --mono:"SF Mono","Geist Mono","JetBrains Mono",ui-monospace,Menlo,monospace;
}
body:has(#th-light:checked){
  --bg:#fff;--s1:#fafafa;--s2:#f4f4f4;--s3:#ececec;--line:#eaeaea;--line2:#d9d9d9;--line3:#c4c4c4;
  --fg:#171717;--fg2:#666;--fg3:#999;
  --accent:#1b7fd3;--accent-fg:#0b66b8;--accent-bg:rgba(37,143,224,.1);
  --warn:#b7791f;--warn-fg:#9a6512;--red:#e5484d;--red-fg:#c62f34;--red-bg:rgba(229,72,77,.08);
  --btn-fg:#fff;--btn-bg:#171717;
}
html{color-scheme:dark}body:has(#th-light:checked){color-scheme:light}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}h1,h2,h3,p,ul,dl,dd{margin:0}ul{padding:0;list-style:none}
button,input,select,textarea{font:inherit;color:inherit}
.mono{font-family:var(--mono);font-size:13px}
.ph{font-weight:500;color:var(--accent-fg);white-space:nowrap}
.muted{color:var(--fg2)}.faint{color:var(--fg3)}
.warn{color:var(--warn-fg)}.red{color:var(--red-fg)}.link{color:var(--accent-fg)}.link:hover{text-decoration:underline}
.wrap{overflow-wrap:anywhere}.trunc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.row{display:flex;align-items:center;gap:10px;min-width:0}.grow{flex:1}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none}
.dot.warn{background:var(--warn)}.dot.off{background:var(--line3)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 14px;border-radius:6px;border:1px solid var(--line2);background:var(--bg);color:var(--fg);font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--s2);border-color:var(--line3)}
.btn.primary{background:var(--btn-bg);color:var(--btn-fg);border-color:var(--btn-bg)}.btn.primary:hover{opacity:.88}
.btn.sm{height:30px;padding:0 10px;font-size:13px}
.btn.ghost{border-color:transparent;background:transparent;color:var(--fg2)}.btn.ghost:hover{color:var(--fg);background:var(--s2)}
.btn.danger{color:var(--red-fg);border-color:var(--line2)}.btn.danger:hover{background:var(--red-bg);border-color:var(--red)}
.btn.icon{width:32px;height:32px;padding:0;border-color:transparent;background:transparent;color:var(--fg2)}.btn.icon:hover{background:var(--s2);color:var(--fg)}
.input,.textarea{width:100%;min-width:0;height:40px;padding:0 12px;border-radius:6px;border:1px solid var(--line2);background:var(--bg);color:var(--fg);font-size:14px;outline:none}
.input:hover,.textarea:hover{border-color:var(--line3)}
.input:focus,.textarea:focus{border-color:var(--fg3);box-shadow:0 0 0 3px var(--s3)}
.input.mono,.textarea.mono{font-family:var(--mono);font-size:13.5px}
.input:disabled{color:var(--fg2);background:var(--s1)}
.textarea{height:auto;min-height:0;padding:10px 12px;line-height:1.55;resize:vertical;field-sizing:content}
.field{display:grid;gap:8px}
.field>label{font-size:14px;font-weight:500}
.field>p{font-size:13px;color:var(--fg2)}
.h1{font-size:28px;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.h2{font-size:17px;font-weight:600;letter-spacing:-.01em}
.card{background:var(--s1);border:1px solid var(--line);border-radius:10px;min-width:0;overflow:hidden}
.sep{height:1px;background:var(--line)}
.copyline{display:flex;align-items:center;gap:10px;min-width:0;padding:10px 6px 10px 14px;border:1px solid var(--line2);border-radius:8px;background:var(--bg)}
.copyline .mono{flex:1;overflow-wrap:anywhere;font-size:14px}
`;

// ---------- studio ----------
const OPTS = [
  {
    n: 1,
    name: "Sites",
    blurb: "A Space is a site. Cards, tabs, and the delivery URL is the hero.",
  },
  {
    n: 2,
    name: "Routes",
    blurb: "A Space is a set of routes: delivery pattern on the left, destination on the right.",
  },
  {
    n: 3,
    name: "Document",
    blurb: "A Space is a readable page. One narrow column, prose, text-link actions.",
  },
  {
    n: 4,
    name: "Setup",
    blurb: "A Space is three steps: where images live, how your app signs in, deploy.",
  },
  {
    n: 5,
    name: "Records",
    blurb: "Everything is one records table across Spaces, edited in place.",
  },
];
const PAGES = [
  ["spaces", "Spaces"],
  ["space", "ernesta"],
  ["source", "ernesta / uploadthing"],
];
const STUDIO = `
.studio{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:20px;height:40px;padding:0 16px;background:#0b0b0b;border-bottom:1px solid #222;color:#8a8a8a;font-size:12.5px}
.studio .name{color:#ededed;font-weight:600;letter-spacing:.02em;display:flex;align-items:center;gap:8px}
.studio .g{display:flex;gap:2px}
.studio label{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:5px;cursor:pointer;white-space:nowrap}
.studio label:hover{color:#ededed}
.studio input{position:absolute;opacity:0;pointer-events:none}
.studio label b{font-weight:600;color:#666}
${OPTS.map((o) => `body:has(#op-${o.n}:checked) label[for="op-${o.n}"]`).join(",")}{background:#ededed;color:#000}
${OPTS.map((o) => `body:has(#op-${o.n}:checked) label[for="op-${o.n}"] b`).join(",")}{color:#000}
${PAGES.map(([p]) => `body:has(#pg-${p}:checked) label[for="pg-${p}"]`).join(",")}{background:#222;color:#fff}
body:has(#th-dark:checked) label[for="th-dark"],body:has(#th-light:checked) label[for="th-light"]{background:#222;color:#fff}
.studio .blurb{display:none;margin-left:auto;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
${OPTS.map((o) => `body:has(#op-${o.n}:checked) .blurb-${o.n}`).join(",")}{display:block}
.screen{display:none;min-height:calc(100vh - 40px)}
${OPTS.flatMap((o) => PAGES.map(([p]) => `body:has(#op-${o.n}:checked):has(#pg-${p}:checked) #s-${o.n}-${p}`)).join(",")}{display:block}
@media (max-width:1000px){.studio .blurb{display:none!important}}
`;
const studio = () => `<div class="studio"><span class="name">${LOGO(16)} Trials · set 3</span>
<span class="g">${OPTS.map((o) => `<input type="radio" name="op" id="op-${o.n}"${o.n === 1 ? " checked" : ""}><label for="op-${o.n}"><b>${o.n}</b>${o.name}</label>`).join("")}</span>
<span class="g">${PAGES.map(([p, l], i) => `<input type="radio" name="pg" id="pg-${p}"${i === 0 ? " checked" : ""}><label for="pg-${p}">${l}</label>`).join("")}</span>
<span class="g"><input type="radio" name="th" id="th-dark" checked><label for="th-dark">${I.moon}</label><input type="radio" name="th" id="th-light"><label for="th-light">${I.sun}</label></span>
${OPTS.map((o) => `<span class="blurb blurb-${o.n}">${o.blurb}</span>`).join("")}</div>`;

// shared top navigation (Vercel-like: logo / breadcrumb, sign out)
const nav = (crumbs = []) =>
  `<header class="nav"><a href="#" class="row" style="gap:10px">${LOGO(22)}<span style="font-weight:600">Shutter</span></a>${crumbs.map((c) => `<span class="slash">/</span><a href="#" class="crumb">${c}</a>`).join("")}<span class="grow"></span><a class="btn ghost sm" href="#">Sign out</a></header>`;
const NAV_CSS = `
.nav{display:flex;align-items:center;gap:12px;height:56px;padding:0 24px;border-bottom:1px solid var(--line)}
.nav .slash{color:var(--line3);font-size:20px;font-weight:200}
.nav .crumb{font-family:var(--mono);font-size:13.5px;font-weight:500}
`;

// =====================================================================
// 1 — Sites
// =====================================================================
const CSS1 = `
.o1 .tabs{display:flex;gap:4px;padding:0 24px;border-bottom:1px solid var(--line)}
.o1 .tabs a{position:relative;padding:12px 8px 14px;color:var(--fg2);font-size:14px}
.o1 .tabs a.on{color:var(--fg)}.o1 .tabs a.on::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--fg)}
.o1 .tabs a:hover{color:var(--fg)}
.o1 .page{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
.o1 .head{display:flex;align-items:center;gap:16px;margin-bottom:32px}
.o1 .search{display:flex;align-items:center;gap:10px;flex:1;max-width:420px;height:40px;padding:0 12px;border:1px solid var(--line2);border-radius:6px;color:var(--fg3)}
.o1 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
.o1 .site{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;padding:22px 24px;border:1px solid var(--line);border-radius:10px;background:var(--s1);transition:border-color .12s}
.o1 .site:hover{border-color:var(--line3)}
.o1 .site.off{opacity:.55}
.o1 .site .name{font-size:17px;font-weight:600;letter-spacing:-.01em}
.o1 .site .url{font-family:var(--mono);font-size:12.5px;color:var(--fg2);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.o1 .site .foot{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg2);min-width:0}
.o1 .site .foot .st{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.o1 .site .foot .t{white-space:nowrap}
.o1 .edge{margin-top:40px;display:flex;align-items:center;gap:10px;font-size:13.5px;color:var(--fg2)}
.o1 .title{display:flex;align-items:baseline;gap:14px;margin-bottom:28px}
.o1 .title .h1{font-family:var(--mono)}
.o1 .hero{padding:24px;display:grid;gap:14px}
.o1 .hero .lbl{font-size:13px;color:var(--fg2)}
.o1 .hero .big{font-family:var(--mono);font-size:18px;line-height:1.5;overflow-wrap:anywhere}
.o1 .hero .foot{display:flex;gap:16px;align-items:center;font-size:13px;color:var(--fg2);padding-top:14px;border-top:1px solid var(--line)}
.o1 .two{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
@media (max-width:860px){.o1 .two{grid-template-columns:1fr}}
.o1 .blk{padding:22px 24px;display:grid;gap:16px;align-content:start}
.o1 .blk .h{display:flex;align-items:center;gap:10px}
.o1 .blk .h .h2{flex:1}
.o1 .it{display:grid;gap:3px;padding:12px 0;border-top:1px solid var(--line)}
.o1 .it .n{font-weight:500;display:flex;align-items:center;gap:10px}
.o1 .it .d{font-size:13px;color:var(--fg2);overflow-wrap:anywhere}
.o1 .form{max-width:680px;margin:0 auto;padding:40px 24px 80px;display:grid;gap:36px}
.o1 .form .card{padding:24px;display:grid;gap:22px}
.o1 .form .card .f{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--fg2)}
.o1 .pv{padding:16px;border-radius:8px;background:var(--bg);border:1px solid var(--line);font-family:var(--mono);font-size:13.5px;line-height:1.6;overflow-wrap:anywhere}
.o1 .kv{display:grid;grid-template-columns:140px 1fr;gap:10px 16px;align-items:center}
.o1 .kv .k{font-size:13px;color:var(--fg2)}
`;
const o1Tabs = (on) =>
  `<nav class="tabs">${["Overview", "Sources", "Access", "Settings"].map((t) => `<a href="#" class="${t === on ? "on" : ""}">${t}</a>`).join("")}</nav>`;
function o1Spaces() {
  return `<div class="o1">${nav()}<div class="page">
<div class="head"><h1 class="h1">Spaces</h1><span class="grow"></span><span class="search">${I.search} Search…</span><a class="btn primary" href="#">Add Space</a></div>
<div class="grid">${SPACES.map((s) => {
    const st = state(s);
    return `<a class="site${s.active ? "" : " off"}" href="#"><div><div class="name">${s.id}</div><div class="url">${EDGE}/v2/${s.id}/…</div></div><div class="muted" style="font-size:13.5px">${s.cls[0].toUpperCase() + s.cls.slice(1)} · ${s.sources.length === 1 ? "1 source" : `${s.sources.length} sources`} · ${s.tokens.length === 1 ? "1 app" : `${s.tokens.length} apps`}</div><div class="foot">${dot(st.tone)}<span class="st ${st.tone === "warn" ? "warn" : ""}" title="${st.text}">${st.text}</span><span class="t">${ago(s.updatedAt)}</span></div></a>`;
  }).join("")}</div>
<div class="edge">${dot("ok")} The Edge is serving your latest changes.</div>
</div></div>`;
}
function o1Space() {
  const s = E;
  return `<div class="o1">${nav(["ernesta"])}${o1Tabs("Overview")}<div class="page">
<div class="title"><h1 class="h1">ernesta</h1><span class="muted">Public · created ${date(s.createdAt)}</span><span class="grow"></span><a class="btn" href="#">Add source</a></div>
<div class="card hero"><span class="lbl">Delivery URL</span><div class="big">https://${EDGE}/v2/ernesta/<b class="ph">{source}</b>/<b class="ph">{reference}</b>?w=1200&amp;q=75</div><div class="foot"><span>Qualities 30, 50 and 75 · default 75</span><span class="grow"></span><a class="btn sm" href="#">${I.copy} Copy</a></div></div>
<div class="two">
  <div class="card blk"><div class="h"><h2 class="h2">Sources</h2><a class="link" href="#" style="font-size:13px">See all</a></div>
    ${s.sources.map((x) => `<a class="it" href="#"><span class="n">${x.id}<span class="faint" style="font-weight:400;font-size:13px">${x.kind === "s3" ? "S3 bucket" : "URL template"}</span></span><span class="d">${u(x.to)}</span>${x.kind === "s3" && !x.cred ? `<span class="d warn">No credential yet</span>` : ""}</a>`).join("")}</div>
  <div class="card blk"><div class="h"><h2 class="h2">Access</h2><a class="link" href="#" style="font-size:13px">Manage</a></div>
    <a class="it" href="#"><span class="n">API tokens</span><span class="d">production deploy, used ${ago(s.tokens[0].used, true)} · preview (vercel), used ${ago(s.tokens[1].used, true)}</span></a>
    <a class="it" href="#"><span class="n">Signing keys ${dot("warn")}</span><span class="d">Two keys accepted. Once your app mints with the new one, disable <span class="mono">k-2026-08</span>.</span></a>
    <a class="it" href="#"><span class="n">Where images may come from</span><span class="d">${s.origins.map(host).join(" · ")}</span><span class="d">All four are deployed.</span></a></div>
</div>
</div></div>`;
}
function o1Source() {
  return `<div class="o1">${nav(["ernesta"])}${o1Tabs("Sources")}<div class="form">
<div><a class="link" href="#" style="font-size:13px">← Sources</a><h1 class="h1" style="margin-top:8px;font-family:var(--mono)">uploadthing</h1><p class="muted" style="margin-top:6px">URL template · delivering since ${date("2026-08-13T18:11:08Z")}</p></div>
<div class="card">
  <div class="field"><label>Template</label><input class="input mono" value="https://{project}.ufs.sh/f/{file}"><p>Each <span class="mono">{name}</span> is one path segment or one hostname label. Expansions must stay inside the Space's allowed origins.</p></div>
  <div class="field"><label>Allowed values for <span class="mono">{project}</span></label><input class="input mono" value="8w0z32yftd, rrsku8h9ue"><p>Required, because it's part of the hostname.</p></div>
  <div class="field"><label>Allowed values for <span class="mono">{file}</span></label><input class="input mono" placeholder="Any value"><p>Optional for a path segment.</p></div>
  <div class="f"><span>Requests will look like <span class="mono">…/v2/ernesta/uploadthing/<b class="ph">{project}</b>/<b class="ph">{file}</b></span></span><button class="btn primary">Save</button></div>
</div>
<div class="card" style="display:grid;gap:16px;padding:24px"><div><h2 class="h2">Try it</h2><p class="muted" style="margin-top:4px">Resolves a reference the way a real request would and fetches one byte.</p></div>
  <div class="row"><input class="input mono" value="8w0z32yftd/0RT8d5Yx2Kq9WcVnFq1mL.jpg"><button class="btn">Run</button></div>
  <div class="pv">${I.check} Fetched from <b>8w0z32yftd.ufs.sh</b> · 206 · image/jpeg · 1.28 MB · 212 ms</div></div>
<p class="muted" style="font-size:13px">Need to retire this source? <a class="link" href="#">Remove uploadthing</a>. Cached images stay until a purge.</p>
</div></div>`;
}

// =====================================================================
// 2 — Routes
// =====================================================================
const CSS2 = `
.o2 .page{max-width:1120px;margin:0 auto;padding:40px 24px 80px}
.o2 .head{display:flex;align-items:center;gap:16px;margin-bottom:28px}
.o2 .list .r{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:center;padding:20px 4px;border-top:1px solid var(--line)}
.o2 .list .r:last-child{border-bottom:1px solid var(--line)}
.o2 .list .r:hover{background:var(--s1)}
.o2 .list .n{font-size:16px;font-weight:600;letter-spacing:-.01em}
.o2 .list .base{font-family:var(--mono);font-size:13px;color:var(--fg2);margin-top:4px}
.o2 .list .rt{text-align:right;font-size:13px;color:var(--fg2);display:grid;gap:4px;justify-items:end}
.o2 .list .off{opacity:.5}
.o2 .title{display:flex;align-items:baseline;gap:14px;margin-bottom:8px}
.o2 .title .h1{font-family:var(--mono)}
.o2 .sub{color:var(--fg2);margin-bottom:36px}
.o2 .sec{margin-bottom:44px}
.o2 .sec .h{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.o2 .sec .h .h2{flex:1}
.o2 .routes{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.o2 .route{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr) auto;gap:16px;align-items:center;padding:16px 20px;border-top:1px solid var(--line);font-family:var(--mono);font-size:13.5px}
.o2 .route:first-child{border-top:0}
.o2 .route:hover{background:var(--s1)}
.o2 .route .arr{color:var(--fg3);display:grid;place-items:center}
.o2 .route .pat,.o2 .route .dst{overflow-wrap:anywhere;line-height:1.55}
.o2 .route .pat .base{color:var(--fg3)}
.o2 .route .dst small{display:block;font-family:var(--font);font-size:12.5px;color:var(--fg2);margin-top:2px}
.o2 .route .act{display:flex;gap:4px;opacity:.6}
.o2 .route:hover .act{opacity:1}
.o2 .hdr{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr) auto;gap:16px;padding:10px 20px;font-size:12.5px;color:var(--fg2);background:var(--s1);border-bottom:1px solid var(--line)}
.o2 .plain{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.o2 .plain .l{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:14px 20px;border-top:1px solid var(--line)}
.o2 .plain .l:first-child{border-top:0}
.o2 .plain .l .m{font-size:13px;color:var(--fg2);margin-top:2px;overflow-wrap:anywhere}
.o2 .note{display:flex;gap:10px;align-items:flex-start;padding:14px 16px;border-radius:8px;border:1px solid var(--line);font-size:13.5px;color:var(--fg2)}
.o2 .note .dot{margin-top:6px}
.o2 .edit{max-width:1120px;margin:0 auto;padding:40px 24px 80px}
.o2 .pair{display:grid;grid-template-columns:1fr 28px 1fr;gap:16px;align-items:start;margin-top:28px}
.o2 .pair .arr{color:var(--fg3);display:grid;place-items:center;height:40px;margin-top:30px}
.o2 .pair .card{padding:20px;display:grid;gap:16px}
.o2 .pair .card .cap{font-size:13px;color:var(--fg2)}
.o2 .pat-big{font-family:var(--mono);font-size:15px;line-height:1.6;padding:9px 0;overflow-wrap:anywhere}
.o2 .vals{display:grid;gap:12px;margin-top:8px;padding-top:16px;border-top:1px solid var(--line)}
.o2 .vals .v{display:grid;grid-template-columns:120px 1fr;gap:12px;align-items:center;font-size:13px}
.o2 .try{margin-top:28px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}
.o2 .res{margin-top:12px;font-size:13.5px;color:var(--fg2);display:flex;gap:10px;align-items:center}
.o2 .bar{display:flex;align-items:center;gap:12px;margin-top:36px;padding-top:20px;border-top:1px solid var(--line)}
`;
function o2Spaces() {
  return `<div class="o2">${nav()}<div class="page">
<div class="head"><h1 class="h1">Spaces</h1><span class="grow"></span><a class="btn primary" href="#">Add Space</a></div>
<div class="list">${SPACES.map((s) => {
    const st = state(s);
    return `<a class="r${s.active ? "" : " off"}" href="#"><div><div class="n">${s.id}</div><div class="base">${EDGE}/v2/${s.id}/</div></div><div class="rt"><span class="row" style="gap:8px">${dot(st.tone)}<span class="${st.tone === "warn" ? "warn" : ""}">${st.text}</span></span><span>${s.sources.length === 1 ? "1 route" : `${s.sources.length} routes`} · ${s.cls} · ${ago(s.updatedAt)}</span></div></a>`;
  }).join("")}</div>
<p class="muted" style="margin-top:28px;font-size:13.5px">Every Space serves under <span class="mono">${EDGE}/v2/</span>. The Edge is serving your latest changes.</p>
</div></div>`;
}
function o2Space() {
  const s = E;
  return `<div class="o2">${nav(["ernesta"])}<div class="page">
<div class="title"><h1 class="h1">ernesta</h1><span class="muted">public</span><span class="grow"></span><a class="btn" href="#">Settings</a><a class="btn primary" href="#">Add route</a></div>
<p class="sub">Requests to <span class="mono">${EDGE}/v2/ernesta/…</span> are rewritten to these destinations.</p>
<section class="sec"><div class="routes"><div class="hdr"><span>Request</span><span></span><span>Fetched from</span><span></span></div>
${s.sources
  .map(
    (x) =>
      `<div class="route"><span class="pat"><span class="base">/v2/ernesta/</span>${x.id}/${
        x.kind === "template"
          ? Object.keys(x.ph)
              .map((p) => `<b class="ph">{${p}}</b>`)
              .join("/")
          : (x.to.match(/\{[a-z_]+\}/g) || []).map((p) => `<b class="ph">${p}</b>`).join("/")
      }</span><span class="arr">${I.arrow}</span><span class="dst">${u(x.to)}${x.kind === "s3" ? `<small>${x.cred ? `Signed with ${x.cred}` : `<span class="warn">No credential yet</span>`}</small>` : ""}</span><span class="act"><a class="btn sm ghost" href="#">Edit</a></span></div>`,
  )
  .join("")}
</div></section>
<section class="sec"><div class="h"><h2 class="h2">Apps that can call Control</h2><a class="btn sm" href="#">Issue token</a></div><div class="plain">
${s.tokens.map((t) => `<div class="l"><div><div>${t.label}</div><div class="m">${t.used ? `Last used ${ago(t.used, true)}` : "Never used"}</div></div><a class="btn sm ghost" href="#">Revoke</a></div>`).join("")}
<div class="l" style="opacity:.5"><div><div>local dev</div><div class="m">Revoked ${date(s.revoked[0].at)}</div></div><span></span></div></div></section>
<section class="sec"><div class="h"><h2 class="h2">Signing keys</h2><a class="btn sm" href="#">Add key</a></div><div class="plain">
${s.keys.map((k) => `<div class="l"><div><div class="mono wrap">${k.id}</div><div class="m">Accepted since ${date(k.since)}</div></div><a class="btn sm ghost" href="#">Disable</a></div>`).join("")}</div>
<div class="note" style="margin-top:12px">${dot("warn")}<span>Two keys are accepted. When your app mints with <span class="mono">k-2026-09-rotation-candidate…</span>, disable <span class="mono">k-2026-08</span>.</span></div></section>
<section class="sec"><div class="h"><h2 class="h2">Allowed origins</h2><a class="btn sm" href="#">Edit</a></div><div class="plain">${s.origins.map((o) => `<div class="l"><div class="mono">${o}</div><span class="muted" style="font-size:13px">deployed</span></div>`).join("")}</div></section>
</div></div>`;
}
function o2Source() {
  return `<div class="o2">${nav(["ernesta", "uploadthing"])}<div class="edit">
<div class="title"><h1 class="h1">uploadthing</h1><span class="muted">URL template</span></div>
<p class="sub" style="margin-bottom:0">Change where this route fetches from. The request pattern follows the placeholders in the destination.</p>
<div class="pair">
  <div class="card"><span class="cap">Request</span><div class="pat-big"><span class="faint">${EDGE}/v2/ernesta/uploadthing/</span><b class="ph">{project}</b>/<b class="ph">{file}</b></div><span class="cap">Derived from the destination. The route name is fixed.</span></div>
  <span class="arr">${I.arrow}</span>
  <div class="card"><span class="cap">Fetched from</span><input class="input mono" value="https://{project}.ufs.sh/f/{file}">
    <div class="vals"><div class="v"><span class="mono">{project}</span><input class="input mono" value="8w0z32yftd, rrsku8h9ue"></div><div class="v"><span class="mono">{file}</span><input class="input mono" placeholder="any value"></div><span class="cap">A placeholder in the hostname must list its values.</span></div></div>
</div>
<div class="try"><input class="input mono" value="8w0z32yftd/0RT8d5Yx2Kq9WcVnFq1mL.jpg"><button class="btn">Try this reference</button></div>
<div class="res">${dot("ok")} Fetched from 8w0z32yftd.ufs.sh · 206 · image/jpeg · 1.28 MB · 212 ms</div>
<div class="bar"><a class="btn danger" href="#">Remove route</a><span class="grow"></span><a class="btn" href="#">Cancel</a><button class="btn primary">Save route</button></div>
</div></div>`;
}

// =====================================================================
// 3 — Document
// =====================================================================
const CSS3 = `
.o3 .doc{max-width:720px;margin:0 auto;padding:56px 24px 96px}
.o3 .doc .h1{margin-bottom:6px}
.o3 .lede{font-size:16px;color:var(--fg2);line-height:1.6}
.o3 .li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:center;padding:18px 0;border-top:1px solid var(--line)}
.o3 .li:last-child{border-bottom:1px solid var(--line)}
.o3 .li .n{font-size:16px;font-weight:500}
.o3 .li .m{color:var(--fg2);margin-top:2px;font-size:14px}
.o3 .li .t{color:var(--fg3);font-size:13px;white-space:nowrap}
.o3 .li.off{opacity:.5}
.o3 h2.h2{display:flex;align-items:baseline;gap:12px;margin:44px 0 10px;font-size:19px}
.o3 h2.h2 a{font-size:13.5px;font-weight:400}
.o3 p.body{color:var(--fg2);line-height:1.65}
.o3 .ln{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:baseline;padding:14px 0;border-top:1px solid var(--line)}
.o3 .ln:last-child{border-bottom:1px solid var(--line)}
.o3 .ln .k{font-weight:500}
.o3 .ln .v{font-size:14px;color:var(--fg2);margin-top:2px;overflow-wrap:anywhere}
.o3 .ln .a{font-size:13.5px}
.o3 .code{padding:14px 16px;border-radius:8px;background:var(--s1);border:1px solid var(--line);font-family:var(--mono);font-size:13.5px;line-height:1.6;overflow-wrap:anywhere}
.o3 .form{display:grid;gap:28px;margin-top:28px}
.o3 .form .field>label{font-size:15px}
.o3 .form .input,.o3 .form .textarea{height:44px;font-size:15px}
.o3 .form .textarea{height:auto}
.o3 .save{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;padding:16px 0;margin-top:20px;background:var(--bg);border-top:1px solid var(--line)}
`;
function o3Spaces() {
  return `<div class="o3">${nav()}<div class="doc">
<h1 class="h1">Spaces</h1><p class="lede">Each Space is one application's images: where they come from and who may ask for them.</p>
<div style="height:28px"></div>
${SPACES.map((s) => {
  const st = state(s);
  return `<a class="li${s.active ? "" : " off"}" href="#"><div><div class="n">${s.id}</div><div class="m">${s.active ? `${s.cls[0].toUpperCase() + s.cls.slice(1)}. ${s.sources.length === 1 ? "One source" : `${["", "", "Two", "Three"][s.sources.length]} sources`}, ${s.tokens.length === 1 ? "one app" : `${["", "", "two"][s.tokens.length]} apps`}.` : "Decommissioned; kept for its records."}${st.tone === "warn" ? ` <span class="warn">${st.text}.</span>` : ""}</div></div><span class="t">${ago(s.updatedAt, true)}</span></a>`;
}).join("")}
<p class="body" style="margin-top:28px">The Edge is serving your latest changes. <a class="link" href="#">Add a Space</a> when a new application needs images.</p>
</div></div>`;
}
function o3Space() {
  const s = E;
  return `<div class="o3">${nav(["ernesta"])}<div class="doc">
<h1 class="h1" style="font-family:var(--mono)">ernesta</h1>
<p class="lede">A public Space since ${date(s.createdAt)}. Images are fetched from three sources and served at <span class="mono">${EDGE}/v2/ernesta/…</span>. Two applications hold tokens. One thing needs you: a key rotation is halfway done.</p>
<h2 class="h2">Sources <a class="link" href="#">Add a source</a></h2>
<p class="body">Each source turns a reference in the URL into a place to fetch from.</p>
${s.sources.map((x) => `<a class="ln" href="#"><div><div class="k">${x.id} <span class="faint" style="font-weight:400">· ${x.kind === "s3" ? "S3 bucket" : "URL template"}</span></div><div class="v">${u(x.to)}</div>${x.kind === "s3" && !x.cred ? `<div class="v warn">Has no credential yet, so requests fail.</div>` : ""}</div><span class="a link">Edit</span></a>`).join("")}
<h2 class="h2">Access <a class="link" href="#">Issue a token</a> <a class="link" href="#">Add a key</a></h2>
<p class="body">Applications call Control with a token and sign image requests with a key.</p>
${s.tokens.map((t) => `<div class="ln"><div><div class="k">${t.label}</div><div class="v">Token, last used ${ago(t.used, true)}.</div></div><a class="a link" href="#">Revoke</a></div>`).join("")}
${s.keys.map((k) => `<div class="ln"><div><div class="k mono">${k.id}</div><div class="v">Signing key, accepted since ${date(k.since)}.</div></div><a class="a link" href="#">Disable</a></div>`).join("")}
<p class="body" style="margin-top:14px"><span class="warn">Two keys are accepted.</span> Once your app mints with the new key, disable <span class="mono">k-2026-08</span>. A revoked token and a disabled key are kept below for the record.</p>
<h2 class="h2">Where images may come from <a class="link" href="#">Edit</a></h2>
<p class="body">Shutter only fetches from these origins, and the deployed image proxy must list them too. All four are deployed.</p>
<div class="code">${s.origins.join("<br>")}</div>
<h2 class="h2">Qualities <a class="link" href="#">Edit</a></h2>
<p class="body">A URL may ask for quality 30, 50 or 75. Without a value it gets 75.</p>
<h2 class="h2" style="color:var(--red-fg)">Decommission</h2>
<p class="body">Stops new work for this Space and keeps every record. The name is never reused. <a class="link" href="#">Decommission ernesta…</a></p>
</div></div>`;
}
function o3Source() {
  return `<div class="o3">${nav(["ernesta", "uploadthing"])}<div class="doc">
<a class="link" href="#" style="font-size:13.5px">← ernesta</a>
<h1 class="h1" style="font-family:var(--mono);margin-top:10px">uploadthing</h1>
<p class="lede">A URL template. Requests to <span class="mono">…/v2/ernesta/uploadthing/<b class="ph">{project}</b>/<b class="ph">{file}</b></span> fetch from the address below.</p>
<div class="form">
  <div class="field"><label>Fetch from</label><input class="input mono" value="https://{project}.ufs.sh/f/{file}"><p>Write each variable part as <span class="mono">{name}</span>. It matches one path segment, or one label of the hostname.</p></div>
  <div class="field"><label>Values allowed for {project}</label><input class="input mono" value="8w0z32yftd, rrsku8h9ue"><p>Required here because it's in the hostname. Comma-separated.</p></div>
  <div class="field"><label>Values allowed for {file}</label><input class="input mono" placeholder="Any"><p>Leave empty to accept any single segment.</p></div>
  <div class="field"><label>Try a reference</label><div class="row"><input class="input mono" value="8w0z32yftd/0RT8d5Yx2Kq9WcVnFq1mL.jpg"><button class="btn" style="height:44px">Run</button></div><p>${dot("ok")} Fetched from 8w0z32yftd.ufs.sh, 206, image/jpeg, 1.28 MB in 212 ms.</p></div>
</div>
<div class="save"><span class="muted" style="font-size:13.5px">The Edge picks changes up within a minute.</span><span class="grow"></span><a class="btn" href="#">Discard</a><button class="btn primary">Save</button></div>
<p class="body" style="margin-top:36px;font-size:13.5px">To stop serving this source, <a class="link" href="#">remove it</a>. Already cached images remain until a purge.</p>
</div></div>`;
}

// =====================================================================
// 4 — Setup
// =====================================================================
const CSS4 = `
.o4 .page{max-width:880px;margin:0 auto;padding:48px 24px 96px}
.o4 .head{display:flex;align-items:center;gap:16px;margin-bottom:28px}
.o4 .sp{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:center;padding:18px 20px;border:1px solid var(--line);border-radius:10px;background:var(--s1);margin-bottom:10px}
.o4 .sp:hover{border-color:var(--line3)}
.o4 .sp.off{opacity:.5}
.o4 .sp .n{font-size:16px;font-weight:600}
.o4 .sp .m{font-size:13.5px;color:var(--fg2);margin-top:2px}
.o4 .prog{display:flex;gap:4px}
.o4 .prog i{width:26px;height:4px;border-radius:2px;background:var(--line2)}
.o4 .prog i.d{background:var(--accent)}.o4 .prog i.w{background:var(--warn)}
.o4 .title{display:flex;align-items:baseline;gap:14px;margin-bottom:6px}
.o4 .title .h1{font-family:var(--mono)}
.o4 .lede{color:var(--fg2);margin-bottom:36px}
.o4 .step{display:grid;grid-template-columns:44px minmax(0,1fr);gap:20px;padding:28px 0;border-top:1px solid var(--line)}
.o4 .step:last-child{border-bottom:1px solid var(--line)}
.o4 .num{width:36px;height:36px;border-radius:50%;border:1px solid var(--line2);display:grid;place-items:center;font-size:14px;font-weight:600;color:var(--fg2)}
.o4 .num.done{background:var(--accent);border-color:var(--accent);color:#fff}
.o4 .num.todo{border-color:var(--warn);color:var(--warn-fg)}
.o4 .step h2{font-size:18px;font-weight:600;letter-spacing:-.01em}
.o4 .step .why{color:var(--fg2);margin:4px 0 16px}
.o4 .rows{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.o4 .rw{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:12px 16px;border-top:1px solid var(--line);font-size:14px}
.o4 .rw:first-child{border-top:0}
.o4 .rw .s{font-size:13px;color:var(--fg2);overflow-wrap:anywhere;margin-top:1px}
.o4 .acts{display:flex;gap:8px;margin-top:12px}
.o4 .code{padding:12px 14px;border-radius:8px;background:var(--s1);border:1px solid var(--line);font-family:var(--mono);font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.o4 .sheet{max-width:1100px;margin:0 auto;padding:40px 24px 96px;display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:48px;align-items:start}
@media (max-width:900px){.o4 .sheet{grid-template-columns:1fr}}
.o4 .sheet .form{display:grid;gap:26px}
.o4 .side{position:sticky;top:64px;display:grid;gap:14px}
.o4 .side .card{padding:20px;display:grid;gap:12px}
.o4 .side .cap{font-size:13px;color:var(--fg2)}
.o4 .side .url{font-family:var(--mono);font-size:13.5px;line-height:1.65;overflow-wrap:anywhere}
.o4 .side .url .base{color:var(--fg3)}
.o4 .side .ok{display:flex;gap:10px;align-items:center;font-size:13.5px;color:var(--fg2)}
`;
function o4Spaces() {
  const prog = (s) => {
    const d1 = s.sources.length > 0 && s.sources.every((x) => x.kind !== "s3" || x.cred),
      d2 = s.tokens.length > 0 && s.keys.length > 0,
      d3 = s.uncovered.length === 0;
    return [d1, d2, d3];
  };
  return `<div class="o4">${nav()}<div class="page">
<div class="head"><h1 class="h1">Spaces</h1><span class="grow"></span><a class="btn primary" href="#">New Space</a></div>
${SPACES.map((s) => {
  const p = prog(s),
    n = p.filter(Boolean).length;
  return `<a class="sp${s.active ? "" : " off"}" href="#"><div><div class="n">${s.id}</div><div class="m">${!s.active ? "Decommissioned" : n === 3 ? "Set up and serving" : `${n} of 3 steps done · ${p[0] ? (p[1] ? "deploy the allowlist" : "give the app access") : "finish the sources"}`}</div></div>${s.active ? `<span class="prog">${p.map((d) => `<i class="${d ? "d" : "w"}"></i>`).join("")}</span>` : ""}</a>`;
}).join("")}
</div></div>`;
}
function o4Space() {
  const s = E;
  return `<div class="o4">${nav(["ernesta"])}<div class="page">
<div class="title"><h1 class="h1">ernesta</h1><span class="muted">public</span><span class="grow"></span><a class="btn ghost sm" href="#">Settings</a></div>
<p class="lede">Serving at <span class="mono">${EDGE}/v2/ernesta/…</span>. Two of three steps are complete.</p>
<div class="step"><span class="num done">${I.check}</span><div><h2>Where images live</h2><p class="why">Sources turn the reference in a URL into a place to fetch from. Only these origins are allowed.</p>
  <div class="rows">${s.sources.map((x) => `<div class="rw"><div><div>${x.id} <span class="faint">· ${x.kind === "s3" ? "S3" : "template"}</span></div><div class="s">${u(x.to)}</div></div><a class="btn sm ghost" href="#">Edit</a></div>`).join("")}</div>
  <div class="acts"><a class="btn sm" href="#">Add source</a><a class="btn sm ghost" href="#">Allowed origins (4)</a></div></div></div>
<div class="step"><span class="num todo">2</span><div><h2>Let your app use it</h2><p class="why">A token to call Control, and a key to sign image requests. <span class="warn">Finish the key rotation.</span></p>
  <div class="rows">${s.tokens.map((t) => `<div class="rw"><div>${t.label}<div class="s">token · used ${ago(t.used, true)}</div></div><a class="btn sm ghost" href="#">Revoke</a></div>`).join("")}${s.keys.map((k, i) => `<div class="rw"><div><span class="mono">${k.id}</span><div class="s">key · since ${date(k.since)}${i === 1 ? " · disable once the app mints with the new key" : ""}</div></div><a class="btn sm ghost" href="#">Disable</a></div>`).join("")}</div>
  <div class="acts"><a class="btn sm" href="#">Issue token</a><a class="btn sm" href="#">Add key</a></div></div></div>
<div class="step"><span class="num done">${I.check}</span><div><h2>Deploy</h2><p class="why">The image proxy needs every origin in its allowlist. Yours already has all four.</p>
  <div class="code">IMGPROXY_ALLOWED_SOURCES=https://8w0z32yftd.ufs.sh/f,https://ernesta-images-gkewpgekhi.t3.storageapi.dev,https://ernesta-images-h594sc5xb.t3.storageapi.dev,https://rrsku8h9ue.ufs.sh/f,…</div>
  <div class="acts"><a class="btn sm" href="#">${I.copy} Copy</a></div></div></div>
</div></div>`;
}
function o4Source() {
  return `<div class="o4">${nav(["ernesta", "uploadthing"])}<div class="sheet">
<div><a class="link" href="#" style="font-size:13.5px">← Where images live</a><h1 class="h1" style="margin:10px 0 28px;font-family:var(--mono)">uploadthing</h1>
<div class="form">
  <div class="field"><label>Fetch from</label><input class="input mono" value="https://{project}.ufs.sh/f/{file}"><p>Put <span class="mono">{name}</span> where the reference varies. One per path segment or hostname label.</p></div>
  <div class="field"><label>{project} may be</label><input class="input mono" value="8w0z32yftd, rrsku8h9ue"><p>Required: it's in the hostname.</p></div>
  <div class="field"><label>{file} may be</label><input class="input mono" placeholder="Anything"></div>
  <div class="row" style="padding-top:8px"><button class="btn primary">Save</button><a class="btn ghost" href="#">Cancel</a><span class="grow"></span><a class="btn ghost danger" href="#">Remove</a></div>
</div></div>
<aside class="side">
  <div class="card"><span class="cap">Your app will request</span><div class="url"><span class="base">https://${EDGE}/v2/ernesta/</span>uploadthing/<b class="ph">{project}</b>/<b class="ph">{file}</b><span class="base">?w=1200&amp;q=75</span></div></div>
  <div class="card"><span class="cap">Shutter will fetch</span><div class="url">https://<b class="ph">{project}</b>.ufs.sh/f/<b class="ph">{file}</b></div><span class="ok">${dot("ok")} Inside the allowed origins</span></div>
  <div class="card"><span class="cap">Try it</span><input class="input mono" value="8w0z32yftd/0RT8d5Yx2Kq9WcVnFq1mL.jpg"><span class="ok">${dot("ok")} 206 · image/jpeg · 1.28 MB · 212 ms</span></div>
</aside>
</div></div>`;
}

// =====================================================================
// 5 — Records
// =====================================================================
const CSS5 = `
.o5 .page{max-width:1240px;margin:0 auto;padding:40px 24px 96px}
.o5 .head{display:flex;align-items:center;gap:16px;margin-bottom:24px}
.o5 .filters{display:flex;gap:8px;align-items:center;margin-bottom:12px}
.o5 .filters .input{width:300px}
.o5 .tbl{width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:10px;overflow:hidden;display:table}
.o5 .tbl th{text-align:left;font-size:12.5px;font-weight:500;color:var(--fg2);padding:10px 16px;background:var(--s1);border-bottom:1px solid var(--line)}
.o5 .tbl td{padding:12px 16px;border-bottom:1px solid var(--line);vertical-align:middle;font-size:13.5px}
.o5 .tbl tr:last-child td{border-bottom:0}
.o5 .tbl tbody tr:hover td{background:var(--s1)}
.o5 .tbl .grp td{background:var(--bg);padding:16px 16px 8px;font-weight:600;font-size:14px;border-bottom:0}
.o5 .tbl .grp td .muted{font-weight:400;font-size:13px;margin-left:8px}
.o5 .tbl .grp:hover td{background:var(--bg)}
.o5 .tbl .m{font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
.o5 .tbl .r{text-align:right;white-space:nowrap}
.o5 .tbl .off td{color:var(--fg3)}
.o5 .tbl tr.edit td{background:var(--s1);padding:20px 16px 16px;border-top:1px solid var(--line2);border-bottom:1px solid var(--line2)}
.o5 .ef{display:grid;grid-template-columns:1fr 1fr;gap:16px 24px;max-width:900px}
.o5 .ef .wide{grid-column:1/-1}
.o5 .ef .bar{grid-column:1/-1;display:flex;gap:8px;align-items:center;padding-top:6px}
.o5 .tabs{display:flex;gap:4px;margin:8px 0 20px;border-bottom:1px solid var(--line)}
.o5 .tabs a{position:relative;padding:8px 10px 12px;color:var(--fg2)}
.o5 .tabs a.on{color:var(--fg)}.o5 .tabs a.on::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--fg)}
.o5 .title{display:flex;align-items:baseline;gap:14px}
.o5 .title .h1{font-family:var(--mono)}
.o5 .try{font-size:13px;color:var(--fg2);display:flex;gap:10px;align-items:center}
`;
const kindWord = (x) => (x.kind === "s3" ? "S3" : "Template");
function o5Rows(s, editing) {
  return s.sources
    .map((x) => {
      const pat = `${x.id}/${(x.kind === "template" ? Object.keys(x.ph).map((p) => `{${p}}`) : x.to.match(/\{[a-z_]+\}/g) || []).join("/")}`;
      const row = `<tr><td class="m">${u(pat)}</td><td>${kindWord(x)}</td><td class="m">${u(x.to)}</td><td>${x.kind === "s3" ? (x.cred ? `<span class="mono">${x.cred}</span>` : `<span class="warn">none</span>`) : "<span class=faint>—</span>"}</td><td class="r"><a class="btn sm ghost" href="#">${editing === x.id ? "Close" : "Edit"}</a></td></tr>`;
      if (editing !== x.id) return row;
      return (
        row +
        `<tr class="edit"><td colspan="5"><div class="ef">
  <div class="field wide"><label>Fetched from</label><input class="input mono" value="https://{project}.ufs.sh/f/{file}"><p>Each <span class="mono">{name}</span> is one path segment or one hostname label. Must stay inside ernesta's allowed origins.</p></div>
  <div class="field"><label>{project} allowed values</label><input class="input mono" value="8w0z32yftd, rrsku8h9ue"><p>Required for a hostname label.</p></div>
  <div class="field"><label>{file} allowed values</label><input class="input mono" placeholder="Any"></div>
  <div class="field wide"><label>Try a reference</label><div class="row"><input class="input mono" value="8w0z32yftd/0RT8d5Yx2Kq9WcVnFq1mL.jpg" style="max-width:480px"><button class="btn">Run</button><span class="try">${dot("ok")} 206 · image/jpeg · 1.28 MB · 212 ms from 8w0z32yftd.ufs.sh</span></div></div>
  <div class="bar"><button class="btn primary">Save</button><a class="btn" href="#">Cancel</a><span class="grow"></span><a class="btn ghost danger" href="#">Delete record</a></div>
</div></td></tr>`
      );
    })
    .join("");
}
function o5Spaces() {
  return `<div class="o5">${nav()}<div class="page">
<div class="head"><div><h1 class="h1">Sources</h1><p class="muted" style="margin-top:4px">Every route Shutter serves, grouped by Space.</p></div><span class="grow"></span><a class="btn" href="#">New Space</a><a class="btn primary" href="#">Add source</a></div>
<div class="filters"><input class="input" placeholder="Filter by name, destination or bucket"><span class="grow"></span><span class="muted" style="font-size:13px">5 records in 3 active Spaces</span></div>
<table class="tbl"><thead><tr><th style="width:30%">Request path under /v2/</th><th>Kind</th><th style="width:36%">Fetched from</th><th>Credential</th><th></th></tr></thead><tbody>
${SPACES.filter((s) => s.active)
  .map((s) => {
    const st = state(s);
    return `<tr class="grp"><td colspan="5"><a href="#" class="link">${s.id}</a><span class="muted">${s.cls} · ${st.tone === "warn" ? `<span class="warn">${st.text}</span>` : "ready"}</span></td></tr>${o5Rows(s, null)}`;
  })
  .join("")}
<tr class="grp off"><td colspan="5">probe-space<span class="muted">decommissioned · no records</span></td></tr>
</tbody></table>
</div></div>`;
}
function o5Space(editing) {
  const s = E;
  return `<div class="o5">${nav(["ernesta"])}<div class="page">
<div class="title"><h1 class="h1">ernesta</h1><span class="muted">public · serving at ${EDGE}/v2/ernesta/</span></div>
<div class="tabs"><a class="on" href="#">Sources</a><a href="#">Access</a><a href="#">Origins</a><a href="#">Settings</a></div>
<div class="filters"><input class="input" placeholder="Filter"><span class="grow"></span><a class="btn primary sm" href="#">${I.plus} Add source</a></div>
<table class="tbl"><thead><tr><th style="width:30%">Request path under /v2/ernesta/</th><th>Kind</th><th style="width:36%">Fetched from</th><th>Credential</th><th></th></tr></thead><tbody>${o5Rows(s, editing)}</tbody></table>
<p class="muted" style="margin-top:24px;font-size:13.5px">Two apps hold tokens; two signing keys are accepted, which means a rotation is in progress. <a class="link" href="#">Open Access</a>.</p>
</div></div>`;
}

const screens = [
  [1, o1Spaces, o1Space, o1Source],
  [2, o2Spaces, o2Space, o2Source],
  [3, o3Spaces, o3Space, o3Source],
  [4, o4Spaces, o4Space, o4Source],
  [5, o5Spaces, () => o5Space(null), () => o5Space("uploadthing")],
]
  .map(
    ([n, a, b, c]) =>
      `<section class="screen" id="s-${n}-spaces">${a()}</section><section class="screen" id="s-${n}-space">${b()}</section><section class="screen" id="s-${n}-source">${c()}</section>`,
  )
  .join("\n");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shutter admin · design trials set 3</title><style>${BASE}${STUDIO}${NAV_CSS}${CSS1}${CSS2}${CSS3}${CSS4}${CSS5}</style></head><body>${studio()}
${screens}
</body></html>`;
writeFileSync(new URL("./index.html", import.meta.url), html);
console.log(`wrote index.html (${(html.length / 1024).toFixed(0)} KB)`);
