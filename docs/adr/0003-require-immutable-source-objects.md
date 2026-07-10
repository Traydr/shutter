# Require immutable Source Objects

A changed upload creates a new object or object version; Source Objects are
never overwritten in place. This makes cache keys, retries, and delivery
capabilities deterministic while allowing an application to replace its own
business relationship with the new Source Object.
