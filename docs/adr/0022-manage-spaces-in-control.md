# Manage Spaces in Control

Control owns the Postgres Space Registry and serves a small, server-rendered
operator interface at `/admin`. A separate frontend or admin deployment would
add another privileged interface without adding useful isolation.

The first version uses one operator-managed `ADMIN_BOOTSTRAP_TOKEN`. A valid
login creates a short-lived Secure, HttpOnly, SameSite=Strict cookie. Every
state-changing request also requires a signed-session CSRF value and a matching
request Origin. The login form is the only unauthenticated admin route.

The interface creates, edits, and decommissions Spaces through the same
`SpaceRegistry` contract as runtime callers. It generates API tokens and
Capability Keys on the server, displays each full secret once, and later shows
only audit summaries. Space identifiers and route classes have no edit control.

Edge reports successful snapshot generations to an authenticated internal
Control endpoint. The admin dashboard compares that report with the current
registry generation. It also derives the Space portion of
`IMGPROXY_ALLOWED_SOURCES` and warns when the deployment value does not cover an
active Space origin. imgproxy remains deployment configuration because it reads
the allowlist only at process start.
