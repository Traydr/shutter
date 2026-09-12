// Shutter admin design trials, set 3. Fresh start: calm, monochrome, favicon blue as the only accent. CSS-only.
import { writeFileSync } from "node:fs";

const NOW = Date.parse("2026-09-13T09:30:00Z");
const EDGE = "shutter-edge.traydr.dev";
const SPACES = [
  { id: "ernesta", cls: "public", active: true, updatedAt: "2026-09-12T08:42:13Z", createdAt: "2026-08-13T18:11:08Z", qualities: [30, 50, 75], dq: 75,
    origins: ["https://8w0z32yftd.ufs.sh/f", "https://rrsku8h9ue.ufs.sh/f", "https://ernesta-images-h594sc5xb.t3.storageapi.dev", "https://ernesta-images-gkewpgekhi.t3.storageapi.dev"],
    sources: [
      { id: "uploadthing", kind: "template", to: "https://{project}.ufs.sh/f/{file}", ph: { project: ["8w0z32yftd", "rrsku8h9ue"], file: null } },
      { id: "media", kind: "s3", to: "ernesta-images-gkewpgekhi.t3.storageapi.dev/{key}", cred: "AKIA3QX7…R2ML" },
      { id: "media-dev", kind: "s3", to: "ernesta-images-h594sc5xb.t3.storageapi.dev/{key}", cred: null },
    ],
    tokens: [{ label: "production deploy", used: "2026-09-13T09:14:03Z" }, { label: "preview (vercel)", used: "2026-09-12T22:40:51Z" }],
    revoked: [{ label: "local dev", at: "2026-08-21T09:00:00Z" }],
    keys: [{ id: "k-2026-09-rotation-candidate-for-ernesta-production-do-not-delete", since: "2026-09-11T16:05:00Z" }, { id: "k-2026-08", since: "2026-08-13T18:30:00Z" }],
    disabledKeys: [{ id: "k-2026-07-bootstrap", at: "2026-08-14T10:00:00Z" }],
    uncovered: [] },
  { id: "pane-view", cls: "private", active: true, updatedAt: "2026-09-12T00:03:39Z", createdAt: "2026-08-13T18:49:19Z", qualities: [30, 75, 80], dq: 75,
    origins: ["https://t3.storageapi.dev/balanced-wrap-ocyiwwexhao"],
    sources: [{ id: "originals", kind: "s3", to: "t3.storageapi.dev/balanced-wrap-ocyiwwexhao/originals/sha256/{shard_a}/{shard_b}/{object}", cred: "AKIA7Q…W9PX" }],
    tokens: [{ label: "railway production", used: "2026-09-13T09:27:12Z" }], revoked: [], keys: [{ id: "k-2026-08", since: "2026-08-13T18:55:00Z" }], disabledKeys: [], uncovered: [] },
  { id: "latch-works", cls: "private", active: true, updatedAt: "2026-09-11T20:31:45Z", createdAt: "2026-09-11T20:14:02Z", qualities: [60, 75, 90], dq: 75,
    origins: ["https://latch-works-uploads.t3.storageapi.dev", "https://cdn.latch.works/assets"],
    sources: [{ id: "assets", kind: "template", to: "https://cdn.latch.works/assets/{collection}/{file}", ph: { collection: ["site", "docs", "press-kit"], file: null } }],
    tokens: [{ label: "latch-works api", used: null }], revoked: [], keys: [], disabledKeys: [], uncovered: ["https://latch-works-uploads.t3.storageapi.dev"] },
  { id: "probe-space", cls: "private", active: false, updatedAt: "2026-08-13T18:08:39Z", createdAt: "2026-08-13T18:03:12Z", qualities: [75], dq: 75,
    origins: ["https://sources.example.com/probe"], sources: [], tokens: [], revoked: [], keys: [], disabledKeys: [], uncovered: [] },
];
const E = SPACES[0];
const SRC = E.sources[0];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function ago(iso, long = false) {
  const d = (NOW - Date.parse(iso)) / 1000;
  const [n, u] = d < 3600 ? [Math.max(1, Math.round(d / 60)), "minute"] : d < 86400 ? [Math.round(d / 3600), "hour"] : [Math.round(d / 86400), "day"];
  return long ? `${n} ${u}${n === 1 ? "" : "s"} ago` : `${n}${u[0]} ago`;
}
const date = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** URLs with placeholders: plain mono, placeholders in the accent colour, no boxes. */
const u = (s) => `<span class="mono">${esc(s).replace(/\{([a-z_]+)\}/g, '<b class="ph">{$1}</b>')}</span>`;
const host = (o) => o.replace(/^https:\/\//, "");
const LOGO = (s) => `<svg viewBox="0 0 64 64" aria-hidden="true" width="${s}" height="${s}"><polygon points="32,4 57,18 50,22 32,12" fill="#258FE0"/><polygon points="57,18 57,46 50,42 50,22" fill="#4268D4"/><polygon points="57,46 32,60 32,52 50,42" fill="#16366B"/><polygon points="32,60 7,46 14,42 32,52" fill="#16366B"/><polygon points="7,46 7,18 14,22 14,42" fill="#4268D4"/><polygon points="7,18 32,4 32,12 14,22" fill="#258FE0"/><g transform="translate(13.12 12.16) scale(0.59 0.62)"><path d="M32 5 48 16v9l-9 9-7-7 7-7-7-5-7 5v5L16 16Z" fill="#258FE0"/><path d="M16 19 48 40v9L32 59 16 48v-9l9-9 7 7-7 7 7 5 7-5v-1L16 28Z" fill="#16366B"/><path d="M16 19.0 48 40.0v9L16 28.0Z" fill="#4268D4"/></g></svg>`;
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
  if (s.uncovered.length) return { tone: "warn", text: `${host(s.uncovered[0])} isn't deployed yet` };
  if (s.keys.length === 0) return { tone: "warn", text: "No signing key yet" };
  if (s.sources.some((x) => x.kind === "s3" && !x.cred)) return { tone: "warn", text: `${s.sources.find((x) => x.kind === "s3" && !x.cred).id} has no credential` };
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
  { n: 1, name: "Sites", blurb: "Sites, refined: cards, tabs, sources first. The delivery URL appears once, small." },
  { n: 2, name: "Sites · side nav", blurb: "Sites with a left section nav instead of tabs; the editor lives inside the nav." },
  { n: 3, name: "Sites · one page", blurb: "Sites with no tabs: one long page with an anchor list, editing in a side panel." },
  { n: 4, name: "Routes · inline", blurb: "Routes table without the host prefix; editing expands the row in place." },
  { n: 5, name: "Routes · split", blurb: "Routes on the left, access on the right; Spaces overview is a compact table." },
];
const PAGES = [["spaces", "Spaces"], ["space", "ernesta"], ["source", "ernesta › uploadthing"]];
const STUDIO = `
.studio{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:20px;height:40px;padding:0 16px;background:#0b0b0b;border-bottom:1px solid #222;color:#8a8a8a;font-size:12.5px}
.studio .name{color:#ededed;font-weight:600;letter-spacing:.02em;display:flex;align-items:center;gap:8px;white-space:nowrap}
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
@media (max-width:1100px){.studio .blurb{display:none!important}}
`;
const studio = () => `<div class="studio"><span class="name">${LOGO(16)} Trials · set 4</span>
<span class="g">${OPTS.map((o) => `<input type="radio" name="op" id="op-${o.n}"${o.n === 1 ? " checked" : ""}><label for="op-${o.n}"><b>${o.n}</b>${o.name}</label>`).join("")}</span>
<span class="g">${PAGES.map(([p, l], i) => `<input type="radio" name="pg" id="pg-${p}"${i === 0 ? " checked" : ""}><label for="pg-${p}">${l}</label>`).join("")}</span>
<span class="g"><input type="radio" name="th" id="th-dark" checked><label for="th-dark">${I.moon}</label><input type="radio" name="th" id="th-light"><label for="th-light">${I.sun}</label></span>
${OPTS.map((o) => `<span class="blurb blurb-${o.n}">${o.blurb}</span>`).join("")}</div>`;

