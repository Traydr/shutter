# Use application-issued Source Grants

When Shutter needs a Source Object, it requests a short-lived presigned read URL
from the owning application instead of storing that application's Bucket
credentials. This makes cross-project Railway storage practical without shared
secrets; durable workers refresh a Grant for every attempt, and imgproxy embeds
an encrypted Grant in its signed source URL.

