import type { SpacePolicy } from "@shutter/protocol";
import type { EdgeRefreshStatus } from "../edge-refresh-status.js";
import type { ApiTokenSummary, CapabilityKeySummary, SpaceRecord } from "../spaces/registry.js";
import { type DeploymentCoverage, sourceOriginPrefix } from "./deployment-coverage.js";

export interface AdminOverview {
  csrfToken: string;
  generation: number;
  spaces: readonly SpaceRecord[];
  coverage: DeploymentCoverage;
  edgeRefresh?: EdgeRefreshStatus;
  notice?: string;
}

export interface SpaceDetail {
  csrfToken: string;
  generation: number;
  space: SpaceRecord;
  apiTokens: readonly ApiTokenSummary[];
  capabilityKeys: readonly CapabilityKeySummary[];
  /** Coverage of this Space's origins alone, so the page can say what its own deployment lacks. */
  coverage: DeploymentCoverage;
  notice?: string;
  secret?: { label: string; value: string };
}

function htmlEscape(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A UTC timestamp at minute precision; the full instant travels in the `datetime` and `title` attributes. */
function time(value: Date): string {
  const iso = value.toISOString();
  return `<time datetime="${iso}" title="${iso}">${iso.slice(0, 10)} ${iso.slice(11, 16)}</time>`;
}

function timeOrNever(value: Date | undefined): string {
  return value === undefined ? '<span class="muted">never</span>' : time(value);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A hover-and-focus explanation glyph. The text is plain prose; it is escaped here. */
function hint(text: string): string {
  return `<span class="q" tabindex="0" role="note">?<span class="tip">${htmlEscape(text)}</span></span>`;
}

const HINTS = {
  generation:
    "The registry generation increments on every Space or policy change. The Edge Worker reports which generation it last loaded, so equal numbers mean the Edge serves current policy.",
  routeClass:
    "Fixed at creation. A public Space serves allowlisted provider files through its resolvers. A private Space requires a Source Capability on every request.",
  identifier:
    "Lowercase letters, digits, - and _, up to 64 characters. It appears in every Delivery URL, cannot change, and is never reused after decommissioning.",
  qualities:
    "WebP quality values a Delivery URL may request, comma-separated integers from 1 to 100. Anything outside the list is rejected.",
  defaultQuality: "Used when a Delivery URL omits quality. It must be one of the allowed values.",
  origins:
    "HTTPS origins or path prefixes Shutter may fetch Source Objects from, one per line. These also feed the imgproxy allowlist.",
  resolvers:
    "Each line maps a public provider locator, such as an UploadThing file key, to an allowlisted fetch location: resolver-id:project-id,project-id. Leave empty for a private Space.",
  apiTokens:
    "Bearer credential the consuming application uses to call Control: create Preview Jobs, request Source Purges. The full token is shown once, when issued.",
  capabilityKeys:
    "Shared symmetric key the application uses to mint Source Capabilities and Shutter uses to accept them. Rotate by adding a new key, installing it in the application, waiting 24 hours, then disabling the old one.",
  allowlist:
    "imgproxy fetches only from IMGPROXY_ALLOWED_SOURCES. This value is derived from every active Space's origins. Copy it into the deployment whenever it changes, keeping any extra Media Store source the deployment needs.",
  decommission:
    "Blocks new Space-scoped work and removes the Space from new Edge snapshots. Keeps the identifier and every audit record. Nothing is deleted, and the identifier is never reused.",
  fixed:
    "To change the identifier or route class, create a new Space, migrate the application to it, then decommission this one.",
} as const;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${htmlEscape(title)} · Shutter</title>
  <style>
    :root {
      color-scheme: light;
      --paper:#eef0ee; --panel:#fff; --ink:#151a18; --ink-2:#4d5652; --ink-3:#8a938e;
      --rule:#d5dad6; --rule-2:#e7eae7;
      --brand:#0b6b52; --brand-ink:#05483a; --brand-bg:#e4f2ec;
      --amber:#b8670f; --amber-bg:#fff3df; --amber-ink:#6e3d05; --red:#a83232; --red-bg:#fbe9e9;
      --sans:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif;
      --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    }
    * { box-sizing:border-box; }
    body { margin:0; font:13px/1.45 var(--sans); color:var(--ink); background:var(--paper); }
    a { color:var(--brand-ink); text-decoration:none; }
    a:hover { text-decoration:underline; text-underline-offset:2px; }
    h1, h2 { margin:0; line-height:1.2; }
    h1 { font-size:17px; font-weight:650; letter-spacing:-.01em; }
    h2 { font-size:13px; font-weight:650; }
    code, .mono { font:12px var(--mono); }
    code { background:#f1f3f1; border:1px solid var(--rule-2); border-radius:3px; padding:0 4px; overflow-wrap:anywhere; }
    time, .num { font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--ink-3); }
    .dim { color:var(--ink-2); }
    .sp { flex:1; }
    .lbl { font:600 10.5px/1 var(--sans); letter-spacing:.07em; text-transform:uppercase; color:var(--ink-3); }

    .top { height:38px; display:flex; align-items:center; gap:14px; padding:0 16px; background:var(--panel); border-bottom:1px solid var(--rule); }
    .brand { font:800 11.5px var(--sans); letter-spacing:.12em; color:var(--ink); }
    .crumbs { display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--ink-2); }
    .crumbs b { color:var(--ink); font-weight:600; }
    .crumbs .sep { color:var(--ink-3); }
    .page { padding:14px 18px 40px; display:grid; gap:14px; max-width:1240px; margin:0 auto; }
    .narrow { max-width:32rem; }

    .panel { background:var(--panel); border:1px solid var(--rule); border-radius:8px; }
    .sect { overflow:hidden; }
    .head { display:flex; align-items:center; gap:10px; padding:7px 10px; border-bottom:1px solid var(--rule); background:#fafbfa; }
    .titlerow { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .titlerow h1.mono { font-size:17px; }
    .health { display:flex; align-items:center; gap:10px; padding:10px 12px; font-size:13px; }
    .health p { margin:0; }
    .health .ok { color:var(--brand-ink); font-weight:600; }
    .health .warn { color:var(--amber); font-weight:600; }
    .below { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start; }

    table { width:100%; border-collapse:collapse; }
    th { text-align:left; font:600 10.5px/1 var(--sans); letter-spacing:.07em; text-transform:uppercase; color:var(--ink-3); padding:6px 10px; border-bottom:1px solid var(--rule); white-space:nowrap; }
    td { padding:6px 10px; border-bottom:1px solid var(--rule-2); vertical-align:middle; overflow-wrap:anywhere; }
    td.r { white-space:nowrap; }
    tr:last-child td { border-bottom:0; }
    td.r, th.r { text-align:right; }
    tr.off td { color:var(--ink-3); }
    tr.off td a { color:var(--ink-3); }
    .tbl td:first-child { font:500 12.5px var(--mono); }
    .quick a { font-size:11.5px; color:var(--ink-2); margin-right:8px; white-space:nowrap; }
    .quick a:hover { color:var(--brand-ink); }
    .origins { display:grid; gap:2px; font:12px var(--mono); color:var(--ink-2); }
    .origins span { display:flex; align-items:center; gap:6px; }

    .pill { display:inline-flex; align-items:center; gap:5px; font:600 11px/1 var(--sans); padding:3px 7px; border-radius:999px; background:#eceeec; color:var(--ink-2); white-space:nowrap; }
    .pill::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--ink-3); }
    .pill.ok { background:var(--brand-bg); color:var(--brand-ink); } .pill.ok::before { background:var(--brand); }
    .pill.warn { background:var(--amber-bg); color:var(--amber); } .pill.warn::before { background:var(--amber); }
    .pill.xs { padding:1px 5px; font-size:10.5px; }
    .chip { display:inline-block; font:600 10.5px/1 var(--mono); letter-spacing:.04em; padding:3px 6px; border-radius:4px; border:1px solid var(--rule); color:var(--ink-2); text-transform:uppercase; }
    .chip.pub { border-color:#b9d9cc; color:var(--brand-ink); background:#f2faf6; }

    button, .btn { display:inline-flex; align-items:center; gap:6px; font:600 12px/1 var(--sans); padding:6px 10px; border-radius:6px; border:1px solid var(--rule); background:var(--panel); color:var(--ink); cursor:pointer; white-space:nowrap; }
    .pri { background:var(--brand); border-color:var(--brand); color:#fff; }
    .dng { color:var(--red); border-color:#e6c4c4; }
    .sm { padding:3px 7px; font-size:11px; }
    .ghost { border-color:transparent; background:transparent; color:var(--ink-2); }
    input, select, textarea { font:12.5px var(--sans); color:var(--ink); border:1px solid #c3c9c4; border-radius:5px; padding:5px 8px; background:var(--panel); width:100%; }
    textarea { font:12px/1.5 var(--mono); min-height:52px; resize:vertical; }
    .f { display:grid; gap:4px; margin:0; }
    .f > span { font:600 12px var(--sans); display:flex; align-items:center; }
    .f small { color:var(--ink-3); font-size:11px; }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:10px; }
    .grid2 .wide { grid-column:1 / -1; }
    .actions { display:flex; justify-content:flex-end; align-items:center; gap:8px; padding:0 10px 10px; }
    .actions .muted { margin-right:auto; font-size:11.5px; }
    .inl { display:grid; grid-template-columns:1fr auto; gap:8px; padding:8px 10px; border-top:1px solid var(--rule-2); background:#fafbfa; align-items:center; }
    .inline { display:inline; }
    .empty { padding:10px; color:var(--ink-3); }

    .notice { border-left:3px solid var(--brand); background:var(--brand-bg); color:var(--brand-ink); padding:8px 12px; border-radius:6px; margin:0; font-size:12.5px; }
    .warnbox { background:var(--amber-bg); border:1px solid #f0d9b4; color:var(--amber-ink); border-radius:6px; padding:7px 10px; font-size:12.5px; margin:0; }
    .warnbox ul { margin:4px 0 0; padding-left:18px; }
    .secret { font:12px var(--mono); background:#13231e; color:#e5fff7; padding:8px 10px; border-radius:6px; overflow-wrap:anywhere; }
    .reveal { padding:10px 12px; display:grid; gap:6px; border-color:#f0d9b4; background:var(--amber-bg); }
    .reveal h2 { color:var(--amber-ink); }
    .allow { padding:10px; display:grid; gap:8px; }
    .rot { display:grid; grid-template-columns:repeat(3,1fr); font-size:11.5px; color:var(--ink-2); border-top:1px solid var(--rule-2); }
    .rot div { padding:7px 10px; border-right:1px solid var(--rule-2); }
    .rot div:last-child { border-right:0; }
    .rot b { display:block; font:600 10.5px var(--sans); letter-spacing:.07em; text-transform:uppercase; color:var(--ink-3); margin-bottom:2px; }
    .kv { margin:0; padding:10px; display:grid; grid-template-columns:auto 1fr; gap:6px 14px; font-size:12.5px; }
    .kv dt { color:var(--ink-3); }
    .kv dd { margin:0; }

    .q { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:50%; border:1px solid #b6bcb7; color:var(--ink-3); font:700 9.5px/1 var(--sans); margin-left:5px; position:relative; cursor:help; vertical-align:1px; text-transform:none; letter-spacing:0; flex:none; }
    .q:hover, .q:focus { border-color:var(--ink-2); color:var(--ink-2); outline:none; }
    .q .tip { position:absolute; left:0; top:calc(100% + 7px); width:270px; background:#1b211f; color:#fff; font:400 11.5px/1.45 var(--sans); text-transform:none; letter-spacing:0; padding:8px 10px; border-radius:6px; z-index:30; display:none; text-align:left; box-shadow:0 8px 24px #0004; white-space:normal; }
    .q:hover .tip, .q:focus .tip { display:block; }
    td.r .q .tip, .head .q.l .tip { left:auto; right:0; }

    .layout { display:grid; grid-template-columns:240px minmax(0,1fr); gap:18px; align-items:start; }
    .col { display:grid; gap:14px; min-width:0; }
    .side { position:sticky; top:12px; display:grid; gap:8px; }
    .jump { display:grid; gap:1px; font-size:12.5px; }
    .jump a { display:flex; justify-content:space-between; padding:5px 8px; border-radius:5px; color:var(--ink-2); }
    .jump a b { font:600 10.5px var(--mono); color:var(--ink-3); }
    .jump a.dng { color:var(--red); margin-top:8px; border:0; background:transparent; }
    body:has(#policy:target) .jump a[href="#policy"], body:has(#tokens:target) .jump a[href="#tokens"], body:has(#keys:target) .jump a[href="#keys"], body:has(#decommission:target) .jump a[href="#decommission"] { background:var(--panel); color:var(--ink); font-weight:600; box-shadow:inset 2px 0 0 var(--brand); }
    .side .panel { padding:10px 12px; display:grid; gap:6px; font-size:12px; }
    .side dl { margin:0; display:grid; gap:5px; }
    .side .rw { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .side dt { color:var(--ink-3); font-size:11px; white-space:nowrap; }
    .side dd { margin:0; text-align:right; }
    .decom { border-color:#e6c4c4; }
    .decom .head { border-color:#f0d9d9; }
    .decom .head h2 { color:var(--red); }
    .decom .inl { grid-template-columns:minmax(0,320px) auto; justify-content:start; border-top:0; }

    @media (max-width: 1100px) {
      .layout { grid-template-columns:1fr; }
      .side { position:static; }
      .jump { display:flex; flex-wrap:wrap; gap:4px; }
      .jump a.dng { margin-top:0; }
    }
    @media (max-width: 760px) {
      .below, .grid2 { grid-template-columns:1fr; }
      .grid2 .wide { grid-column:auto; }
      .rot { grid-template-columns:1fr; }
      .rot div { border-right:0; border-bottom:1px solid var(--rule-2); }
      table { display:block; overflow-x:auto; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function header(csrfToken?: string, crumb?: string): string {
  const crumbs =
    crumb === undefined
      ? '<span class="crumbs"><b>Spaces</b></span>'
      : `<span class="crumbs"><a href="/admin">Spaces</a><span class="sep">/</span><b class="mono">${htmlEscape(crumb)}</b></span>`;
  const signOut =
    csrfToken === undefined
      ? ""
      : `<form class="inline" method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><button class="ghost sm" type="submit">Sign out</button></form>`;
  return `<header class="top"><a class="brand" href="/admin">SHUTTER</a>${crumbs}<span class="sp"></span>${signOut}</header>`;
}

function statusPill(space: SpaceRecord): string {
  return space.status === "active"
    ? '<span class="pill ok">active</span>'
    : '<span class="pill">decommissioned</span>';
}

function routeClassChip(policy: SpacePolicy): string {
  return `<span class="chip${policy.routeClass === "public" ? " pub" : ""}">${policy.routeClass}</span>`;
}

function policyFields(policy?: SpacePolicy): string {
  const origins = policy?.allowedSourceOrigins.map(sourceOriginPrefix).join("\n");
  const resolvers = policy?.resolvers
    .map((resolver) => `${resolver.id}:${resolver.allowedProjectIds.join(",")}`)
    .join("\n");
  return `<label class="f"><span>Allowed qualities${hint(HINTS.qualities)}</span>
    <input name="qualities" required value="${htmlEscape(policy?.qualities.join(", ") ?? "75")}"></label>
  <label class="f"><span>Default quality${hint(HINTS.defaultQuality)}</span>
    <input name="defaultQuality" type="number" min="1" max="100" required value="${htmlEscape(policy?.defaultQuality ?? 75)}"></label>
  <label class="f wide"><span>Allowed source origins${hint(HINTS.origins)}</span>
    <textarea name="allowedSourceOrigins" rows="2" required placeholder="https://media.example.com/uploads">${htmlEscape(origins ?? "")}</textarea></label>
  <label class="f wide"><span>Public-Space resolvers${hint(HINTS.resolvers)}</span>
    <textarea name="resolvers" rows="1" placeholder="uploadthing:project_one,project_two">${htmlEscape(resolvers ?? "")}</textarea></label>`;
}

export function loginView(error?: string): string {
  return shell(
    "Sign in",
    `${header()}<main class="page narrow">
    <form class="panel sect" method="post" action="/admin/login">
      <div class="head"><h1>Sign in</h1></div>
      <div class="grid2">
        ${error === undefined ? "" : `<p class="warnbox wide">${htmlEscape(error)}</p>`}
        <label class="f wide"><span>Bootstrap token</span><input name="token" type="password" minlength="32" required autocomplete="current-password"></label>
      </div>
      <div class="actions"><span class="muted">The session lasts 15 minutes.</span><button class="pri" type="submit">Sign in</button></div>
    </form></main>`,
  );
}

export function unavailableView(): string {
  return shell(
    "Unavailable",
    `${header()}<main class="page narrow"><div class="panel sect"><div class="head"><h1>Admin is unavailable</h1></div><p class="empty">Configure Postgres, <code>ADMIN_BOOTSTRAP_TOKEN</code>, and <code>SHUTTER_ENCRYPTION_KEY</code>, then try again.</p></div></main>`,
  );
}

export function errorView(csrfToken: string, status: number, message: string): string {
  return shell(
    "Request failed",
    `${header(csrfToken)}<main class="page narrow"><div class="panel sect"><div class="head"><h1>Request failed</h1><span class="sp"></span><span class="muted num">Status ${status}</span></div><div class="allow"><p class="warnbox">${htmlEscape(message)}</p><p class="muted" style="margin:0">Use the browser's back button to return to the form with your values, or <a href="/admin">return to Spaces</a>.</p></div></div></main>`,
  );
}

function edgeSentence(generation: number, refresh: EdgeRefreshStatus | undefined): string {
  if (refresh === undefined) {
    return '<span class="warn">Latest Edge refresh: not reported yet</span>; the Edge reports after its first successful snapshot refresh.';
  }
  const lag = generation - refresh.generation;
  const state =
    lag <= 0
      ? '<span class="ok">in sync</span>'
      : `<span class="warn">behind by ${plural(lag, "generation")}</span>`;
  return `Latest Edge refresh: generation <span class="num">${refresh.generation}</span>, ${state}, at ${time(refresh.refreshedAt)}.`;
}

function allowlistSentence(coverage: DeploymentCoverage): string {
  const count = coverage.uncovered.length;
  if (count === 0) {
    return '<span class="ok">Every active source origin</span> is in the imgproxy allowlist.';
  }
  return `<span class="warn">${plural(count, "active source origin")}</span> ${count === 1 ? "is" : "are"} missing from the imgproxy allowlist.`;
}

function allowlistSection(coverage: DeploymentCoverage): string {
  const uncovered = coverage.uncovered
    .map((origin) => `<li><code>${htmlEscape(origin)}</code></li>`)
    .join("");
  const status =
    uncovered === ""
      ? '<p class="notice">The deployed allowlist covers every active Space origin.</p>'
      : `<div class="warnbox"><strong>Deployment update required.</strong> The deployed value lacks:<ul>${uncovered}</ul></div>`;
  return `<section class="panel sect" id="allowlist">
    <div class="head"><h2>imgproxy allowlist${hint(HINTS.allowlist)}</h2><span class="sp"></span><span class="muted">paste into <code>IMGPROXY_ALLOWED_SOURCES</code></span></div>
    <div class="allow"><div class="secret">${htmlEscape(coverage.derivedValue || "No active Space origins")}</div>${status}</div>
  </section>`;
}

function spaceRow(space: SpaceRecord, uncovered: readonly string[]): string {
  const id = encodeURIComponent(space.policy.id);
  const href = `/admin/spaces/${id}`;
  const origins = space.policy.allowedSourceOrigins
    .map((rule) => {
      const prefix = sourceOriginPrefix(rule);
      const flag =
        space.status === "active" && uncovered.includes(prefix)
          ? ' <span class="pill warn xs">not deployed</span>'
          : "";
      return `<span>${htmlEscape(prefix.replace(/^https:\/\//u, ""))}${flag}</span>`;
    })
    .join("");
  const quick =
    space.status === "active"
      ? `<a href="${href}#policy">Policy</a><a href="${href}#tokens">Tokens</a><a href="${href}#keys">Keys</a>`
      : `<a href="${href}">Records</a>`;
  return `<tr${space.status === "active" ? "" : ' class="off"'}><td><a href="${href}">${htmlEscape(space.policy.id)}</a></td><td>${routeClassChip(space.policy)}</td><td>${statusPill(space)}</td><td><div class="origins">${origins || '<span class="muted">—</span>'}</div></td><td class="dim">${time(space.updatedAt)}</td><td class="quick">${quick}</td></tr>`;
}

export function overviewView(model: AdminOverview): string {
  const active = model.spaces.filter((space) => space.status === "active").length;
  const rows = model.spaces.map((space) => spaceRow(space, model.coverage.uncovered)).join("");
  const fix =
    model.coverage.uncovered.length === 0
      ? ""
      : '<a class="btn sm" href="#allowlist">Fix allowlist ↓</a>';
  return shell(
    "Spaces",
    `${header(model.csrfToken)}<main class="page">
      ${model.notice === undefined ? "" : `<p class="notice">${htmlEscape(model.notice)}</p>`}
      <section class="panel health">
        <p>Registry generation <span class="num">${model.generation}</span>${hint(HINTS.generation)}. ${edgeSentence(model.generation, model.edgeRefresh)} ${allowlistSentence(model.coverage)}</p>
        <span class="sp"></span>${fix}
      </section>
      <div class="titlerow"><h1>Spaces</h1><span class="muted">${model.spaces.length} · ${active} active</span><span class="sp"></span><a class="btn pri sm" href="#create">+ New Space</a></div>
      <section class="panel sect tbl">
        <table><thead><tr><th>Space</th><th>Class${hint(HINTS.routeClass)}</th><th>Status</th><th>Origins</th><th>Updated</th><th>Jump to</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">No Spaces yet. Create one below.</td></tr>'}</tbody></table>
      </section>
      <div class="below">
        ${allowlistSection(model.coverage)}
        <form class="panel sect" id="create" method="post" action="/admin/spaces">
          <input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}">
          <div class="head"><h2>Create a Space</h2><span class="sp"></span><span class="muted">identifier and class are permanent</span></div>
          <div class="grid2">
            <label class="f"><span>Identifier${hint(HINTS.identifier)}</span><input name="spaceId" required pattern="[a-z0-9][a-z0-9_-]*" maxlength="64" placeholder="my-app"></label>
            <label class="f"><span>Route class${hint(HINTS.routeClass)}</span><select name="routeClass"><option value="private">Private</option><option value="public">Public</option></select></label>
            ${policyFields()}
          </div>
          <div class="actions"><span class="muted">Creating bumps the registry to generation ${model.generation + 1}.</span><button class="pri" type="submit">Create Space</button></div>
        </form>
      </div>
    </main>`,
  );
}

function rotationState(space: SpaceRecord, keys: readonly CapabilityKeySummary[]): string {
  if (space.status !== "active") return '<span class="muted">Keys are read-only records.</span>';
  const accepting = keys.filter((key) => key.disabledAt === undefined);
  if (accepting.length === 0) {
    return `<span class="pill warn">no key accepting</span><span>The application cannot mint Source Capabilities until a key exists.</span>`;
  }
  if (accepting.length === 1) {
    const key = accepting[0];
    if (key === undefined) return "";
    return `<span>One key accepting: <code>${htmlEscape(key.keyId)}</code>, since ${time(key.acceptedAt)}.</span>`;
  }
  const newest = accepting.reduce((latest, key) =>
    key.acceptedAt > latest.acceptedAt ? key : latest,
  );
  return `<span class="pill warn">rotation in progress</span><span>${accepting.length} keys accepting. Once the application mints with <code>${htmlEscape(newest.keyId)}</code> and 24 hours have passed since ${time(newest.acceptedAt)}, disable the older ${accepting.length === 2 ? "key" : "keys"}.</span>`;
}

function deploymentState(coverage: DeploymentCoverage, space: SpaceRecord): string {
  if (space.status !== "active") return '<span class="muted">Not part of the allowlist.</span>';
  if (coverage.uncovered.length === 0) {
    return '<span class="pill ok">all origins deployed</span>';
  }
  const list = coverage.uncovered
    .map((origin) => `<code>${htmlEscape(origin.replace(/^https:\/\//u, ""))}</code>`)
    .join(" ");
  return `<span class="pill warn">${plural(coverage.uncovered.length, "origin")} not deployed</span><span>${list}</span><a href="/admin#allowlist">Open the allowlist</a>`;
}

function tokenRows(model: SpaceDetail): string {
  const id = encodeURIComponent(model.space.policy.id);
  return model.apiTokens
    .map((token) => {
      const live = token.revokedAt === undefined;
      const action =
        live && model.space.status === "active"
          ? `<form class="inline" method="post" action="/admin/spaces/${id}/api-tokens/${token.id}/revoke"><input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}"><button class="sm dng" type="submit">Revoke</button></form>`
          : live
            ? ""
            : `<span class="pill">revoked ${time(token.revokedAt ?? new Date(0))}</span>`;
      return `<tr${live ? "" : ' class="off"'}><td>${htmlEscape(token.label)}</td><td class="mono">${htmlEscape(token.displayPrefix)}…</td><td class="dim">${time(token.createdAt)}</td><td>${timeOrNever(token.lastUsedAt)}</td><td class="r">${action}</td></tr>`;
    })
    .join("");
}

function keyRows(model: SpaceDetail): string {
  const id = encodeURIComponent(model.space.policy.id);
  return model.capabilityKeys
    .map((key) => {
      const live = key.disabledAt === undefined;
      const action =
        live && model.space.status === "active"
          ? `<form class="inline" method="post" action="/admin/spaces/${id}/capability-keys/${encodeURIComponent(key.keyId)}/disable"><input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}"><button class="sm dng" type="submit">Disable now</button></form>`
          : "";
      return `<tr${live ? "" : ' class="off"'}><td class="mono">${htmlEscape(key.keyId)}</td><td class="dim">${time(key.acceptedAt)}</td><td>${key.disabledAt === undefined ? '<span class="muted">—</span>' : time(key.disabledAt)}</td><td class="r">${action}</td></tr>`;
    })
    .join("");
}

export function spaceView(model: SpaceDetail): string {
  const { policy } = model.space;
  const id = encodeURIComponent(policy.id);
  const active = model.space.status === "active";
  const csrf = `<input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}">`;
  const activeTokens = model.apiTokens.filter((token) => token.revokedAt === undefined).length;
  const acceptingKeys = model.capabilityKeys.filter((key) => key.disabledAt === undefined).length;

  const policySection = active
    ? `<form class="panel sect" id="policy" method="post" action="/admin/spaces/${id}/policy">${csrf}
        <div class="head"><h2>Policy</h2><span class="muted">identifier and class are fixed${hint(HINTS.fixed)}</span><span class="sp"></span><span class="muted">saving → generation ${model.generation + 1}</span><button class="pri sm" type="submit">Save policy</button></div>
        <div class="grid2">${policyFields(policy)}</div>
      </form>`
    : `<section class="panel sect" id="policy">
        <div class="head"><h2>Policy</h2><span class="sp"></span><span class="muted">read-only: this Space is decommissioned</span></div>
        <dl class="kv">
          <dt>Qualities</dt><dd>${htmlEscape(policy.qualities.join(", "))} · default ${policy.defaultQuality}</dd>
          <dt>Source origins</dt><dd class="mono">${policy.allowedSourceOrigins.map((rule) => htmlEscape(sourceOriginPrefix(rule))).join("<br>") || "—"}</dd>
          <dt>Resolvers</dt><dd class="mono">${policy.resolvers.map((resolver) => htmlEscape(`${resolver.id}:${resolver.allowedProjectIds.join(",")}`)).join("<br>") || "—"}</dd>
        </dl>
      </section>`;

  const issueToken = active
    ? `<form class="inl" method="post" action="/admin/spaces/${id}/api-tokens">${csrf}<input name="label" required maxlength="128" placeholder="New token label, e.g. production deploy" aria-label="New token label"><button type="submit">Issue token</button></form>`
    : "";
  const generateKey = active
    ? `<form class="inl" method="post" action="/admin/spaces/${id}/capability-keys">${csrf}<input name="keyId" required maxlength="64" pattern="[A-Za-z0-9_-]+" placeholder="New key identifier, e.g. k-2026-11" aria-label="New key identifier"><button type="submit">Generate key</button></form>`
    : "";

  const decommissionJump = active ? '<a href="#decommission" class="dng">Decommission</a>' : "";
  const decommissionSection = active
    ? `<form class="panel sect decom" id="decommission" method="post" action="/admin/spaces/${id}/decommission">${csrf}
        <div class="head"><h2>Decommission${hint(HINTS.decommission)}</h2><span class="muted">blocks new work, keeps records, never frees the identifier</span></div>
        <div class="inl"><input name="confirm" required pattern="${htmlEscape(policy.id)}" placeholder="Type ${htmlEscape(policy.id)} to confirm" aria-label="Type the identifier to confirm" autocomplete="off"><button class="dng" type="submit">Decommission Space</button></div>
      </form>`
    : "";

  const decommissionedAt = model.space.decommissionedAt;

  return shell(
    policy.id,
    `${header(model.csrfToken, policy.id)}<main class="page">
      ${model.notice === undefined ? "" : `<p class="notice">${htmlEscape(model.notice)}</p>`}
      ${model.secret === undefined ? "" : `<section class="panel reveal"><h2>${htmlEscape(model.secret.label)}</h2><span class="dim">This secret is shown once. Copy it now into the application's secret store.</span><div class="secret">${htmlEscape(model.secret.value)}</div></section>`}
      <div class="layout">
        <aside class="side">
          <nav class="jump" aria-label="Sections">
            <a href="#policy">Policy</a>
            <a href="#tokens">API tokens<b>${activeTokens}</b></a>
            <a href="#keys">Capability Keys<b>${acceptingKeys}</b></a>
            ${decommissionJump}
          </nav>
          <div class="panel"><dl>
            <div class="rw"><dt>Route class${hint(HINTS.routeClass)}</dt><dd>${policy.routeClass}</dd></div>
            <div class="rw"><dt>Status</dt><dd>${statusPill(model.space)}</dd></div>
            <div class="rw"><dt>Registry generation</dt><dd class="num">${model.generation}</dd></div>
            <div class="rw"><dt>Created</dt><dd>${time(model.space.createdAt)}</dd></div>
            <div class="rw"><dt>Policy updated</dt><dd>${time(model.space.updatedAt)}</dd></div>
            ${decommissionedAt === undefined ? "" : `<div class="rw"><dt>Decommissioned</dt><dd>${time(decommissionedAt)}</dd></div>`}
          </dl></div>
          <div class="panel"><span class="lbl">Rotation state</span>${rotationState(model.space, model.capabilityKeys)}</div>
          <div class="panel"><span class="lbl">Deployment</span>${deploymentState(model.coverage, model.space)}</div>
        </aside>
        <div class="col">
          <div class="titlerow"><h1 class="mono">${htmlEscape(policy.id)}</h1>${routeClassChip(policy)}${statusPill(model.space)}</div>
          ${policySection}
          <section class="panel sect" id="tokens">
            <div class="head"><h2>API tokens${hint(HINTS.apiTokens)}</h2><span class="muted num">${activeTokens} active · ${model.apiTokens.length - activeTokens} revoked</span><span class="sp"></span></div>
            ${
              model.apiTokens.length === 0
                ? `<p class="empty">No API tokens.${active ? " Issue one so the application can call Control." : ""}</p>`
                : `<table><thead><tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${tokenRows(model)}</tbody></table>`
            }
            ${issueToken}
          </section>
          <section class="panel sect" id="keys">
            <div class="head"><h2>Capability Keys${hint(HINTS.capabilityKeys)}</h2><span class="muted num">${acceptingKeys} accepting · ${model.capabilityKeys.length - acceptingKeys} disabled</span><span class="sp"></span></div>
            ${
              model.capabilityKeys.length === 0
                ? `<p class="empty">No Capability Keys.${active ? " The application cannot mint Source Capabilities until one exists." : ""}</p>`
                : `<table><thead><tr><th>Key identifier</th><th>Accepted</th><th>Disabled</th><th></th></tr></thead><tbody>${keyRows(model)}</tbody></table>`
            }
            ${
              active
                ? '<div class="rot"><div><b>1 · Add</b>Generate a new key identifier.</div><div><b>2 · Install</b>Make it the application\'s minting key, then wait 24 hours.</div><div><b>3 · Disable</b>Disable the old key here. Disable a compromised key immediately.</div></div>'
                : ""
            }
            ${generateKey}
          </section>
          ${decommissionSection}
        </div>
      </div>
    </main>`,
  );
}
