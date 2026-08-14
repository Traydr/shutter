ALTER TABLE "rendition_jobs" RENAME TO "derivative_jobs";--> statement-breakpoint
ALTER TABLE "derivative_jobs" RENAME CONSTRAINT "rendition_jobs_space_id_source_id_kind_pk" TO "derivative_jobs_space_id_source_id_kind_pk";--> statement-breakpoint
ALTER TABLE "derivative_jobs" RENAME CONSTRAINT "rendition_jobs_kind_check" TO "derivative_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "derivative_jobs" RENAME CONSTRAINT "rendition_jobs_status_check" TO "derivative_jobs_status_check";--> statement-breakpoint
ALTER TABLE "derivative_jobs" RENAME CONSTRAINT "rendition_jobs_counter_check" TO "derivative_jobs_counter_check";--> statement-breakpoint
ALTER INDEX "rendition_jobs_claim_idx" RENAME TO "derivative_jobs_claim_idx";
