CREATE TABLE IF NOT EXISTS "dispatcher_heartbeats" (
  "dispatcher_id" varchar(128) PRIMARY KEY NOT NULL,
  "pid" integer NOT NULL,
  "host_id" varchar(255) NOT NULL,
  "version" varchar(64),
  "build_hash" varchar(128),
  "status" varchar(32) DEFAULT 'running' NOT NULL,
  "last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" text
);

CREATE INDEX IF NOT EXISTS "dispatcher_heartbeats_last_heartbeat_idx"
  ON "dispatcher_heartbeats" ("last_heartbeat_at");
