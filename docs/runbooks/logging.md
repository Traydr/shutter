# Control logging with OpenObserve

Shutter Control writes every operational event to JSON stdout and, when
configured, sends the same allowlisted event to OpenObserve with OTLP/HTTP JSON.
Railway logs are the fallback if OpenObserve is unavailable. OTLP delivery uses an
in-memory queue capped at 2,048 log records with batches of at most 512, so
records above the bound and the final batch on a forced process kill can be lost.

An Effect logger supplies the stdout envelope: stable JSON serialization,
numeric levels, timestamps, and a testable destination stream. It is not trusted
to redact events. The shared protocol sanitizer drops invalid or unknown fields
first, and one declarative projection table then produces both the stdout and
OTLP records.

## OpenObserve resources

Use the `default` organization and `default` log stream:

1. Send one event to create the `default` stream if it does not exist.
2. Open **Streams → default → Stream Details → Configuration**, set
   **Data Retention in days** to `30`, save it, and read the value back.
3. Use a dedicated OpenObserve credential for Control and retain it only in the
   secret manager. OpenObserve OSS does not provide scoped RBAC, so a dedicated
   account isolates rotation but does not create an ingest-only authorization
   boundary. Enterprise deployments should grant only the permissions needed for
   log ingestion.

OpenObserve expects both of these request headers:

```text
Authorization: Basic <base64(username:password)>
stream-name: default
```

## Control configuration

Control reads its environment through the `ControlConfig` service defined in
`apps/control/src/env/server.ts`; production modules do not read `process.env`
directly. The OTLP values remain optional raw strings at that boundary so the
logger can reject malformed telemetry configuration without preventing Control
from starting.

Railway IaC fixes the non-secret values and preserves the deployment-specific
endpoint, its approved-endpoint allowlist, and the authorization bundle:

```text
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=<preserved Railway variable>
OTEL_EXPORTER_OTLP_LOGS_ALLOWED_ENDPOINTS=<preserved Railway variable>
OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_LOGS_TIMEOUT=5000
OTEL_EXPORTER_OTLP_LOGS_HEADERS=<sealed Railway variable>
```

`OTEL_EXPORTER_OTLP_LOGS_ALLOWED_ENDPOINTS` is a comma-separated allowlist that
the configured endpoint must match exactly after normalization. Keeping it in a
second variable is deliberate: redirecting exports then requires changing two
independently preserved values rather than one. An absent or empty allowlist
approves nothing and Control stays on stdout-only logging.

Set `OTEL_EXPORTER_OTLP_LOGS_HEADERS` in Railway to the standard comma-separated,
percent-encoded representation below. Percent-encode the space following
`Basic` and any Base64 padding characters.

```text
Authorization=Basic%20<percent-encoded-base64>,stream-name=default
```

Never paste the resolved value into the repository, command output, a ticket,
or a log query. `.railway/railway.ts` must retain it as `preserve()`.

When the endpoint is absent, Control continues with stdout-only logging. Invalid
OpenObserve configuration also falls back to stdout and emits one sanitized
`control.telemetry.configuration_failed` event.

The exporter accepts only a normalized exact match against
`OTEL_EXPORTER_OTLP_LOGS_ALLOWED_ENDPOINTS`. It rejects hostname aliases, query
parameters, URL credentials, alternate paths, and any header bundle other than
the OpenObserve Basic authorization and `default` stream.
Exporter timeouts are capped at five seconds even if the environment requests a
larger value. The configured timeout is applied to every OTLP HTTP attempt, while
the separate 5.5-second shutdown timeout preserves the process drain allowance.

The OpenTelemetry Collector configuration uses
`https://otel-collector.example.com/api/default` because the Collector appends
`/v1/logs`. Control uses the signal-specific endpoint above, which is used as-is
and must therefore include `/v1/logs`.

## Event schema

The OTLP body is the stable event name. OpenObserve fields include:

| Column | Meaning |
| --- | --- |
| `service.name` | `shutter-control` |
| `service.namespace` | `shutter` |
| `service.version` | Railway commit SHA or package version |
| `deployment.environment.name` | Railway environment or `NODE_ENV` |
| `event.name` | Stable operational event name |
| `request.id` | Server-generated request correlation UUID |
| `http.request.method` | HTTP method |
| `http.route` | Effect `HttpRouter` route template, never the raw path |
| `http.response.status_code` | Response status |
| `error.type` | Bounded error class name, never a message or stack |
| `shutter.duration_ms` | Event or request duration |
| `shutter.source.hash` | Hashed Space and Source identity |
| `shutter.processing_token.hash` | Hashed processing token |
| `shutter.outcome` | Accepted, ready, failed, idle, or busy |
| `shutter.failure.code` | Allowlisted failure code |

Capabilities, locators, presigned URLs, authorization values, cookies, request
and response bodies, query strings, raw Source IDs, command lines, stderr, error
messages, and stacks are forbidden.

Control keeps Effect server tracing enabled, but exports only low-cardinality
`http.server <METHOD>`, `http.client <METHOD>`, and `sql.execute` span names.
Span attributes are allowlisted to safe HTTP method/status, URL scheme, and SQL
operation name values. Raw URL/path/query/header attributes, client addresses,
`db.query.text`, unrestricted span events and links, and exception messages and
stacks are discarded before the Effect OTLP tracer receives them. Health checks
are not traced.

## Useful OpenObserve queries

Select the `default` log stream, enable SQL mode, and adjust the time range:

```sql
SELECT _timestamp, "event.name", "shutter.failure.code", "request.id"
FROM "default"
WHERE "service.name" = 'shutter-control'
  AND severity_text = 'ERROR'
ORDER BY _timestamp DESC;
```

```sql
SELECT _timestamp, "http.route", "http.response.status_code",
       "shutter.duration_ms", "request.id"
FROM "default"
WHERE "service.name" = 'shutter-control'
  AND "http.response.status_code" >= 500
ORDER BY _timestamp DESC;
```

```sql
SELECT "event.name", count(*) AS failures
FROM "default"
WHERE "event.name" IN (
  'control.job.failed',
  'control.dispatch.failed',
  'control.purge.failed',
  'control.recovery.failed'
)
GROUP BY "event.name"
ORDER BY failures DESC;
```

```sql
SELECT "http.route",
       approx_percentile_cont("shutter.duration_ms", 0.95) AS p95_ms
FROM "default"
WHERE "event.name" = 'control.http.completed'
GROUP BY "http.route"
ORDER BY p95_ms DESC;
```

## Deployment and verification

1. Run `pnpm check` with the Docker-backed Postgres tests available.
2. Run `railway config plan` and confirm that only Control environment values,
   its 15-second drain window, and the new package deployment are changing.
3. Apply the plan only after explicit review and authorization.
4. Wait for the Control deployment to reach `SUCCESS`.
5. Send a safe unauthenticated request to a known Control route. `/healthz` is
   deliberately excluded from request logging.
6. Confirm the response has a server-generated `X-Request-Id`.
7. Find the matching `control.http.completed` record in OpenObserve and structured
   Railway stdout.
8. Confirm service, environment, route template, status, severity, and duration.
9. Search the record for credentials, URLs, raw paths, query strings, Source IDs,
   error messages, and stacks; none may be present.

## Credential rotation

Create a replacement OpenObserve credential, replace the sealed Railway header
value, deploy and verify ingestion, then revoke the old credential. On OpenObserve
OSS, remember that the replacement account is not constrained by scoped RBAC.

## Failure and rollback

An unavailable backend does not block requests. Control keeps writing stdout and
rate-limits `control.telemetry.export_failed` diagnostics to one per minute.

For exporter rollback, remove `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and redeploy;
stdout logging continues. For full rollback, deploy the previous Control revision
and revoke the credential only if the integration is abandoned. Leave the stream
for diagnosis and its normal 30-day expiry.

Introduce an OpenTelemetry Collector when more Shutter services export logs,
disk-backed buffering becomes necessary, or application-held ingest credentials
are no longer acceptable.

## Shutdown budget

Railway gives Control 15 seconds to drain. Control reserves at most three seconds
for HTTP close before starting log shutdown, then reserves 5.5 seconds for the
OTLP flush. A phase exceeding its budget does not by itself mark the deployment
failed; only a real close or flush rejection sets a failing exit code. The
remaining Railway margin covers signal delivery and process teardown.