const nav = (crumbs = []) => `<header class="nav"><a href="#" class="row" style="gap:10px">${LOGO(22)}<span style="font-weight:600">Shutter</span></a>${crumbs.map((c) => `<span class="slash">/</span><a href="#" class="crumb">${c}</a>`).join("")}<span class="grow"></span><a class="btn ghost sm" href="#">Sign out</a></header>`;
const NAV_CSS = `
.nav{display:flex;align-items:center;gap:12px;height:56px;padding:0 24px;border-bottom:1px solid var(--line)}
.nav .slash{color:var(--line3);font-size:20px;font-weight:200}
.nav .crumb{font-family:var(--mono);font-size:13.5px;font-weight:500}
`;

// Shared pieces for the Sites family
const SITE_CSS = `
.site{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;padding:22px 24px;border:1px solid var(--line);border-radius:10px;background:var(--s1);transition:border-color .12s}
.site:hover{border-color:var(--line3)}
.site.off{opacity:.5}
.site .name{font-size:17px;font-weight:600;letter-spacing:-.01em}
.site .meta{font-size:13.5px;color:var(--fg2);margin-top:3px}
.site .foot{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg2);min-width:0}
.site .foot .st{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.site .foot .t{white-space:nowrap}
.srcs{display:grid;gap:6px;font-size:13.5px}
.srcs .s{display:flex;gap:8px;align-items:baseline;min-width:0}
.srcs .s .k{color:var(--fg3);font-size:12.5px}
.head{display:flex;align-items:center;gap:16px;margin-bottom:32px}
.title{display:flex;align-items:baseline;gap:14px;margin-bottom:28px}
.title .h1{font-family:var(--mono)}
.list{border:1px solid var(--line);border-radius:10px;background:var(--s1);overflow:hidden}
.list .it{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:14px 20px;border-top:1px solid var(--line)}
.list .it:first-child{border-top:0}
.list .it:hover{background:var(--s2)}
.list .it .n{font-weight:500;display:flex;align-items:baseline;gap:8px}
.list .it .n .k{font-weight:400;color:var(--fg3);font-size:13px}
.list .it .d{font-size:13px;color:var(--fg2);margin-top:2px;overflow-wrap:anywhere}
.list .it .go{color:var(--fg3)}
.sec-h{display:flex;align-items:center;gap:12px;margin:0 0 12px}
.sec-h .h2{flex:1}
.sec-h .link{font-size:13.5px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:860px){.two{grid-template-columns:1fr}}
.blk{padding:20px 24px;display:grid;gap:14px;align-content:start;background:var(--s1);border:1px solid var(--line);border-radius:10px}
.blk .h2{font-size:15px}
.blk p{font-size:13.5px;color:var(--fg2);line-height:1.55;overflow-wrap:anywhere}
.blk .ln{display:grid;gap:2px;padding-top:12px;border-top:1px solid var(--line)}
.blk .ln b{font-weight:500}
.tabs{display:flex;gap:4px;padding:0 24px;border-bottom:1px solid var(--line)}
.tabs a{position:relative;padding:12px 8px 14px;color:var(--fg2);font-size:14px}
.tabs a.on{color:var(--fg)}.tabs a.on::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--fg)}
.tabs a:hover{color:var(--fg)}
.form{display:grid;gap:24px}
.form .card{padding:24px;display:grid;gap:22px}
.form .f{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--fg2)}
.res{font-size:13.5px;color:var(--fg2);display:flex;gap:10px;align-items:center}
.dl{display:flex;align-items:center;gap:12px;font-size:13.5px;color:var(--fg2);min-width:0}
.dl .mono{overflow-wrap:anywhere;color:var(--fg2)}
`;
const siteCard = (s, rich = false) => { const st = state(s); return `<a class="site${s.active ? "" : " off"}" href="#"><div><div class="name">${s.id}</div><div class="meta">${s.cls[0].toUpperCase() + s.cls.slice(1)} · ${s.sources.length === 1 ? "1 source" : `${s.sources.length} sources`} · ${s.tokens.length === 1 ? "1 app" : `${s.tokens.length} apps`}</div></div>${rich && s.sources.length ? `<div class="srcs">${s.sources.map((x) => `<span class="s"><span class="trunc">${x.id}</span><span class="k">${x.kind === "s3" ? "S3" : "template"}</span></span>`).join("")}</div>` : ""}<div class="foot">${dot(st.tone)}<span class="st ${st.tone === "warn" ? "warn" : ""}" title="${st.text}">${st.text}</span><span class="t">${ago(s.updatedAt)}</span></div></a>`; };
const sourceRow = (x) => `<a class="it" href="#"><div><div class="n">${x.id}<span class="k">${x.kind === "s3" ? "S3 bucket" : "URL template"}</span></div><div class="d">${u(x.to)}${x.kind === "s3" && !x.cred ? ` · <span class="warn">no credential yet</span>` : ""}</div></div><span class="go">${I.chev}</span></a>`;
const accessBlk = (s) => `<div class="blk"><h2 class="h2">Access</h2>
<div class="ln"><b>API tokens</b><p>${s.tokens.map((t) => `${t.label}, used ${ago(t.used, true)}`).join(" · ")}</p></div>
<div class="ln"><b>Signing keys ${dot("warn")}</b><p>Two keys accepted. Once your app mints with the new one, disable <span class="mono">k-2026-08</span>.</p></div></div>`;
const originsBlk = (s) => `<div class="blk"><h2 class="h2">Where images may come from</h2><p>${s.origins.map(host).join(" · ")}</p><p>All four are deployed to the image proxy.</p><div class="ln"><b>Delivery</b><div class="dl"><span class="mono">${EDGE}/v2/ernesta/<b class="ph">{source}</b>/<b class="ph">{reference}</b></span><a class="btn sm ghost" href="#" style="margin-left:auto">${I.copy} Copy</a></div></div></div>`;
const editorFields = () => `
  <div class="field"><label>Fetch from</label><input class="input mono" value="https://{project}.ufs.sh/f/{file}"><p>Each <span class="mono">{name}</span> is one path segment or one hostname label. Expansions must stay inside the Space's allowed origins.</p></div>
  <div class="field"><label>Allowed values for <span class="mono">{project}</span></label><input class="input mono" value="8w0z32yftd, rrsku8h9ue"><p>Required, because it's part of the hostname.</p></div>
  <div class="field"><label>Allowed values for <span class="mono">{file}</span></label><input class="input mono" placeholder="Any value"><p>Optional for a path segment.</p></div>`;
