ALTER TABLE "space_resolvers" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "space_resolvers" ADD COLUMN "credential_access_key_id" text;--> statement-breakpoint
ALTER TABLE "space_resolvers" ADD COLUMN "sealed_credential_nonce" text;--> statement-breakpoint
ALTER TABLE "space_resolvers" ADD COLUMN "sealed_credential" text;--> statement-breakpoint
ALTER TABLE "space_resolvers" ADD COLUMN "credential_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "space_resolvers" DROP CONSTRAINT "space_resolvers_type_check";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "space_resolvers" r CROSS JOIN LATERAL unnest(r."allowed_project_ids") AS p
    WHERE r."resolver_type" = 'uploadthing' AND length(p) > 63
  ) THEN
    RAISE EXCEPTION 'migration 0003: an UploadThing project id is longer than 63 characters and cannot become a hostname label; remove it from the resolver before migrating';
  END IF;
  -- A rule narrower than /f for a project host would have to be widened to let the
  -- template pass the origin check, which would also widen what a v1 capability may
  -- name (ADR 0025 keeps the migration inside the existing allowlist). Refuse instead.
  IF EXISTS (
    SELECT 1 FROM "space_resolvers" r CROSS JOIN LATERAL unnest(r."allowed_project_ids") AS p
    WHERE r."resolver_type" = 'uploadthing'
      AND EXISTS (
        SELECT 1 FROM "space_source_origins" o
        WHERE o."space_id" = r."space_id"
          AND o."origin" = 'https://' || lower(p) || '.ufs.sh'
          AND o."path_prefix" NOT IN ('/', '/f'))
      AND NOT EXISTS (
        SELECT 1 FROM "space_source_origins" o
        WHERE o."space_id" = r."space_id"
          AND o."origin" = 'https://' || lower(p) || '.ufs.sh'
          AND o."path_prefix" IN ('/', '/f'))
  ) THEN
    RAISE EXCEPTION 'migration 0003: a source origin rule for an UploadThing project host has a path prefix narrower than /f; widen it to /f or remove the resolver before migrating';
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "space_source_origins" ("space_id", "origin", "path_prefix")
SELECT DISTINCT r."space_id", 'https://' || lower(p) || '.ufs.sh', '/f'
FROM "space_resolvers" r CROSS JOIN LATERAL unnest(r."allowed_project_ids") AS p
WHERE r."resolver_type" = 'uploadthing'
  AND NOT EXISTS (
    SELECT 1 FROM "space_source_origins" o
    WHERE o."space_id" = r."space_id"
      AND o."origin" = 'https://' || lower(p) || '.ufs.sh'
      AND o."path_prefix" IN ('/', '/f'));--> statement-breakpoint
UPDATE "space_resolvers"
SET "resolver_type" = 'template',
    "config" = jsonb_build_object(
      'url', 'https://{project}.ufs.sh/f/{file}',
      'placeholders', jsonb_build_object(
        'project', jsonb_build_object('allowed', to_jsonb("allowed_project_ids")),
        'file', '{}'::jsonb))
WHERE "resolver_type" = 'uploadthing';--> statement-breakpoint
ALTER TABLE "space_resolvers" ALTER COLUMN "config" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "space_resolvers" DROP CONSTRAINT "space_resolvers_projects_check";--> statement-breakpoint
ALTER TABLE "space_resolvers" DROP COLUMN "allowed_project_ids";--> statement-breakpoint
ALTER TABLE "space_resolvers" ADD CONSTRAINT "space_resolvers_type_check" CHECK ("space_resolvers"."resolver_type" in ('template', 's3'));--> statement-breakpoint
ALTER TABLE "space_resolvers" ADD CONSTRAINT "space_resolvers_credential_check" CHECK (("space_resolvers"."resolver_type" = 's3') = (
        "space_resolvers"."credential_access_key_id" is not null
        and "space_resolvers"."sealed_credential_nonce" is not null
        and "space_resolvers"."sealed_credential" is not null
        and "space_resolvers"."credential_updated_at" is not null));--> statement-breakpoint
UPDATE "space_registry_metadata" SET "generation" = "generation" + 1, "updated_at" = now()
WHERE "id" = 1 AND EXISTS (SELECT 1 FROM "space_resolvers");
