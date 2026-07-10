# Shutter foundation

## Goal

Create private, product-neutral media infrastructure that lets Ernesta and
Latch Works retain application-owned storage and authorization while sharing
media lifecycle behavior.

## Decisions already settled

- Shutter is private infrastructure, not a public media product.
- A Shutter Space isolates each consuming application.
- Applications provision their own bucket or prefix and retention policy.
- Applications authorize and issue their own direct-upload grants, then perform
  Source Registration after upload succeeds.
- Shutter owns the media catalog, Renditions, and durable jobs.
- Applications may mirror original storage references, but Shutter Asset records
  own rendition lifecycle.
- Source Objects are immutable; replacement creates a new Shutter Asset.
- Applications retain end-user authorization; Shutter receives only application
  identity and issues Delivery Capabilities.
- Image Optimization is on-demand: requested width, optional height, and quality
  produce WebP while preserving composition.
- Video and PDF Renditions are materialized Derivatives.
- Control, imgproxy, video, and PDF deploy separately and may sleep when idle.
- Each Executor invocation completes at most one job before returning.

## Phases

### 1. Establish the control module

- Choose the language, package layout, migration tool, and service-to-service
  authentication mechanism.
- Model Spaces, storage locations, Assets, Source Objects, Renditions, durable
  jobs, attempt history, and Delivery Capabilities.
- Implement application-authenticated Space setup, Source Registration, asset
  replacement, and job status reads.
- Add lease, retry, and idempotency tests before attaching executors.

### 2. Adopt storage safely

- Define a storage adapter for S3-compatible locations using one credential set
  per Space. Treat Railway Bucket credentials as bucket-level authority because
  Railway does not document prefix-scoped or read-only credentials.
- Define immutable source-key/version conventions and Shutter-managed derivative
  prefixes.
- Define post-upload Source Registration and verification without proxying
  object bytes or issuing direct-upload grants through Shutter.
- Define sealed, per-Space storage credentials for application-owned Railway
  Buckets that live in other Railway projects; do not rely on cross-project
  variable references or private networking.
- Run a two-project Railway spike: test whether an imgproxy credential source
  can read more than one adopted Railway Bucket. Use the result to choose either
  one shared image renderer or a renderer per Space; do not assume a shared
  multi-Bucket credential exists.
- Define deletion requests and delayed garbage collection without allowing an
  application to delete storage outside its Space.

### 3. Deliver optimized images

- Deploy imgproxy separately behind an edge cache.
- Implement signed Source Object access and Delivery Capability handling for
  public and private Spaces.
- Generate signed image URLs that expose only width, optional height, and
  quality, with WebP as the output format and no crop mode.
- Characterize output parity against Ernesta's existing Bunny URLs using a
  representative image set.

### 4. Materialize video and PDF Renditions

- Implement isolated Shutter Video and Shutter PDF Executors.
- Claim exactly one matching job per invocation, generate a Derivative, upload
  it, and persist a terminal success or retryable failure before responding.
- Add a bounded dispatch wake and periodic recovery sweep.
- Characterize poster/cover parity against Latch Works' current ffmpeg and PDF
  generation paths.

### 5. Integrate consumers gradually

- Migrate Ernesta upload registration from UploadThing to direct S3 upload and
  Shutter Asset registration. Preserve the existing responsive-image caller
  contract while replacing Bunny URLs with Shutter image URLs.
- Integrate Latch Works alongside its current Media Optimizer. Migrate one media
  type at a time and retain a rollback path until output and delivery behavior
  are characterized.
- Only retire an existing provider after parity, authorization, retry, and
  recovery checks succeed in production.

## Verification criteria

- A Space cannot read or write another Space's storage location.
- Repeated registration of the same immutable Source Object is idempotent.
- Replacing a source creates a new Asset and does not invalidate old cache keys.
- An application cannot mint a private Delivery Capability without first
  authorizing its user.
- Image URLs accept only width, optional height, and quality, and always produce
  an uncropped WebP Rendition.
- An interrupted Executor job is retried safely and never causes an application
  to lose its Source Object.
- An idle Executor can wake from a Shutter dispatch and persist a terminal job
  outcome before returning.
