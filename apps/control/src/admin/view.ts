import { normalizeSourceOriginPathPrefix, type SpacePolicy } from "@shutter/protocol";
import type { EdgeRefreshStatus } from "../edge-refresh-status.js";
import type { ApiTokenSummary, CapabilityKeySummary, SpaceRecord } from "../spaces/registry.js";
import type { DeploymentCoverage } from "./deployment-coverage.js";

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
  notice?: string;
  secret?: { label: string; value: string };
}

function htmlEscape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function date(value: Date | undefined): string {
  return value === undefined ? "Never" : htmlEscape(value.toISOString());
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${htmlEscape(title)} · Shutter</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; background:#f5f4ef; color:#18201c; }
    * { box-sizing:border-box; }
    body { margin:0; }
    header, main { width:min(72rem, calc(100% - 2rem)); margin:auto; }
    header { display:flex; align-items:center; justify-content:space-between; padding:1.3rem 0; }
    main { padding-bottom:5rem; }
    h1,h2,h3 { line-height:1.15; }
    h1 { font-size:clamp(2rem,6vw,4.4rem); letter-spacing:-.06em; margin:.5rem 0 1.5rem; }
    h2 { margin-top:2rem; }
    a { color:#08634d; text-underline-offset:.2em; }
    .brand { font-weight:800; letter-spacing:.08em; text-decoration:none; color:inherit; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(17rem,1fr)); gap:1rem; }
    .card, form.panel { background:#fff; border:1px solid #d8d8cf; border-radius:.8rem; padding:1.1rem; box-shadow:0 1px 1px #1720190d; }
    .metric { font-size:2rem; font-weight:750; }
    label { display:grid; gap:.35rem; margin:.85rem 0; font-weight:650; }
    input, select, textarea, button { font:inherit; }
    input, select, textarea { width:100%; border:1px solid #a9ada5; border-radius:.4rem; padding:.65rem; background:#fff; }
    textarea { min-height:7rem; resize:vertical; font-family:ui-monospace,monospace; }
    button, .button { display:inline-block; border:0; border-radius:999px; padding:.65rem 1rem; background:#08634d; color:#fff; font-weight:750; cursor:pointer; text-decoration:none; }
    button.danger { background:#a52c2c; }
    button.secondary { background:#444b47; }
    table { width:100%; border-collapse:collapse; background:#fff; }
    th,td { text-align:left; border-bottom:1px solid #deded7; padding:.65rem; vertical-align:top; }
    code, .secret { font-family:ui-monospace,monospace; overflow-wrap:anywhere; }
    .secret { padding:1rem; background:#13231e; color:#e5fff7; border-radius:.5rem; }
    .notice { border-left:.35rem solid #16886a; background:#e8f5f0; padding:.8rem 1rem; }
    .warning { border-left-color:#d38318; background:#fff4dd; }
    .danger-zone { border-color:#e4afaf !important; }
    .muted { color:#5c655f; }
    .inline { display:inline; }
    .inline button { padding:.35rem .7rem; }
    .status { font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; font-weight:800; }
    @media (max-width:42rem) { table { display:block; overflow-x:auto; } }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function header(csrfToken?: string): string {
  return `<header><a class="brand" href="/admin">SHUTTER / ADMIN</a>${
    csrfToken === undefined
      ? ""
      : `<form class="inline" method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><button class="secondary" type="submit">Sign out</button></form>`
  }</header>`;
}

function policyFields(policy?: SpacePolicy): string {
  const origins = policy?.allowedSourceOrigins
    .map((rule) => {
      const pathPrefix = normalizeSourceOriginPathPrefix(rule.pathPrefix);
      return `${rule.origin}${pathPrefix === "/" ? "" : pathPrefix}`;
    })
    .join("\n");
  const resolvers = policy?.resolvers
    .map((resolver) => `${resolver.id}:${resolver.allowedProjectIds.join(",")}`)
    .join("\n");
  return `<label>Allowed qualities
    <input name="qualities" required value="${htmlEscape(policy?.qualities.join(", ") ?? "75")}" aria-describedby="qualities-help">
    <small id="qualities-help" class="muted">Comma-separated integers from 1 to 100.</small>
  </label>
  <label>Default quality
    <input name="defaultQuality" type="number" min="1" max="100" required value="${htmlEscape(policy?.defaultQuality ?? 75)}">
  </label>
  <label>Allowed source origins
    <textarea name="allowedSourceOrigins" required placeholder="https://media.example.com/uploads">${htmlEscape(origins ?? "")}</textarea>
    <small class="muted">One HTTPS origin or path prefix per line.</small>
  </label>
  <label>Public-Space resolvers
    <textarea name="resolvers" placeholder="uploadthing:project_one,project_two">${htmlEscape(resolvers ?? "")}</textarea>
    <small class="muted">One <code>resolver-id:project-id,project-id</code> entry per line. Leave empty for a private Space.</small>
  </label>`;
}

export function loginView(error?: string): string {
  return shell(
    "Sign in",
    `${header()}<main><h1>Manage Spaces</h1>
    <form class="panel" method="post" action="/admin/login" style="max-width:32rem">
      ${error === undefined ? "" : `<p class="notice warning">${htmlEscape(error)}</p>`}
      <label>Bootstrap token<input name="token" type="password" minlength="32" required autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form></main>`,
  );
}

export function unavailableView(): string {
  return shell(
    "Unavailable",
    `${header()}<main><h1>Admin is unavailable</h1><p>Configure Postgres, <code>ADMIN_BOOTSTRAP_TOKEN</code>, and <code>SHUTTER_ENCRYPTION_KEY</code>, then try again.</p></main>`,
  );
}

export function errorView(csrfToken: string, status: number, message: string): string {
  return shell(
    "Request failed",
    `${header(csrfToken)}<main><h1>Request failed</h1><p class="notice warning">${htmlEscape(message)}</p><p><a href="/admin">Return to Spaces</a></p><p class="muted">Status ${status}</p></main>`,
  );
}

export function overviewView(model: AdminOverview): string {
  const refresh = model.edgeRefresh;
  const rows = model.spaces
    .map(
      (space) =>
        `<tr><td><a href="/admin/spaces/${encodeURIComponent(space.policy.id)}"><code>${htmlEscape(space.policy.id)}</code></a></td><td>${htmlEscape(space.policy.routeClass)}</td><td><span class="status">${htmlEscape(space.status)}</span></td><td>${date(space.updatedAt)}</td></tr>`,
    )
    .join("");
  const uncovered = model.coverage.uncovered
    .map((origin) => `<li><code>${htmlEscape(origin)}</code></li>`)
    .join("");
  return shell(
    "Spaces",
    `${header(model.csrfToken)}<main><h1>Spaces</h1>
      ${model.notice === undefined ? "" : `<p class="notice">${htmlEscape(model.notice)}</p>`}
      <section class="grid">
        <article class="card"><div class="muted">Registry generation</div><div class="metric">${model.generation}</div></article>
        <article class="card"><div class="muted">Latest Edge refresh</div><div class="metric">${refresh === undefined ? "Not reported" : refresh.generation}</div><div>${refresh === undefined ? "Edge reports after a successful snapshot refresh." : date(refresh.refreshedAt)}</div></article>
      </section>
      <h2>Registered Spaces</h2>
      <table><thead><tr><th>Identifier</th><th>Route class</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No Spaces exist.</td></tr>'}</tbody></table>
      <h2>Create a Space</h2>
      <form class="panel" method="post" action="/admin/spaces">
        <input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}">
        <label>Public Space identifier<input name="spaceId" required pattern="[a-z0-9][a-z0-9_-]*" maxlength="64"></label>
        <label>Route class<select name="routeClass"><option value="private">Private</option><option value="public">Public</option></select></label>
        ${policyFields()}
        <button type="submit">Create Space</button>
      </form>
      <h2>imgproxy deployment allowlist</h2>
      <div class="card"><p>Copy this Space-derived value into <code>IMGPROXY_ALLOWED_SOURCES</code>. Keep any additional Derivative Store source that your deployment needs.</p><div class="secret">${htmlEscape(model.coverage.derivedValue || "No active Space origins")}</div>
      ${uncovered === "" ? '<p class="notice">The configured deployment allowlist covers every active Space origin.</p>' : `<div class="notice warning"><strong>Deployment update required.</strong><p>These active Space sources are not covered:</p><ul>${uncovered}</ul></div>`}</div>
    </main>`,
  );
}

export function spaceView(model: SpaceDetail): string {
  const { policy } = model.space;
  const tokenRows = model.apiTokens
    .map(
      (token) =>
        `<tr><td>${htmlEscape(token.label)}</td><td><code>${htmlEscape(token.displayPrefix)}…</code></td><td>${date(token.createdAt)}</td><td>${date(token.lastUsedAt)}</td><td>${date(token.revokedAt)}</td><td>${token.revokedAt === undefined && model.space.status === "active" ? `<form class="inline" method="post" action="/admin/spaces/${encodeURIComponent(policy.id)}/api-tokens/${token.id}/revoke"><input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}"><button class="danger" type="submit">Revoke</button></form>` : "—"}</td></tr>`,
    )
    .join("");
  const keyRows = model.capabilityKeys
    .map(
      (key) =>
        `<tr><td><code>${htmlEscape(key.keyId)}</code></td><td>${date(key.acceptedAt)}</td><td>${date(key.disabledAt)}</td><td>${key.disabledAt === undefined && model.space.status === "active" ? `<form class="inline" method="post" action="/admin/spaces/${encodeURIComponent(policy.id)}/capability-keys/${encodeURIComponent(key.keyId)}/disable"><input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}"><button class="danger" type="submit">Disable now</button></form>` : "—"}</td></tr>`,
    )
    .join("");
  return shell(
    policy.id,
    `${header(model.csrfToken)}<main><p><a href="/admin">← All Spaces</a></p><h1>${htmlEscape(policy.id)}</h1>
      ${model.notice === undefined ? "" : `<p class="notice">${htmlEscape(model.notice)}</p>`}
      ${model.secret === undefined ? "" : `<section class="notice warning"><h2>${htmlEscape(model.secret.label)}</h2><p>This secret is shown once. Copy it now.</p><div class="secret">${htmlEscape(model.secret.value)}</div></section>`}
      <section class="grid"><article class="card"><div class="muted">Route class</div><div class="metric">${htmlEscape(policy.routeClass)}</div><p>Identifier and route class cannot change. Create a new Space, migrate the application, and decommission this Space if either must change.</p></article><article class="card"><div class="muted">Status</div><div class="metric">${htmlEscape(model.space.status)}</div><div>Registry generation ${model.generation}</div></article></section>
      <h2>Policy</h2>
      ${model.space.status === "active" ? `<form class="panel" method="post" action="/admin/spaces/${encodeURIComponent(policy.id)}/policy"><input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}">${policyFields(policy)}<button type="submit">Save policy</button></form>` : '<p class="card">This Space is decommissioned. Its retained policy and credential audit records are read-only.</p>'}
      <h2>API tokens</h2>
      <table><thead><tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last use</th><th>Revoked</th><th></th></tr></thead><tbody>${tokenRows || '<tr><td colspan="6">No API tokens.</td></tr>'}</tbody></table>
      ${model.space.status === "active" ? `<form class="panel" method="post" action="/admin/spaces/${encodeURIComponent(policy.id)}/api-tokens"><input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}"><label>Token label<input name="label" required maxlength="128"></label><button type="submit">Issue API token</button></form>` : ""}
      <h2>Capability Keys</h2>
      <p class="notice warning">Add the new key first. Install it as the application's minting key. Wait 24 hours, then disable the old key. Disable a compromised key immediately; existing capabilities that use it will fail.</p>
      <table><thead><tr><th>Key identifier</th><th>Accepted</th><th>Disabled</th><th></th></tr></thead><tbody>${keyRows || '<tr><td colspan="4">No Capability Keys.</td></tr>'}</tbody></table>
      ${model.space.status === "active" ? `<form class="panel" method="post" action="/admin/spaces/${encodeURIComponent(policy.id)}/capability-keys"><input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}"><label>Key identifier<input name="keyId" required maxlength="64" pattern="[A-Za-z0-9_-]+"></label><button type="submit">Generate Capability Key</button></form>` : ""}
      ${model.space.status === "active" ? `<h2>Danger zone</h2><form class="panel danger-zone" method="post" action="/admin/spaces/${encodeURIComponent(policy.id)}/decommission"><input type="hidden" name="csrf" value="${htmlEscape(model.csrfToken)}"><input type="hidden" name="confirm" value="${htmlEscape(policy.id)}"><p>Decommissioning blocks new Space-scoped work. It does not delete or free the identifier.</p><button class="danger" type="submit">Decommission Space</button></form>` : ""}
    </main>`,
  );
}
