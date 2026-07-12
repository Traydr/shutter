const scenarios = [
  "five-route-cache-transitions",
  "private-capability-fail-closed",
  "video-and-pdf-job-lifecycle",
  "missed-dispatch-and-retry-recovery",
  "repeated-source-purge",
  "gallery-rate-limit",
];

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing required ${name}`);
  return value;
}

async function requestScenario(entry) {
  const response = await fetch(entry.url, {
    method: entry.method ?? "GET",
    headers: entry.headers ?? {},
    body: entry.body === undefined ? undefined : JSON.stringify(entry.body),
    redirect: "manual",
  });
  if (response.status !== entry.status) throw new Error(`scenario ${entry.name} status mismatch`);
  if (entry.cache !== undefined && response.headers.get("x-shutter-cache") !== entry.cache)
    throw new Error(`scenario ${entry.name} cache mismatch`);
  if (entry.noBytes === true && (await response.arrayBuffer()).byteLength !== 0)
    throw new Error(`scenario ${entry.name} returned bytes`);
}

async function live(mode) {
  if (process.env.SHUTTER_VERIFY_LIVE !== "1")
    throw new Error("live verification requires SHUTTER_VERIFY_LIVE=1");
  if (mode === "purge") {
    const base = required("SHUTTER_CONTROL_BASE_URL");
    const space = required("SHUTTER_SPACE_ID");
    const source = required("SHUTTER_DISPOSABLE_SOURCE_ID");
    const token = required("SHUTTER_SPACE_API_TOKEN");
    if (process.env.SHUTTER_CONFIRM_DISPOSABLE_PURGE !== "yes")
      throw new Error("purge requires SHUTTER_CONFIRM_DISPOSABLE_PURGE=yes");
    const url = new URL(
      `/v1/spaces/${encodeURIComponent(space)}/sources/${encodeURIComponent(source)}/purge`,
      base,
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status !== 204) throw new Error("repeated purge verification failed");
    }
    return;
  }
  if (mode === "gallery") {
    const url = required("SHUTTER_VERIFY_GALLERY_URL");
    const responses = await Promise.all(
      Array.from({ length: 301 }, () => fetch(url, { redirect: "manual" })),
    );
    if (!responses.some((response) => response.status === 429))
      throw new Error("gallery verification did not observe rate limiting");
    return;
  }
  const entries = JSON.parse(required("SHUTTER_VERIFY_SCENARIOS"));
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("SHUTTER_VERIFY_SCENARIOS must be a non-empty JSON array");
  for (const entry of entries) await requestScenario(entry);
}

const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex < 0 ? "offline" : process.argv[modeIndex + 1];
if (mode === "offline") {
  if (new Set(scenarios).size !== 6) throw new Error("offline scenario manifest is incomplete");
  console.log(`offline verification manifest: ${scenarios.length} scenarios`);
} else if (["routes", "jobs", "recovery", "purge", "gallery"].includes(mode)) {
  await live(mode);
  console.log(`live ${mode} verification passed`);
} else {
  throw new Error("unknown verification mode");
}
