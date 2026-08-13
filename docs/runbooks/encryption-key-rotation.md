# Rotate the Space Registry encryption key

`SHUTTER_ENCRYPTION_KEY` seals Capability Keys in Postgres. Shutter does not
include automatic key-rotation tooling. Use a maintenance window and keep a
tested database backup.

1. Stop Space-scoped traffic and all Control replicas.
2. Back up Postgres and verify that the backup can be restored.
3. In a private maintenance tool, load each `space_capability_keys` row. Open it
   with the old master key and seal the same 32-byte Capability Key with the new
   master key. Preserve the Space identifier and key identifier as associated
   data. Do not write plaintext keys to disk or logs.
4. Perform all row updates in one database transaction. Read every active key
   back with the new master key before that transaction commits.
5. Set the new `SHUTTER_ENCRYPTION_KEY` in Railway and start one Control replica.
6. Load `/admin`, fetch one Edge snapshot, and verify one private capability for
   each active key generation.
7. Start the remaining traffic and retain the protected database backup through
   the observation window.

If any verification fails, roll back the database transaction or restore the
backup and restart Control with the old master key. Do not change the Railway
secret before the database re-encryption is ready to commit.
