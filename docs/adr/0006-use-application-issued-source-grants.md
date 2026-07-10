# Use stateless application-issued Source Capabilities

For on-demand private image delivery, the consuming application issues an
encrypted, authenticated, time-limited Source Capability for one immutable
Source Object. The capability travels in the Rendition URL, so Shutter validates
the request without a media catalog lookup or URL-minting API call and fetches
only the authorized source. Rendition parameters remain constrained by the
application's Shutter Space policy.
