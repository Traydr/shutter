# Store Space configuration in Postgres

Space policy, API-token hashes, encrypted Capability Keys, status, and
credential history are operational data. Store them in the Postgres Space
Registry. Do not keep tenant values in source code or deployment variables.
Control reads the registry for each Space-scoped request, so all replicas see a
committed change without a Control cache-invalidation protocol.

Edge reads one authenticated `v1` snapshot that contains all active policies
and Capability Keys from one repeatable-read transaction. Each Worker isolate
keeps only parsed plain data in memory. It uses a snapshot for 45 seconds, starts
a background refresh from 45 through 60 seconds, and waits for a refresh at 60
seconds. A successful change therefore reaches an active isolate in 60 seconds
or less.

If Control is unavailable, Edge can use the last valid snapshot for at most 10
minutes after Control generated it. The longer failure tolerance is separate
from the refresh interval: it preserves cached delivery during a short Control
outage, while the fixed bound prevents indefinite use of a removed origin,
policy, or key. With no snapshot inside that bound, Edge fails closed with
`503`. A valid snapshot that omits a Space produces `404`.

The snapshot endpoint uses a dedicated read-only credential, HTTPS, manual
redirect handling, no HTTP caching, a short timeout, a 1 MiB response limit,
and strict schema and key validation. Executors receive only the allowed
source-origin rules attached to a claim. They never receive Capability Keys or
the full registry.
