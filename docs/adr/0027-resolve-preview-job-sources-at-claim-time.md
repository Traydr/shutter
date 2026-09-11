# Resolve Preview Job sources at claim time

A v2 Preview Job names a resolver source by its Source ID and carries no Source
Capability; the Space API token is the only credential. Control derives the
resolver from the Source ID prefix when an Executor claims the job, expands a
template or presigns an S3 GET for that attempt, and hands the Executor the
attempt-scoped locator on the same claim wire as before. A later attempt gets a
fresh locator; a resolver removed while a job is open fails the job with
`configuration_error`.

ADR 0011 bounded a job by the lifetime of its capability because Shutter could
not renew access on its own. A resolver source removes that constraint, so the
23-hour window is restated as a plain retry budget rather than an authorization
bound. The budget, the attempt limits, and the `source_expired` outcome for v1
capability jobs are unchanged; a refreshed locator never extends the budget or
resets the attempt counter.
