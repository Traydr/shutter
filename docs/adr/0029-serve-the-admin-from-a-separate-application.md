# Serve the admin from a separate application

The operator interface moves out of Control into its own application,
`apps/admin`, built on TanStack Start like the other operator-facing apps on
this deployment. It talks to Control only through JSON routes under
`/v1/admin`, guarded by one machine credential, `ADMIN_API_TOKEN`, that the
admin application's server holds and the browser never sees. Operators sign in
to the admin application; Control has no operator session.

ADR 0022 kept the interface inside Control because a separate deployment would
add another privileged interface without adding isolation. That is still true,
and it is not the reason for this change. The reason is that the server-rendered
pages cannot be developed: every page is one template string with its CSS
inside, a change is visible only after a Control deploy, and a form error
discards what the operator typed. The September 2026 redesign was a good layout
and still shipped with overflow bugs found in production, because nothing
short of a deploy could show them. The interface needs a component model, a
dev loop, and a way to run against real registry data from a laptop, and a
separate application is the cheapest way to get all three.

The JSON routes are the load-bearing part. They mirror the registry contract
one to one, so the admin application, the HTML pages while they still exist,
and any operator script call the same operations with the same validation.
`packages/admin-api` holds the wire schemas and a typed client; both services
parse with it. Because the two services deploy from the same commit but not at
the same moment, the contract is versioned and fixture-tested, and a new
response field is optional for one deploy.

What stays in Control: the registry and its lock, the sealed credentials and
`SHUTTER_ENCRYPTION_KEY`, the resolver test with its private-address guard,
the deployment-coverage derivation, and the Edge refresh tracker. The admin
application never opens Postgres. Reading the registry from a second process
would need the encryption key on a second service and a second writer under
the registry lock, and the refresh tracker and resolver test only exist inside
Control anyway.

The transition is three steps. First the routes land and the HTML admin keeps
working beside them. Then the admin application ships and runs alongside on
real Spaces. Then the HTML admin, its session code, and
`ADMIN_BOOTSTRAP_TOKEN` leave Control. The admin application starts with a
single operator credential; operator accounts remain the deferred item they
were.