const tryIt = () => `<div class="row"><input class="input mono" value="8w0z32yftd/0RT8d5Yx2Kq9WcVnFq1mL.jpg"><button class="btn">Run</button></div><div class="res">${dot("ok")} Fetched from 8w0z32yftd.ufs.sh · 206 · image/jpeg · 1.28 MB · 212 ms</div>`;

// =====================================================================
// 1 — Sites (refined)
// =====================================================================
const CSS1 = `
.o1 .page{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
.o1 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.o1 .edge{margin-top:36px;display:flex;align-items:center;gap:10px;font-size:13.5px;color:var(--fg2)}
.o1 .search{display:flex;align-items:center;gap:10px;flex:1;max-width:400px;height:40px;padding:0 12px;border:1px solid var(--line2);border-radius:6px;color:var(--fg3)}
.o1 .sec{margin-bottom:28px}
.o1 .form{max-width:680px;margin:0 auto;padding:40px 24px 80px}
`;
const tabs1 = (on) => `<nav class="tabs">${["Overview", "Sources", "Access", "Settings"].map((t) => `<a href="#" class="${t === on ? "on" : ""}">${t}</a>`).join("")}</nav>`;
function o1Spaces() {
  return `<div class="o1">${nav()}<div class="page">
<div class="head"><h1 class="h1">Spaces</h1><span class="grow"></span><span class="search">${I.search} Search…</span><a class="btn primary" href="#">Add Space</a></div>
<div class="grid">${SPACES.map((s) => siteCard(s)).join("")}</div>
<div class="edge">${dot("ok")} The Edge is serving your latest changes.</div></div></div>`;
}
function o1Space() {
  const s = E;
  return `<div class="o1">${nav(["ernesta"])}${tabs1("Overview")}<div class="page">
<div class="title"><h1 class="h1">ernesta</h1><span class="muted">Public · created ${date(s.createdAt)}</span><span class="grow"></span><a class="btn" href="#">Add source</a></div>
<div class="sec"><div class="sec-h"><h2 class="h2">Sources</h2><a class="link" href="#">See all</a></div><div class="list">${s.sources.map(sourceRow).join("")}</div></div>
<div class="two">${accessBlk(s)}${originsBlk(s)}</div>
</div></div>`;
}
function o1Source() {
  return `<div class="o1">${nav(["ernesta"])}${tabs1("Sources")}<div class="form">
<div><a class="link" href="#" style="font-size:13.5px">← Sources</a><h1 class="h1" style="margin-top:8px;font-family:var(--mono)">uploadthing</h1><p class="muted" style="margin-top:6px">URL template · requests look like <span class="mono">uploadthing/<b class="ph">{project}</b>/<b class="ph">{file}</b></span></p></div>
<div class="card">${editorFields()}<div class="f"><span>The Edge picks changes up within a minute.</span><button class="btn primary">Save</button></div></div>
<div class="card" style="gap:16px"><div><h2 class="h2">Try it</h2><p class="muted" style="margin-top:4px">Resolves a reference the way a real request would and fetches one byte.</p></div>${tryIt()}</div>
<p class="muted" style="font-size:13px">Need to retire this source? <a class="link" href="#">Remove uploadthing</a>. Cached images stay until a purge.</p>
</div></div>`;
}

