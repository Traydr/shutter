# Shutter

Shutter is private media infrastructure for applications that own their own media
storage but need reliable upload grants, visual renditions, durable processing,
and delivery capabilities.

It is product-neutral infrastructure for private applications such as Ernesta
and Latch Works. It is not a public media SaaS and does not own application
users, business records, or application storage provisioning.

## Shape

```text
Application → Shutter Control → Shutter catalog + durable jobs
      │                                  │
      └── direct upload → application-owned S3 storage

Browser → cache → imgproxy → application-owned S3 storage
                         
Shutter Video ────────────────────────→ stored Derivatives
Shutter PDF ──────────────────────────→ stored Derivatives
```

See [the architecture record](./docs/architecture.md), [decisions](./docs/adr/),
and [foundation roadmap](./docs/plans/0001-shutter-foundation.md).

