-- Idempotent archive support: hash of normalized messages so the backfill
-- scraper can skip transcripts already imported. Nullable for back-compat
-- with rows inserted before this migration.
ALTER TABLE `conversations` ADD COLUMN `content_hash` TEXT;
--> statement-breakpoint
CREATE INDEX `idx_conversations_content_hash` ON `conversations` (`content_hash`);
