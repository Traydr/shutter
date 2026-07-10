# Shutter

Shutter is private media infrastructure shared by applications that retain
ownership of their storage and end-user authorization.

## Language

**Shutter Space**:
An isolated application configuration in Shutter with a storage location,
credentials, and delivery policy.
_Avoid_: Shared bucket, public tenant

**Shutter Asset**:
The authoritative Shutter record for a Source Object and its Renditions. An
application may mirror the original storage reference, but that mirror does not
control rendition lifecycle.
_Avoid_: Media file, application-owned rendition record

**Source Object**:
An immutable original stored by a consuming application. Replacing it creates a
new object or object version and a new Shutter Asset.
_Avoid_: Mutable media file, overwritten original

**Source Registration**:
The consuming application's declaration to Shutter that a direct upload has
completed and is ready to become a Shutter Asset.
_Avoid_: Upload callback, storage polling

**Source Grant**:
A short-lived read capability issued by a consuming application for a Source
Object after Shutter requests access. Shutter uses it to create a Rendition but
never stores the application's storage credentials.
_Avoid_: Shared bucket credential, permanent source URL

**Rendition**:
A visual representation of a Shutter Asset. A Rendition is produced on demand
from a Source Object or materialized as a stored Derivative.
_Avoid_: Media URL, arbitrary transformation pipeline

**Image Optimization**:
An on-demand Image Rendition that resizes a Source Object within requested width
and height while preserving composition, then WebP-encodes it at the requested
quality.
_Avoid_: General-purpose image manipulation, crop-to-fill

**Derivative**:
A materialized Rendition stored separately from its Source Object, such as a
video poster or PDF cover preview.
_Avoid_: Optimized image, transformed image

**Delivery Capability**:
A limited credential issued by Shutter after a consuming application authorizes
access to a Rendition or Source Object.
_Avoid_: Application session, permanent S3 URL

**Executor**:
A Shutter deployment that claims and completes one class of durable rendition
work, such as video posters or PDF covers.
_Avoid_: Application worker, generic background process
