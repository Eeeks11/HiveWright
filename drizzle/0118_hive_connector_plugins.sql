CREATE TABLE IF NOT EXISTS "hive_connector_plugins" (
  "hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE cascade,
  "plugin_slug" varchar(100) NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hive_connector_plugins_hive_plugin_idx"
  ON "hive_connector_plugins" ("hive_id", "plugin_slug");