// =====================================================================
// 2 — Sites · side nav
// =====================================================================
const CSS2 = `
.o2 .page{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
.o2 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:760px){.o2 .grid{grid-template-columns:1fr}}
.o2 .lay{max-width:1080px;margin:0 auto;padding:40px 24px 80px;display:grid;grid-template-columns:200px minmax(0,1fr);gap:48px;align-items:start}
@media (max-width:860px){.o2 .lay{grid-template-columns:1fr}}
.o2 .snav{position:sticky;top:64px;display:grid;gap:2px}
.o2 .snav .who{font-family:var(--mono);font-size:15px;font-weight:600;padding:0 10px 14px}
.o2 .snav a{padding:7px 10px;border-radius:6px;color:var(--fg2);font-size:14px}
.o2 .snav a:hover{color:var(--fg);background:var(--s2)}
.o2 .snav a.on{color:var(--fg);background:var(--s3);font-weight:500}
.o2 .snav .sub{margin:2px 0 2px 14px;padding-left:10px;border-left:1px solid var(--line2);display:grid;gap:2px}
.o2 .snav .sub a{font-family:var(--mono);font-size:13px;padding:5px 10px}
.o2 .snav .danger{color:var(--red-fg)}
.o2 .ph-h{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.o2 .ph-h .h1{font-size:24px}
.o2 .ph-h p{color:var(--fg2)}
.o2 .esec{display:grid;gap:18px;padding:24px 0;border-top:1px solid var(--line)}
.o2 .esec:first-of-type{border-top:0;padding-top:0}
.o2 .esec h2{font-size:15px;font-weight:600}
.o2 .esec .fields{display:grid;gap:20px;max-width:620px}
.o2 .save{display:flex;align-items:center;gap:12px;padding-top:20px;border-top:1px solid var(--line)}
`;
const snav2 = (on, sub = false) => `<nav class="snav"><div class="who">ernesta</div>${["Overview", "Sources", "Access", "Origins", "Settings"].map((t) => `<a href="#" class="${t === on ? "on" : ""}">${t}</a>${t === "Sources" && sub ? `<div class="sub">${E.sources.map((x) => `<a href="#" class="${x.id === "uploadthing" ? "on" : ""}">${x.id}</a>`).join("")}</div>` : ""}`).join("")}<a href="#" class="danger">Decommission</a></nav>`;
function o2Spaces() {
  return `<div class="o2">${nav()}<div class="page">
<div class="head"><h1 class="h1">Spaces</h1><span class="grow"></span><a class="btn primary" href="#">Add Space</a></div>
<div class="grid">${SPACES.map((s) => siteCard(s, true)).join("")}</div></div></div>`;
}
function o2Space() {
  const s = E;
  return `<div class="o2">${nav(["ernesta"])}<div class="lay">${snav2("Sources")}<div>
<div class="ph-h"><div><h1 class="h1">Sources</h1><p>Each source turns the reference in a request into a place to fetch from.</p></div><span class="grow"></span><a class="btn primary" href="#">Add source</a></div>
<div class="list">${s.sources.map(sourceRow).join("")}</div>
<p class="muted" style="margin-top:20px;font-size:13.5px">Requests look like <span class="mono">${EDGE}/v2/ernesta/<b class="ph">{source}</b>/<b class="ph">{reference}</b></span>.</p>
</div></div></div>`;
}
function o2Source() {
  return `<div class="o2">${nav(["ernesta"])}<div class="lay">${snav2("Sources", true)}<div>
<div class="ph-h"><div><h1 class="h1" style="font-family:var(--mono)">uploadthing</h1><p>URL template · requests look like <span class="mono">uploadthing/<b class="ph">{project}</b>/<b class="ph">{file}</b></span></p></div></div>
<section class="esec"><h2>Definition</h2><div class="fields">${editorFields()}</div></section>
<section class="esec"><h2>Try it</h2><div class="fields">${tryIt()}</div></section>
<section class="esec"><h2 style="color:var(--red-fg)">Remove</h2><p class="muted" style="font-size:13.5px">Stops serving this source. Cached images stay until a purge.</p><div><a class="btn danger" href="#">Remove uploadthing</a></div></section>
<div class="save"><span class="muted" style="font-size:13.5px">The Edge picks changes up within a minute.</span><span class="grow"></span><a class="btn" href="#">Discard</a><button class="btn primary">Save</button></div>
</div></div></div>`;
}

