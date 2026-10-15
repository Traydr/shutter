# Drain Executors from Control

Control keeps one drain per Executor kind: it wakes the kind with
`POST /internal/v1/run-once` and wakes it again while the reply is
`{"result":"processed"}`, stopping on `idle`, on a failed wake, or after 500
wakes. A submission, a retry timer, or the sweep that arrives while a drain is
running joins it and makes it wake once more before it may stop, so N
submissions cost one drain rather than N queued wakes. One wake is retried
with backoff (1, 2, 4, 8, 16 seconds) on a refused or reset connection, `502`,
or `503`, never on `401` or another client error. A retryable failure gets a
timer at its `next_attempt_at`, read back from Postgres; the five-minute sweep
stays as the net under all of it and no longer waits on the drains it starts.

Each invocation still claims at most one job (ADR 0004); looping lives in
Control, which already knows when work arrives. Railway answers the first
request to a sleeping service with a refused connection or a `502`, and a wake
that is never retried leaves the job for the next sweep. In production that
became hours of failed wakes, each of which booted the Executor only for it to
idle until just before the following sweep. So an Executor also runs one
invocation as it boots, and a wake that arrives during an invocation waits for
it rather than being turned away as busy: if that invocation processed a job
the wake answers `processed` and Control wakes again, otherwise the wake runs
its own invocation, because its job may have been submitted after that claim.
A wake therefore lasts at most about one attempt, which the eleven-minute wake
timeout covers. Wakes go over `node:http` because Node's `fetch` stops waiting
for response headers after 300 seconds.
