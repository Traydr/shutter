# Control logging with Parseable

Shutter Control writes every operational event to JSON stdout and, when
configured, sends the same allowlisted event to Parseable with OTLP/HTTP JSON.
Railway logs are the fallback if Parseable is unavailable. OTLP delivery uses an
in-memory batch queue, so a forced process kill can lose the final batch.

## Parseable resources

Provision these resources in the existing Parseable deployment before enabling
the Control exporter:

1. Create a dynamic-schema dataset named `shutter`.
2. Set and read back this retention policy:

   ```json
   [
     {
       "duration": "30d",
       "action": "delete",
       "description": "Delete Shutter logs after 30 days"
     }
   ]
   ```

3. Create a native user named `shutter-ingestor` and a role with only the
   `ingester` privilege on the `shutter` dataset. Do not grant query, dataset
   management, or administrator privileges.
4. Retain the generated password in the secret manager. Verify that this user
   can ingest into `shutter` but cannot query or change the dataset.

Parseable v2.8.0 expects all three of these request headers:

```text
Authorization: Basic <base64(username:password)>
X-P-Stream: shutter
X-P-Log-Source: otel-logs
```

## Control configuration

Railway IaC fixes the non-secret values and preserves the authorization bundle:

```text
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://parseable.traydr.dev/v1/logs
OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_LOGS_TIMEOUT=5000
OTEL_EXPORTER_OTLP_LOGS_HEADERS=<sealed Railway variable>
```

Set `OTEL_EXPORTER_OTLP_LOGS_HEADERS` in Railway to the standard comma-separated,
percent-encoded representation below. Percent-encode the space following
`Basic` and any Base64 padding characters.

```text
Authorization=Basic%20<percent-encoded-base64>,X-P-Stream=shutter,X-P-Log-Source=otel-logs
```

Never paste the resolved value into the repository, command output, a ticket,
or a log query. `.railway/railway.ts` must retain it as `preserve()`.

When the endpoint is absent, Control continues with stdout-only logging. Invalid
Parseable configuration also falls back to stdout and emits one sanitized
`control.telemetry.configuration_failed` event.

## Event schema

The OTLP body is the stable event name. Parseable columns include:

| Column | Meaning |
| --- | --- |
| `service.name` | `shutter-control` |
| `service.namespace` | `shutter` |
| `service.version` | Railway commit SHA or package version |
| `deployment.environment.name` | Railway environment or `NODE_ENV` |
| `event.name` | Stable operational event name |
| `request.id` | Server-generated request correlation UUID |
| `http.request.method` | HTTP method |
| `http.route` | Hono route template, never the raw path |
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

## Useful Parseable queries

Run these in the Parseable query editor and adjust the time range there:

```sql
SELECT p_timestamp, "event.name", "shutter.failure.code", "request.id"
FROM "shutter"
WHERE "service.name" = 'shutter-control'
  AND p_log_category = 'ERROR'
ORDER BY p_timestamp DESC;
```

```sql
SELECT p_timestamp, "http.route", "http.response.status_code",
       "shutter.duration_ms", "request.id"
FROM "shutter"
WHERE "service.name" = 'shutter-control'
  AND "http.response.status_code" >= 500
ORDER BY p_timestamp DESC;
```

```sql
SELECT "event.name", count(*) AS failures
FROM "shutter"
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
FROM "shutter"
WHERE "event.name" = 'control.http.completed'
GROUP BY "http.route"
ORDER BY p95_ms DESC;
```

## Deployment and verification

1. Run `pnpm check` with the Docker-backed Postgres tests available.
2. Run `railway config plan` and confirm that only Control environment values,
   its ten-second drain window, and the new package deployment are changing.
3. Apply the plan only after explicit review and authorization.
4. Wait for the Control deployment to reach `SUCCESS`.
5. Send a safe unauthenticated request to a known Control route. `/healthz` is
   deliberately excluded from request logging.
6. Confirm the response has a server-generated `X-Request-Id`.
7. Find the matching `control.http.completed` record in Parseable and structured
   Railway stdout.
8. Confirm service, environment, route template, status, severity, and duration.
9. Search the record for credentials, URLs, raw paths, query strings, Source IDs,
   error messages, and stacks; none may be present.

## Credential rotation

Create a second dataset-scoped ingester, replace the sealed Railway header value,
deploy and verify ingestion, then revoke the old user. Do not reuse the Parseable
administrator account as an overlap credential.

## Failure and rollback

An unavailable backend does not block requests. Control keeps writing stdout and
rate-limits `control.telemetry.export_failed` diagnostics to one per minute.

For exporter rollback, remove `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and redeploy;
stdout logging continues. For full rollback, deploy the previous Control revision
and revoke the ingester only if the integration is abandoned. Leave the dataset
for diagnosis and its normal 30-day expiry.

Introduce an OpenTelemetry Collector when more Shutter services export logs,
disk-backed buffering becomes necessary, or application-held ingest credentials
are no longer acceptable.
