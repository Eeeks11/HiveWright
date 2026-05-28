CREATE TABLE IF NOT EXISTS "hive_memory_governance" (
  "hive_id" uuid PRIMARY KEY NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "memory_disabled" boolean DEFAULT false NOT NULL,
  "reason" text,
  "changed_by" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "last_used_at" timestamp,
  "last_write_at" timestamp,
  "last_blocked_at" timestamp,
  "last_blocked_operation" text,
  "last_blocked_source" text
);
