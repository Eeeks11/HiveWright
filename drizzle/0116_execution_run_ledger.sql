CREATE TABLE "execution_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "goal_id" uuid REFERENCES "goals"("id") ON DELETE SET NULL,
  "adapter_type" varchar(100) NOT NULL,
  "model" varchar(255),
  "session_id" text,
  "dispatcher_pid" integer,
  "process_group_id" integer,
  "host_id" varchar(255),
  "status" varchar(50) DEFAULT 'pending' NOT NULL,
  "liveness_state" varchar(50) DEFAULT 'pending' NOT NULL,
  "liveness_reason" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "last_output_at" timestamp with time zone,
  "last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
  "exit_code" integer,
  "signal" varchar(50),
  "stdout_excerpt" text,
  "stderr_excerpt" text,
  "output_bytes" integer DEFAULT 0 NOT NULL,
  "log_ref" text,
  "log_hash" varchar(128),
  "log_bytes" integer,
  "fresh_input_tokens" integer,
  "cached_input_tokens" integer,
  "tokens_input" integer,
  "tokens_output" integer,
  "estimated_billable_cost_cents" integer,
  "usage_details" jsonb,
  "retry_of_run_id" uuid REFERENCES "execution_runs"("id") ON DELETE SET NULL,
  "continuation_attempt" integer DEFAULT 0 NOT NULL,
  "finalization_result" varchar(100),
  "error_message" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "execution_run_events" (
  "id" bigserial PRIMARY KEY,
  "run_id" uuid NOT NULL REFERENCES "execution_runs"("id") ON DELETE CASCADE,
  "hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "event_type" varchar(50) NOT NULL,
  "message" text,
  "payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_execution_runs_hive_status" ON "execution_runs" ("hive_id", "status");
CREATE INDEX "idx_execution_runs_task_started" ON "execution_runs" ("task_id", "started_at" DESC);
CREATE INDEX "idx_execution_runs_goal_started" ON "execution_runs" ("goal_id", "started_at" DESC);
CREATE INDEX "idx_execution_runs_liveness" ON "execution_runs" ("liveness_state", "last_event_at");
CREATE INDEX "idx_execution_run_events_run_created" ON "execution_run_events" ("run_id", "created_at", "id");
CREATE INDEX "idx_execution_run_events_hive_created" ON "execution_run_events" ("hive_id", "created_at" DESC);
