-- Advanced dedup via embeddings (Stage 5, thread 3).
--
-- Opt-in: rows are only written when `dedup.fuzzy.embeddings.enabled` is true
-- in the runtime config. The worker enqueues an `embed` job per
-- created/updated entity; the job computes the vector and upserts here.
--
-- Storage: vectors as raw Float32 blobs. `dims` + `model` tag the row so a
-- model upgrade can invalidate stale embeddings.

CREATE TABLE `dedup_embeddings` (
  `entity_id`  TEXT PRIMARY KEY NOT NULL
                REFERENCES `entities`(`id`) ON DELETE CASCADE,
  `vector`     BLOB    NOT NULL,
  `dims`       INTEGER NOT NULL,
  `model`      TEXT    NOT NULL,
  `updated_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dedup_embeddings_model` ON `dedup_embeddings` (`model`);
