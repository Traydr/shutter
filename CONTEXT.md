# Shutter

Shutter is a private rendition service shared by applications that retain
ownership of uploads, source storage, media records, and end-user authorization.

## Language

**Shutter Space**:
An isolated application configuration in Shutter with a storage location,
source policy, and cache policy.
_Avoid_: Shared bucket, public tenant

**Source Object**:
An immutable original owned by a consuming application and presented to Shutter
as the input to a Rendition. Changed bytes are a different Source Object.
_Avoid_: Mutable media file, overwritten original

**Source Capability**:
A signed, time-limited credential issued by a consuming application for one
immutable Source Object. It authorizes a Rendition URL or a bounded Rendition
Job without giving Shutter the application's storage credentials.
_Avoid_: Shared bucket credential, permanent source URL, Source Grant

**Rendition**:
A visual representation of a Source Object. A Rendition is produced on demand
or materialized as a stored Derivative.
_Avoid_: Media URL, arbitrary transformation pipeline

**Image Optimization**:
An on-demand Image Rendition that resizes a Source Object within requested width
and height while preserving composition, then WebP-encodes it at the requested
quality.
_Avoid_: General-purpose image manipulation, crop-to-fill

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
An authenticated application request to remove every cached Rendition, stored
Derivative, and Rendition Job associated with one immutable source identity.
_Avoid_: Media deletion, capability revocation

**Rendition Job**:
The operational record used to create one materialized Rendition, including its
status, bounded retry deadline, attempts, and output metadata. It is not an
authoritative media record.
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
