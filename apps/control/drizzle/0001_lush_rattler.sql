CREATE TABLE "space_api_tokens" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "space_api_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"space_id" integer NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"display_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "space_capability_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "space_capability_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"space_id" integer NOT NULL,
	"key_id" text NOT NULL,
	"sealed_nonce" text NOT NULL,
	"sealed_key" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "space_registry_metadata" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "space_registry_metadata_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_registry_metadata_singleton_check" CHECK ("space_registry_metadata"."id" = 1),
	CONSTRAINT "space_registry_metadata_generation_check" CHECK ("space_registry_metadata"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "space_resolvers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "space_resolvers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"space_id" integer NOT NULL,
	"resolver_id" text NOT NULL,
	"resolver_type" text NOT NULL,
	"allowed_project_ids" text[] NOT NULL,
	CONSTRAINT "space_resolvers_type_check" CHECK ("space_resolvers"."resolver_type" = 'uploadthing'),
	CONSTRAINT "space_resolvers_projects_check" CHECK (cardinality("space_resolvers"."allowed_project_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "space_source_origins" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "space_source_origins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"space_id" integer NOT NULL,
	"origin" text NOT NULL,
	"path_prefix" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "spaces_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"space_id" text NOT NULL,
	"route_class" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"qualities" integer[] NOT NULL,
	"default_quality" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decommissioned_at" timestamp with time zone,
	CONSTRAINT "spaces_route_class_check" CHECK ("spaces"."route_class" in ('public', 'private')),
	CONSTRAINT "spaces_status_check" CHECK ("spaces"."status" in ('active', 'decommissioned')),
	CONSTRAINT "spaces_decommissioned_at_check" CHECK (("spaces"."status" = 'active' and "spaces"."decommissioned_at" is null)
        or ("spaces"."status" = 'decommissioned' and "spaces"."decommissioned_at" is not null)),
	CONSTRAINT "spaces_quality_policy_check" CHECK (cardinality("spaces"."qualities") > 0 and "spaces"."default_quality" = any("spaces"."qualities"))
);
--> statement-breakpoint
ALTER TABLE "space_api_tokens" ADD CONSTRAINT "space_api_tokens_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_capability_keys" ADD CONSTRAINT "space_capability_keys_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_resolvers" ADD CONSTRAINT "space_resolvers_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_source_origins" ADD CONSTRAINT "space_source_origins_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "space_api_tokens_hash_unique" ON "space_api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "space_capability_keys_space_key_unique" ON "space_capability_keys" USING btree ("space_id","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "space_resolvers_space_resolver_unique" ON "space_resolvers" USING btree ("space_id","resolver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "space_source_origins_rule_unique" ON "space_source_origins" USING btree ("space_id","origin","path_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_space_id_unique" ON "spaces" USING btree ("space_id");--> statement-breakpoint
INSERT INTO "space_registry_metadata" ("generation") VALUES (0);--> statement-breakpoint
CREATE FUNCTION prevent_space_identity_change() RETURNS trigger AS $$
BEGIN
	IF NEW.space_id IS DISTINCT FROM OLD.space_id THEN
		RAISE EXCEPTION 'a Space public identifier is immutable';
	END IF;
	IF NEW.route_class IS DISTINCT FROM OLD.route_class THEN
		RAISE EXCEPTION 'a Space route class is immutable';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER spaces_identity_immutable
	BEFORE UPDATE ON "spaces"
	FOR EACH ROW EXECUTE FUNCTION prevent_space_identity_change();--> statement-breakpoint
CREATE FUNCTION prevent_space_delete() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'a Space must be decommissioned, not deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER spaces_delete_rejected
	BEFORE DELETE ON "spaces"
	FOR EACH ROW EXECUTE FUNCTION prevent_space_delete();--> statement-breakpoint
CREATE FUNCTION reject_private_space_resolver() RETURNS trigger AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM spaces
		WHERE id = NEW.space_id AND route_class = 'private'
	) THEN
		RAISE EXCEPTION 'a private Space cannot have a Source Resolver';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER space_resolvers_public_only
	BEFORE INSERT OR UPDATE ON "space_resolvers"
	FOR EACH ROW EXECUTE FUNCTION reject_private_space_resolver();