// =====================================================================
// 3 — Sites · one page + side panel
// =====================================================================
const CSS3 = `
.o3 .page{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
.o3 .grp{margin-bottom:32px}
.o3 .grp h2{font-size:13.5px;font-weight:500;color:var(--fg2);margin-bottom:12px}
.o3 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.o3 .lay{max-width:1180px;margin:0 auto;padding:40px 24px 96px;display:grid;grid-template-columns:minmax(0,1fr) 180px;gap:56px;align-items:start}
@media (max-width:900px){.o3 .lay{grid-template-columns:1fr}.o3 .toc{display:none}}
.o3 .toc{position:sticky;top:64px;display:grid;gap:2px;padding-top:6px}
.o3 .toc span{font-size:12.5px;color:var(--fg3);padding:0 10px 8px}
.o3 .toc a{padding:6px 10px;border-left:2px solid transparent;color:var(--fg2);font-size:13.5px}
.o3 .toc a.on{color:var(--fg);border-color:var(--fg)}
.o3 section{padding:32px 0;border-top:1px solid var(--line)}
.o3 section:first-of-type{padding-top:0;border-top:0}
.o3 .stage{position:relative}
.o3 .scrim{position:fixed;inset:40px 0 0;background:rgba(0,0,0,.55);z-index:20}
.o3 .panel{position:fixed;top:40px;right:0;bottom:0;width:560px;max-width:100vw;background:var(--bg);border-left:1px solid var(--line2);z-index:21;display:flex;flex-direction:column}
.o3 .panel .phd{display:flex;align-items:center;gap:12px;padding:20px 28px;border-bottom:1px solid var(--line)}
.o3 .panel .phd .h1{font-size:22px;font-family:var(--mono)}
.o3 .panel .pb{padding:28px;display:grid;gap:22px;overflow:auto;flex:1;align-content:start}
.o3 .panel .pf{display:flex;align-items:center;gap:10px;padding:16px 28px;border-top:1px solid var(--line)}
.o3 .panel h2{font-size:14px;font-weight:600;color:var(--fg2);margin-top:8px}
`;
function o3Spaces() {
  const groups = [["Needs you", SPACES.filter((s) => s.active && state(s).tone === "warn")], ["Ready", SPACES.filter((s) => s.active && state(s).tone === "ok")], ["Decommissioned", SPACES.filter((s) => !s.active)]];
  return `<div class="o3">${nav()}<div class="page">
<div class="head"><h1 class="h1">Spaces</h1><span class="grow"></span><a class="btn primary" href="#">Add Space</a></div>
${groups.map(([h, list]) => `<div class="grp"><h2>${h}</h2><div class="grid">${list.map((s) => siteCard(s)).join("")}</div></div>`).join("")}
</div></div>`;
}
function o3Body(s) {
  return `<div class="lay"><div>
<div class="title"><h1 class="h1">ernesta</h1><span class="muted">Public · created ${date(s.createdAt)}</span><span class="grow"></span><a class="btn" href="#">Add source</a></div>
<section id="sources"><div class="sec-h"><h2 class="h2">Sources</h2></div><div class="list">${s.sources.map(sourceRow).join("")}</div></section>
<section id="access"><div class="sec-h"><h2 class="h2">Access</h2><a class="link" href="#">Issue token</a><a class="link" href="#">Add key</a></div><div class="list">
${s.tokens.map((t) => `<div class="it"><div><div class="n">${t.label}<span class="k">token</span></div><div class="d">Last used ${ago(t.used, true)}</div></div><a class="btn sm ghost" href="#">Revoke</a></div>`).join("")}
${s.keys.map((k, i) => `<div class="it"><div><div class="n mono">${k.id}<span class="k">signing key</span></div><div class="d">Accepted since ${date(k.since)}${i === 1 ? ` · <span class="warn">disable once your app mints with the new key</span>` : ""}</div></div><a class="btn sm ghost" href="#">Disable</a></div>`).join("")}</div></section>
<section id="origins"><div class="sec-h"><h2 class="h2">Where images may come from</h2><a class="link" href="#">Edit</a></div><div class="list">${s.origins.map((o) => `<div class="it"><div class="mono">${o}</div><span class="muted" style="font-size:13px">deployed</span></div>`).join("")}</div></section>
<section id="delivery"><div class="sec-h"><h2 class="h2">Delivery</h2></div><div class="dl"><span class="mono">https://${EDGE}/v2/ernesta/<b class="ph">{source}</b>/<b class="ph">{reference}</b>?w=1200&amp;q=75</span><a class="btn sm" href="#">${I.copy} Copy</a></div><p class="muted" style="margin-top:10px;font-size:13.5px">Qualities 30, 50 and 75; default 75.</p></section>
<section id="danger"><div class="sec-h"><h2 class="h2" style="color:var(--red-fg)">Decommission</h2></div><p class="muted" style="font-size:13.5px">Stops new work for this Space and keeps every record. <a class="link" href="#">Decommission ernesta…</a></p></section>
</div>
<nav class="toc"><span>On this page</span><a class="on" href="#sources">Sources</a><a href="#access">Access</a><a href="#origins">Origins</a><a href="#delivery">Delivery</a><a href="#danger">Decommission</a></nav>
</div>`;
}
function o3Space() { return `<div class="o3">${nav(["ernesta"])}${o3Body(E)}</div>`; }
function o3Source() {
  return `<div class="o3">${nav(["ernesta"])}<div class="stage">${o3Body(E)}<div class="scrim"></div></div>
<aside class="panel"><div class="phd"><h1 class="h1">uploadthing</h1><span class="muted">URL template</span><span class="grow"></span><button class="btn icon">${I.x}</button></div>
<div class="pb">${editorFields()}<h2>Try it</h2>${tryIt()}<p class="muted" style="font-size:13px;margin-top:8px"><a class="link" href="#">Remove this source</a>. Cached images stay until a purge.</p></div>
<div class="pf"><span class="muted" style="font-size:13px">Requests look like <span class="mono">uploadthing/<b class="ph">{project}</b>/<b class="ph">{file}</b></span></span><span class="grow"></span><a class="btn" href="#">Cancel</a><button class="btn primary">Save</button></div></aside></div>`;
}

