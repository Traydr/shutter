# Keep storage and authorization with consuming applications

Shutter Spaces adopt application-provided S3 storage locations but do not
provision or own them. Consuming applications retain their end-user
authorization, business metadata, retention policy, storage lifecycle, and
direct-upload grants; they register a completed Source Object with Shutter only
after upload. They issue short-lived Source Grants whenever Shutter needs source
bytes, so Shutter never stores Bucket credentials. Shutter receives an
application identity and issues Delivery Capabilities only after the application
authorizes access. This keeps Ernesta's public listings and Latch Works' private
archive isolated without teaching Shutter either application's auth or domain
model.
