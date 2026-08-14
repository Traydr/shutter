ALTER TABLE "rendition_jobs" RENAME TO "preview_jobs";--> statement-breakpoint
ALTER TABLE "preview_jobs" RENAME CONSTRAINT "rendition_jobs_space_id_source_id_kind_pk" TO "preview_jobs_space_id_source_id_kind_pk";--> statement-breakpoint
ALTER TABLE "preview_jobs" RENAME CONSTRAINT "rendition_jobs_kind_check" TO "preview_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "preview_jobs" RENAME CONSTRAINT "rendition_jobs_status_check" TO "preview_jobs_status_check";--> statement-breakpoint
ALTER TABLE "preview_jobs" RENAME CONSTRAINT "rendition_jobs_counter_check" TO "preview_jobs_counter_check";--> statement-breakpoint
ALTER INDEX "rendition_jobs_claim_idx" RENAME TO "preview_jobs_claim_idx";
