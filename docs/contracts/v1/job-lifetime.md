# V1 Rendition Job lifetime

- Source Capability lifetime: 24 hours from submission.
- Minimum Source Locator validity: 24 hours and 5 minutes from submission.
- Retry deadline: 23 hours from initial job creation.
- Access expiry terminal result: `source_expired`.
- Job identity: `(space_id, source_id, kind)` where kind is `video` or `pdf`.
- Resubmission: `PUT` to the same canonical job resource with a fresh capability
  reactivates `source_expired` without creating a second Master Preview identity.
- Retry exhaustion result: `attempts_exhausted`.
- Manual retry: a new valid `PUT` reactivates `attempts_exhausted` and starts a
  new bounded execution cycle on the same job identity.

Shutter does not renew Source Capabilities, call application callbacks for fresh
locators, or retain a staged Source Object copy.
