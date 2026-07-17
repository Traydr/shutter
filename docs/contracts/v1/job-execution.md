# V1 Rendition Job execution

## Attempts

- Maximum attempts: 5 total.
- Retry delays after failure: 1 minute, 5 minutes, 30 minutes, 2 hours.
- Hard attempt timeout: 10 minutes, including source download, rendering, and
  R2 write.
- Processing lease: 15 minutes.
- Heartbeat interval: 1 minute.
- Recovery sweep: every 5 minutes.

## Failure classification

Terminal failures:

- Source missing.
- Source Capability or Locator expired.
- Unsupported media type.
- Source exceeds the configured type limit.
- Corrupt media or password-protected PDF.
- Invalid capability, source identity, or origin policy.

Retryable failures:

- Source network timeout or temporary upstream failure.
- Temporary Railway, R2, or Postgres failure.
- Executor process crash or timeout.
- Missed dispatch or expired processing lease.

If retryable failures consume all five automatic attempts, the execution cycle
ends as `attempts_exhausted`. It does not imply invalid source bytes and a new
valid job `PUT` may start another five-attempt cycle on the same logical job.
Deterministic terminal failures cannot be manually restarted in place.

Public polling maps execution outcomes to the stable codes in `job-api.md`.
Provider-specific errors and process output must not become failure codes or API
messages. Unexpected configuration and invariant failures are sanitized as
`configuration_error` or `internal_invariant` and require operator attention.

Every claim, heartbeat, completion, and failure transition compares the current
processing token so a stale attempt cannot overwrite a newer result. When a
stale attempt already uploaded bytes to the deterministic Master Preview key, it
deletes only that attempt's object (R2 `If-Match` on the upload ETag). Ambiguous
complete failures must not delete until Control accepts fail for that token.

## Capability boundary

- Postgres stores the opaque Source Capability, not its decrypted locator.
- Only Shutter Control decrypts and validates job capabilities.
- A claim response supplies the authenticated Executor with the Source Locator,
  deterministic output key, and processing token for that attempt.
- Executors hold Source Locators only in process memory and never receive a
  Space capability key.
- Video and PDF Executors use distinct role credentials, each restricted to its
  own job kind.
