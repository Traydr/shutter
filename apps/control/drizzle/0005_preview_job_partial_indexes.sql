DROP INDEX "preview_jobs_claim_idx";--> statement-breakpoint
CREATE INDEX "preview_jobs_pending_idx" ON "preview_jobs" USING btree ("kind","next_attempt_at") WHERE "preview_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "preview_jobs_processing_idx" ON "preview_jobs" USING btree ("kind") WHERE "preview_jobs"."status" = 'processing';