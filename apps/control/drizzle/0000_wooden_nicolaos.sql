CREATE TABLE "rendition_jobs" (
	"space_id" text NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"source_capability" text,
	"execution_cycle" integer DEFAULT 0 NOT NULL,
	"attempt_number" integer DEFAULT 0 NOT NULL,
	"retry_deadline_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"processing_token" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"master_key" text,
	"master_width" integer,
	"master_height" integer,
	"master_format" text,
	"object_etag" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rendition_jobs_space_id_source_id_kind_pk" PRIMARY KEY("space_id","source_id","kind"),
	CONSTRAINT "rendition_jobs_kind_check" CHECK ("rendition_jobs"."kind" in ('video', 'pdf')),
	CONSTRAINT "rendition_jobs_status_check" CHECK ("rendition_jobs"."status" in ('pending', 'processing', 'ready', 'failed')),
	CONSTRAINT "rendition_jobs_counter_check" CHECK ("rendition_jobs"."execution_cycle" >= 0 and "rendition_jobs"."attempt_number" >= 0)
);
--> statement-breakpoint
CREATE INDEX "rendition_jobs_claim_idx" ON "rendition_jobs" USING btree ("kind","status","next_attempt_at");