// =====================================================================
// Routes family shared
// =====================================================================
const ROUTE_CSS = `
.routes{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--s1)}
.routes .hdr{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1.2fr) auto;gap:16px;padding:10px 20px;font-size:12.5px;color:var(--fg2);border-bottom:1px solid var(--line)}
.route{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1.2fr) auto;gap:16px;align-items:center;padding:16px 20px;border-top:1px solid var(--line);font-family:var(--mono);font-size:13.5px}
.route:first-of-type{border-top:0}
.route:hover{background:var(--s2)}
.route .arr{color:var(--fg3);display:grid;place-items:center}
.route .pat,.route .dst{overflow-wrap:anywhere;line-height:1.55}
.route .pat b.n{font-weight:600;color:var(--fg)}
.route .dst small{display:block;font-family:var(--font);font-size:12.5px;color:var(--fg2);margin-top:2px}
.route .act{display:flex;gap:4px}
.plain{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--s1)}
.plain .l{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:13px 20px;border-top:1px solid var(--line)}
.plain .l:first-child{border-top:0}
.plain .l .m{font-size:13px;color:var(--fg2);margin-top:2px;overflow-wrap:anywhere}
`;
const pattern = (x) => `<b class="n">${x.id}</b>/${(x.kind === "template" ? Object.keys(x.ph).map((p) => `{${p}}`) : (x.to.match(/\{[a-z_]+\}/g) || [])).map((p) => `<b class="ph">${p}</b>`).join("/")}`;
const routeRow = (x, action = `<a class="btn sm ghost" href="#">Edit</a>`) => `<div class="route"><span class="pat">${pattern(x)}</span><span class="arr">${I.arrow}</span><span class="dst">${u(x.to)}${x.kind === "s3" ? `<small>${x.cred ? `Signed with ${x.cred}` : `<span class="warn">No credential yet</span>`}</small>` : ""}</span><span class="act">${action}</span></div>`;

