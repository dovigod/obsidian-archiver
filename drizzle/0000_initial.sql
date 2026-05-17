-- Initial knowledge-hub schema.
--
-- Hand-written rather than generated so we can co-locate the FTS5 virtual
-- table + triggers that drizzle-kit can't synthesize. Subsequent migrations
-- can be drizzle-kit generated; this one stays manual.

CREATE TABLE `entities` (
  `id`          TEXT PRIMARY KEY NOT NULL,
  `name`        TEXT NOT NULL,
  `summary`     TEXT NOT NULL DEFAULT '',
  `body_md`     TEXT NOT NULL DEFAULT '',
  `deleted_at`  INTEGER,
  `created_at`  INTEGER NOT NULL,
  `updated_at`  INTEGER NOT NULL,
  `synced_at`   INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entities_name_unique` ON `entities` (`name`);
--> statement-breakpoint
CREATE INDEX `idx_entities_deleted_at` ON `entities` (`deleted_at`);
--> statement-breakpoint
CREATE INDEX `idx_entities_updated_at` ON `entities` (`updated_at`);
--> statement-breakpoint

CREATE TABLE `entity_aliases` (
  `entity_id` TEXT NOT NULL REFERENCES `entities`(`id`) ON DELETE CASCADE,
  `alias`     TEXT NOT NULL,
  PRIMARY KEY (`entity_id`, `alias`)
);
--> statement-breakpoint

CREATE TABLE `conversations` (
  `id`                      TEXT PRIMARY KEY NOT NULL,
  `source`                  TEXT NOT NULL,
  `model`                   TEXT,
  `created_at`              INTEGER NOT NULL,
  `project_json`            TEXT NOT NULL DEFAULT '[]',
  `topics_json`             TEXT NOT NULL DEFAULT '[]',
  `conversation_type_json`  TEXT NOT NULL DEFAULT '[]',
  `tags_json`               TEXT NOT NULL DEFAULT '[]',
  `git_repo`                TEXT,
  `git_branch`              TEXT,
  `git_commit`              TEXT,
  `cwd`                     TEXT,
  `raw_path`                TEXT NOT NULL
);
--> statement-breakpoint

CREATE TABLE `sources` (
  `entity_id`       TEXT NOT NULL REFERENCES `entities`(`id`) ON DELETE CASCADE,
  `conversation_id` TEXT NOT NULL REFERENCES `conversations`(`id`) ON DELETE CASCADE,
  PRIMARY KEY (`entity_id`, `conversation_id`)
);
--> statement-breakpoint

CREATE TABLE `jobs` (
  `id`            TEXT PRIMARY KEY NOT NULL,
  `type`          TEXT NOT NULL,
  `payload_json`  TEXT NOT NULL,
  `state`         TEXT NOT NULL DEFAULT 'pending',
  `attempts`      INTEGER NOT NULL DEFAULT 0,
  `enqueued_at`   INTEGER NOT NULL,
  `started_at`    INTEGER,
  `lease_until`   INTEGER,
  `finished_at`   INTEGER,
  `last_error`    TEXT
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_state_enqueued` ON `jobs` (`state`, `enqueued_at`);
--> statement-breakpoint
CREATE INDEX `idx_jobs_state_lease` ON `jobs` (`state`, `lease_until`);
--> statement-breakpoint

CREATE TABLE `rendered_files` (
  `path`                TEXT PRIMARY KEY NOT NULL,
  `kind`                TEXT NOT NULL,
  `source_id`           TEXT NOT NULL,
  `last_rendered_hash`  BLOB,
  `last_rendered_at`    INTEGER,
  `synced_at`           INTEGER
);
--> statement-breakpoint
CREATE INDEX `idx_rendered_files_source` ON `rendered_files` (`source_id`);
--> statement-breakpoint
CREATE INDEX `idx_rendered_files_dirty` ON `rendered_files` (`last_rendered_at`);
--> statement-breakpoint

-- FTS5 virtual table for fuzzy dedup lookup. One row per (term, entity_id);
-- `term` is either the entity's canonical name or one of its aliases.
CREATE VIRTUAL TABLE `entity_terms_fts` USING fts5(
  term,
  entity_id UNINDEXED,
  tokenize = 'porter unicode61'
);
--> statement-breakpoint

-- Sync triggers: keep `entity_terms_fts` consistent with `entities.name`
-- and `entity_aliases.alias`. Cascade deletes on entities are handled by
-- the foreign-key constraint plus the trigger below.
CREATE TRIGGER `entities_ai_fts` AFTER INSERT ON `entities` BEGIN
  INSERT INTO `entity_terms_fts` (`term`, `entity_id`)
  VALUES (NEW.`name`, NEW.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `entities_au_fts` AFTER UPDATE OF `name` ON `entities`
WHEN OLD.`name` != NEW.`name`
BEGIN
  DELETE FROM `entity_terms_fts`
  WHERE `term` = OLD.`name` AND `entity_id` = OLD.`id`;
  INSERT INTO `entity_terms_fts` (`term`, `entity_id`)
  VALUES (NEW.`name`, NEW.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `entities_ad_fts` AFTER DELETE ON `entities` BEGIN
  DELETE FROM `entity_terms_fts` WHERE `entity_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `aliases_ai_fts` AFTER INSERT ON `entity_aliases` BEGIN
  INSERT INTO `entity_terms_fts` (`term`, `entity_id`)
  VALUES (NEW.`alias`, NEW.`entity_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `aliases_ad_fts` AFTER DELETE ON `entity_aliases` BEGIN
  DELETE FROM `entity_terms_fts`
  WHERE `term` = OLD.`alias` AND `entity_id` = OLD.`entity_id`;
END;
