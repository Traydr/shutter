# Bound Rendition Jobs by Source Capability lifetime

Video and PDF jobs receive an application-issued, job-scoped Source Capability
valid for the job's entire bounded retry window. Shutter neither calls the
application to renew access nor stages a copy of the Source Object; a job that
cannot finish before access expires terminates as `source_expired` and may be
resubmitted idempotently with a fresh capability. This keeps v1 integration and
private-source handling small at the cost of requiring explicit resubmission
after unusually long failures.