// =====================================================================
// 4 — Routes · inline edit
// =====================================================================
const CSS4 = `
.o4 .page{max-width:1120px;margin:0 auto;padding:40px 24px 80px}
.o4 .rows .r{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:center;padding:18px 4px;border-top:1px solid var(--line)}
.o4 .rows .r:last-child{border-bottom:1px solid var(--line)}
.o4 .rows .r:hover{background:var(--s1)}
.o4 .rows .n{font-size:16px;font-weight:600;letter-spacing:-.01em}
.o4 .rows .m{font-size:13.5px;color:var(--fg2);margin-top:3px}
.o4 .rows .rt{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--fg2);white-space:nowrap}
.o4 .rows .off{opacity:.5}
.o4 .sec{margin-bottom:40px}
.o4 .sec .sec-h{margin-bottom:12px}
.o4 .two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:860px){.o4 .two{grid-template-columns:1fr}}
.o4 .edit{grid-column:1/-1;padding:8px 0 4px}
.o4 .edit .ef{display:grid;grid-template-columns:1fr 1fr;gap:18px 24px}
.o4 .edit .ef .wide{grid-column:1/-1}
.o4 .edit .bar{grid-column:1/-1;display:flex;gap:10px;align-items:center;padding-top:14px;border-top:1px solid var(--line)}
.o4 .route.open{background:var(--s2);border-top:1px solid var(--line2)}
.o4 .route.open+.route{border-top:1px solid var(--line2)}
`;
function o4Spaces() {
  return `<div class="o4">${nav()}<div class="page">
<div class="head"><h1 class="h1">Spaces</h1><span class="grow"></span><a class="btn primary" href="#">Add Space</a></div>
<div class="rows">${SPACES.map((s) => { const st = state(s); return `<a class="r${s.active ? "" : " off"}" href="#"><div><div class="n">${s.id}</div><div class="m">${s.cls[0].toUpperCase() + s.cls.slice(1)} · ${s.sources.length === 1 ? "1 route" : `${s.sources.length} routes`} · ${s.tokens.length === 1 ? "1 app" : `${s.tokens.length} apps`} · ${ago(s.updatedAt)}</div></div><div class="rt">${dot(st.tone)}<span class="${st.tone === "warn" ? "warn" : ""}">${st.text}</span></div></a>`; }).join("")}</div>
<p class="muted" style="margin-top:24px;font-size:13.5px">${dot("ok")} The Edge is serving your latest changes.</p></div></div>`;
}
function o4Body(s, editing) {
  const rows = s.sources.map((x) => {
    if (x.id !== editing) return routeRow(x);
    return `<div class="route open"><span class="pat">${pattern(x)}</span><span class="arr">${I.arrow}</span><span class="dst muted" style="font-family:var(--font)">Editing</span><span class="act"><a class="btn sm ghost" href="#">Close</a></span>
<div class="edit" style="font-family:var(--font)"><div class="ef">
  <div class="field wide"><label>Fetch from</label><input class="input mono" value="https://{project}.ufs.sh/f/{file}"><p>Each <span class="mono">{name}</span> is one path segment or one hostname label. The request pattern on the left follows them.</p></div>
  <div class="field"><label>Allowed values for <span class="mono">{project}</span></label><input class="input mono" value="8w0z32yftd, rrsku8h9ue"><p>Required for a hostname label.</p></div>
  <div class="field"><label>Allowed values for <span class="mono">{file}</span></label><input class="input mono" placeholder="Any value"></div>
  <div class="field wide"><label>Try a reference</label>${tryIt()}</div>
  <div class="bar"><button class="btn primary">Save</button><a class="btn" href="#">Cancel</a><span class="grow"></span><a class="btn ghost danger" href="#">Remove route</a></div>
</div></div></div>`;
  }).join("");
  return `<div class="page">
<div class="title"><h1 class="h1">ernesta</h1><span class="muted">public</span><span class="grow"></span><a class="btn" href="#">Settings</a><a class="btn primary" href="#">Add route</a></div>
<div class="sec"><div class="routes"><div class="hdr"><span>Request</span><span></span><span>Fetched from</span><span></span></div>${rows}</div></div>
<div class="sec two">
  <div><div class="sec-h"><h2 class="h2">Apps that can call Control</h2><a class="link" href="#">Issue token</a></div><div class="plain">${s.tokens.map((t) => `<div class="l"><div>${t.label}<div class="m">Last used ${ago(t.used, true)}</div></div><a class="btn sm ghost" href="#">Revoke</a></div>`).join("")}</div></div>
  <div><div class="sec-h"><h2 class="h2">Signing keys</h2><a class="link" href="#">Add key</a></div><div class="plain">${s.keys.map((k, i) => `<div class="l"><div class="mono trunc" title="${k.id}">${k.id}<div class="m" style="font-family:var(--font)">Since ${date(k.since)}${i === 1 ? ` · <span class="warn">disable after the switch</span>` : ""}</div></div><a class="btn sm ghost" href="#">Disable</a></div>`).join("")}</div></div>
</div>
<p class="muted" style="font-size:13.5px">Requests are served from <span class="mono">${EDGE}/v2/ernesta/</span>. Allowed origins and qualities are in <a class="link" href="#">Settings</a>.</p>
</div>`;
}
function o4Space() { return `<div class="o4">${nav(["ernesta"])}${o4Body(E, null)}</div>`; }
function o4Source() { return `<div class="o4">${nav(["ernesta"])}${o4Body(E, "uploadthing")}</div>`; }

