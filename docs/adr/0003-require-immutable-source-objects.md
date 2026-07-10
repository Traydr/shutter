# Require immutable Source Objects

A changed upload creates a new object or object version and a new Shutter Asset;
Source Objects are never overwritten in place. This makes cache keys, retries,
delivery capabilities, and audit history deterministic while allowing an
application to replace the business relationship with a new Asset.

