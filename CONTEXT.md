# Shutter

Shutter is a rendition service shared by applications that retain ownership of
uploads, source storage, media records, and end-user authorization.

## Language

**Shutter Space**:
An isolated policy and authority boundary for one consuming application. It
defines source trust, rendition and cache policy, and the credentials that the
application uses with Shutter.
_Avoid_: Shared bucket, public tenant

**Source Object**:
An immutable original owned by a consuming application and presented to Shutter
as the input to a Rendition. Changed bytes are a different Source Object.
_Avoid_: Mutable media file, overwritten original

**Source ID**:
An application-issued immutable identifier for a Source Object. It determines
cache, job, storage, idempotency, and purge identity independently of location.
_Avoid_: Source URL, bucket key, Shutter Asset ID

**Source Locator**:
The replaceable description of how Shutter can fetch a Source Object, such as an
allowlisted public provider path or a presigned HTTPS GET URL. Changing storage
providers changes the locator, not the Source ID.
_Avoid_: Source identity, permanent bucket credential

**Source Resolver**:
A trusted Shutter Space mapping from a public provider locator to an allowlisted
HTTPS fetch location, such as UploadThing project and file keys.
_Avoid_: Arbitrary URL proxy, media catalog

**Source Capability**:
A time-limited, encrypted, and authenticated credential issued by a consuming
application that binds one Source ID to exactly one purpose: optimize a private
Source Object, read a stored Master Preview, or run a bounded Rendition Job. A
capability contains a Source Locator only when its purpose must fetch an
application-owned Source Object.
_Avoid_: Shared bucket credential, permanent source URL, Source Grant

**Capability Key**:
A shared symmetric credential that a consuming application uses to issue Source
Capabilities and Shutter uses to accept them. The application owner coordinates
key installation and rotation on both sides.
_Avoid_: Public verification key, Shutter-managed application key

**Rendition**:
A visual representation of a Source Object. A Rendition is produced on demand
or materialized as a stored Derivative.
_Avoid_: Media URL, arbitrary transformation pipeline

**Image Optimization**:
An on-demand Image Rendition that resizes a Source Object to a requested width
while preserving its composition, then WebP-encodes it at the requested quality.
_Avoid_: General-purpose image manipulation, crop-to-fill

**Source Delivery**:
Pass-through delivery of a Source Object through Shutter without converting its
bytes. It uses the Source ID for cache and purge identity and uses the Source
Locator only to fetch the current immutable original.
_Avoid_: Original Rendition, arbitrary reverse proxy, media catalog

**Rendition Policy**:
The trusted Shutter Space configuration that defines canonical image widths,
permitted quality values, output format, and cache behavior.
_Avoid_: Caller-selected transformation pipeline, unsigned cache option

**Derivative**:
A materialized Rendition stored by Shutter separately from its application-owned
Source Object, such as a video poster or PDF cover preview.
_Avoid_: Optimized image, transformed image

**Master Preview**:
The single high-quality Derivative materialized for a video or PDF Source
Object: a one-second video frame with first-decodable-frame fallback, or the
first PDF page, encoded as a quality-90 WebP within 1920 pixels. Responsive
thumbnail sizes are Image Optimizations of this master.
_Avoid_: Size-specific poster set, original media copy

**Rendition Store**:
Shutter-owned storage containing only generated or cached Rendition bytes. It
does not contain Source Objects or authoritative application media records.
_Avoid_: Source bucket, media catalog

**Source Purge**:
Post-revocation cleanup requested by a consuming application after it has made a
Source Object unavailable. It removes every cached Rendition, stored Derivative,
and Rendition Job associated with that immutable source identity; it does not
revoke an otherwise valid Source Capability.
_Avoid_: Media deletion, capability revocation

**Rendition Job**:
The single operational record for one Shutter Space, Source Object, and
materialized rendition kind. It tracks status, bounded retry deadline, attempts,
and output metadata, but is not an authoritative media record.
_Avoid_: Shutter Asset, media catalog entry

**Rendition URL**:
A stateless Shutter URL containing an application-issued Source Capability and
permitted rendition parameters. Possession authorizes access only while the
Source Capability is valid.
_Avoid_: Permanent media URL, Shutter-minted delivery token

**Private Rendition Cache**:
A shared cache of Rendition bytes that sits behind Shutter authorization. A
valid Source Capability is checked before every lookup, including cache hits.
_Avoid_: Public CDN cache, browser-private cache

**Executor**:
A Shutter deployment that claims and completes one class of durable rendition
work, such as video posters or PDF covers.
_Avoid_: Application worker, generic background process

**Executor Work Cycle**:
The shared one-job control sequence used inside each Executor: claim, heartbeat,
media-processing invocation, Master Preview upload, completion or failure, and
cleanup. Video and PDF processing remain separate implementations.
_Avoid_: Generic worker loop, merged Executor