// =====================================================================
// 5 — Routes · split
// =====================================================================
const CSS5 = `
.o5 .page{max-width:1180px;margin:0 auto;padding:40px 24px 80px}
.o5 .tbl{width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--s1)}
.o5 .tbl th{text-align:left;font-size:12.5px;font-weight:500;color:var(--fg2);padding:10px 20px;border-bottom:1px solid var(--line)}
.o5 .tbl td{padding:14px 20px;border-top:1px solid var(--line);vertical-align:middle}
.o5 .tbl tbody tr:first-child td{border-top:0}
.o5 .tbl tbody tr:hover td{background:var(--s2)}
.o5 .tbl .n{font-weight:600;font-size:15px}
.o5 .tbl .off td{opacity:.5}
.o5 .tbl .r{text-align:right;white-space:nowrap;color:var(--fg2)}
.o5 .split{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,1fr);gap:24px;align-items:start}
@media (max-width:960px){.o5 .split{grid-template-columns:1fr}}
.o5 .rail{display:grid;gap:16px}
.o5 .rail .plain .l{padding:12px 16px}
.o5 .rail h3{font-size:14px;font-weight:600;display:flex;align-items:center;gap:10px;margin-bottom:8px}
.o5 .rail h3 .link{margin-left:auto;font-size:13px;font-weight:400}
.o5 .ed{max-width:820px;margin:0 auto;padding:40px 24px 80px}
.o5 .ed .pat-h{font-family:var(--mono);font-size:22px;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere;line-height:1.4}
.o5 .ed .card{padding:24px;display:grid;gap:22px;margin-top:24px}
.o5 .ed .vals{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.o5 .ed .bar{display:flex;gap:10px;align-items:center;margin-top:20px}
`;
function o5Spaces() {
  return `<div class="o5">${nav()}<div class="page">
<div class="head"><h1 class="h1">Spaces</h1><span class="grow"></span><a class="btn primary" href="#">Add Space</a></div>
<table class="tbl"><thead><tr><th>Space</th><th>Routes</th><th>Apps</th><th>Status</th><th class="r">Changed</th></tr></thead><tbody>
${SPACES.map((s) => { const st = state(s); return `<tr class="${s.active ? "" : "off"}"><td><a class="n" href="#">${s.id}</a><div class="muted" style="font-size:13px">${s.cls}</div></td><td>${s.sources.length}</td><td>${s.tokens.length}</td><td><span class="row">${dot(st.tone)}<span class="${st.tone === "warn" ? "warn" : ""}">${st.text}</span></span></td><td class="r">${ago(s.updatedAt, true)}</td></tr>`; }).join("")}
</tbody></table>
<p class="muted" style="margin-top:24px;font-size:13.5px">${dot("ok")} The Edge is serving your latest changes.</p></div></div>`;
}
function o5Space() {
  const s = E;
  return `<div class="o5">${nav(["ernesta"])}<div class="page">
<div class="title"><h1 class="h1">ernesta</h1><span class="muted">public</span><span class="grow"></span><a class="btn" href="#">Settings</a><a class="btn primary" href="#">Add route</a></div>
<div class="split">
  <div class="routes"><div class="hdr"><span>Request</span><span></span><span>Fetched from</span><span></span></div>${s.sources.map((x) => routeRow(x)).join("")}</div>
  <aside class="rail">
    <div><h3>Apps <a class="link" href="#">Issue token</a></h3><div class="plain">${s.tokens.map((t) => `<div class="l"><div>${t.label}<div class="m">used ${ago(t.used, true)}</div></div><a class="btn sm ghost" href="#">Revoke</a></div>`).join("")}</div></div>
    <div><h3>Signing keys ${dot("warn")}<a class="link" href="#">Add key</a></h3><div class="plain">${s.keys.map((k) => `<div class="l"><div class="mono trunc" title="${k.id}">${k.id}<div class="m" style="font-family:var(--font)">since ${date(k.since)}</div></div><a class="btn sm ghost" href="#">Disable</a></div>`).join("")}</div><p class="muted" style="font-size:13px;margin-top:8px">Once your app mints with the new key, disable <span class="mono">k-2026-08</span>.</p></div>
    <div><h3>Allowed origins <a class="link" href="#">Edit</a></h3><div class="plain">${s.origins.map((o) => `<div class="l"><span class="mono trunc" title="${o}">${host(o)}</span><span class="muted" style="font-size:12.5px">deployed</span></div>`).join("")}</div></div>
  </aside>
</div>
<p class="muted" style="margin-top:24px;font-size:13.5px">Requests are served from <span class="mono">${EDGE}/v2/ernesta/</span>.</p>
</div></div>`;
}
function o5Source() {
  return `<div class="o5">${nav(["ernesta", "uploadthing"])}<div class="ed">
<a class="link" href="#" style="font-size:13.5px">← Routes</a>
<div class="pat-h" style="margin-top:12px">uploadthing/<b class="ph">{project}</b>/<b class="ph">{file}</b></div>
<p class="muted" style="margin-top:8px">URL template. The request pattern above follows the placeholders in the destination.</p>
<div class="card">
  <div class="field"><label>Fetch from</label><input class="input mono" value="https://{project}.ufs.sh/f/{file}" style="height:44px;font-size:15px"><p>Each <span class="mono">{name}</span> is one path segment or one hostname label. Expansions must stay inside the Space's allowed origins.</p></div>
  <div class="vals"><div class="field"><label><span class="mono">{project}</span> may be</label><input class="input mono" value="8w0z32yftd, rrsku8h9ue"><p>Required: it's in the hostname.</p></div><div class="field"><label><span class="mono">{file}</span> may be</label><input class="input mono" placeholder="Anything"></div></div>
  <div class="field" style="padding-top:18px;border-top:1px solid var(--line)"><label>Try a reference</label>${tryIt()}</div>
</div>
<div class="bar"><a class="btn danger" href="#">Remove route</a><span class="grow"></span><a class="btn" href="#">Cancel</a><button class="btn primary">Save route</button></div>
</div></div>`;
}

const screens = [[1, o1Spaces, o1Space, o1Source], [2, o2Spaces, o2Space, o2Source], [3, o3Spaces, o3Space, o3Source], [4, o4Spaces, o4Space, o4Source], [5, o5Spaces, o5Space, o5Source]]
  .map(([n, a, b, c]) => `<section class="screen" id="s-${n}-spaces">${a()}</section><section class="screen" id="s-${n}-space">${b()}</section><section class="screen" id="s-${n}-source">${c()}</section>`).join("\n");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shutter admin · design trials set 4</title><style>${BASE}${STUDIO}${NAV_CSS}${SITE_CSS}${ROUTE_CSS}${CSS1}${CSS2}${CSS3}${CSS4}${CSS5}</style></head><body>${studio()}
${screens}
</body></html>`;
writeFileSync(new URL("./index.html", import.meta.url), html);
console.log(`wrote index.html (${(html.length / 1024).toFixed(0)} KB)`);
