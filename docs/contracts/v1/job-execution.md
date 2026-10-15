# V1 Preview Job execution

## Attempts

- Maximum attempts: 5 total.
- Retry delays after failure: 1 minute, 5 minutes, 30 minutes, 2 hours.
- Hard attempt timeout: 10 minutes, including source download, rendering, and
  R2 write. The Executor aborts the attempt at the deadline and reports a
  retryable failure.
- Processing lease: 15 minutes.
- Heartbeat interval: 1 minute. A heartbeat answered `409 stale_attempt` aborts
  the attempt without a further report; any other heartbeat failure is logged
  (`executor.heartbeat_failed`) and the attempt continues.
- Claim release: a claim Control cannot finish serving for a temporary reason
  (registry or resolver unavailable) returns the job to pending without spending
  its attempt, claimable again after 1 minute.
- Recovery sweep: every 5 minutes.

## Dispatch

- Each invocation claims and settles at most one job and answers its wake with
  `processed` or `idle`.
- Control drains a kind by waking it while the answer is `processed`, with at
  most one drain per kind and at most 500 wakes per drain. A request during a
  drain joins it and costs one more wake, not a queued one.
- A wake is retried after 1, 2, 4, 8, and 16 seconds on a refused or reset
  connection, `502`, `503`, or a `202` from an Executor that predates draining.
  `401`, any other `4xx`, `500`, a malformed reply, and a wake that outlives its
  11-minute timeout are not retried.
- An Executor runs one invocation when it boots. A wake during an invocation
  waits for it and answers `processed` if it processed a job; otherwise the wake
  runs its own invocation.
- A retryable failure is woken at its `next_attempt_at`; the recovery sweep
  catches anything a wake or timer missed.

## Failure classification

Terminal failures:

- Source missing.
- Source Capability or Locator expired.
- Unsupported media type.
- Source exceeds the configured type limit.
- Corrupt media, or a PDF that needs a user password to open. A PDF with only
  an owner password renders normally. A video is judged corrupt only from a
  complete local copy, never from the ranges read through the proxy.
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
  allowed source-origin rules, deterministic output key, and processing token
  for that attempt.
- A job accepted while its Space is active can still be claimed after the Space
  is decommissioned. Control uses the retained policy and currently accepted
  Capability Keys only for that unfinished work; new submissions remain blocked.
- Executors hold Source Locators and the small origin-policy fragment only in
  process memory. They never receive a Space capability key or the full Space
  registry.
- Video and PDF Executors use distinct role credentials, each restricted to its
  own job kind.
