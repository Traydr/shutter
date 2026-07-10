# Let applications issue upload grants

Each consuming application authorizes its own user and issues the presigned
direct-upload grant for its own storage location. After a successful upload, it
performs Source Registration with Shutter. This keeps user authorization and
application-specific upload rules local while Shutter begins work only with an
already completed immutable Source Object.

