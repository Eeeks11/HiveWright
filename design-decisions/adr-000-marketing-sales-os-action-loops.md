# ADR-000: Marketing OS, Sales/Conversion OS, and Action-Loop Substrate

Status: Proposed for review
Date: 2026-06-15
Task: t_f0d99b92
Source plan: workspace artifact `hivewright-marketing-sales-os-dev-plan.md`
Spike reviewed: branch `marketing-action-loops` commit `f947015` (`Add closed-loop operating schedule templates`)

## Context

HiveWright needs two connected but distinct growth operating systems:

- Marketing OS = attention system: create, capture, and direct qualified attention.
- Sales/Conversion OS = conversion system: convert attention/leads into conversations, bookings, quotes, sales, reviews, referrals, repeat business, and reactivation.

The previous `marketing-action-loops` branch is a spike. It proves a useful primitive for `observe -> plan -> execute -> measure -> optimise`, but it should not be merged as the product surface. The product needs first-class data, dashboards, approval gates, connector freshness, and owner-visible outcomes. Schedules alone would recreate the failure mode called out in the plan: impressive reports that leave the owner to read, decide, and manually request execution.

## Decision

Build Marketing OS and Sales/Conversion OS as dedicated hive-scoped product areas backed by a shared action-loop substrate.

The shared substrate must make the closed loop first-class:

```text
Observe -> Plan -> Execute -> Measure -> Optimise -> Observe
```

Every recurring workflow must either execute a bounded action, move an executable plan forward, create an approval request, or measure completed work and feed the next cycle. Report-only schedules are allowed only as explicitly diagnostic workflows.

### Product boundaries

1. Marketing OS owns attention:
   - audience/persona research;
   - positioning, offers, channel strategy;
   - campaigns, content calendar, assets, approvals;
   - attention metrics: reach, impressions, search visibility, clicks, landing page visits, CPC, engagement quality, CPL where available.

2. Sales/Conversion OS owns conversion:
   - lead capture and speed-to-lead;
   - qualification, booking, show-up, close, review/referral/repeat/reactivation;
   - conversation review and sales scripts;
   - conversion metrics: response time, booking rate, show-up rate, close rate, revenue, review rate, referral rate, reactivation rate.

3. Shared Growth Command Center is optional and aggregating only:
   - it may show attention -> lead -> conversation -> booking/quote -> sale -> review -> referral/repeat/reactivation;
   - it must not blur marketing and sales ownership or hide the current bottleneck.

### Action-loop substrate requirements

The substrate must support:

- loop templates with domain, objective, stages, roles, schedules, approval policy, success metric, and owner-visible output policy;
- loop runs with stage state, input/output manifests, action/approval links, metrics read/written, and optimiser decision;
- stage handoff validation so later stages read structured previous outputs, not only prose;
- approval integration for public, spend, and customer-facing execution;
- bounded autonomy policy for low-risk actions only;
- connector/data freshness visibility;
- tenant/hive isolation for all loop state, metrics, assets, and approvals.

## Schema proposal

These are proposed logical tables/types, not final Drizzle code. They should be implemented in small PRs with migrations and tests.

### `business_growth_profiles`

Hive-scoped profile for growth context.

Key fields:

- `id uuid primary key`
- `hive_id uuid not null references hives(id) on delete cascade`
- `industry text not null`
- `category text`
- `target_customers jsonb not null default []`
- `personas jsonb not null default []`
- `offers jsonb not null default []`
- `service_areas jsonb not null default []`
- `average_customer_value_cents integer`
- `average_booking_value_cents integer`
- `currency varchar(16)`
- `capacity_constraints jsonb not null default {}`
- `seasonality jsonb not null default {}`
- `brand_voice jsonb not null default {}`
- `forbidden_claims jsonb not null default []`
- `approval_policy jsonb not null default {}`
- `connected_channels jsonb not null default []`
- `created_at timestamp not null default now()`
- `updated_at timestamp not null default now()`

Constraints/indexes:

- unique `(hive_id)` unless multi-profile support is explicitly needed later;
- JSON type checks for object/array fields.

### `growth_channel_accounts`

Connector/channel registry for growth data and actions. This should link to existing `connector_installs` where credentials/connectors exist; do not duplicate secrets.

Key fields:

- `id uuid primary key`
- `hive_id uuid not null references hives(id) on delete cascade`
- `connector_install_id uuid references connector_installs(id) on delete set null`
- `channel_type varchar(64) not null` — `website`, `ga4`, `search_console`, `google_business_profile`, `meta_ads`, `google_ads`, `social`, `email_platform`, `crm`, `booking`, `phone_tracking`, `review_platform`, `manual`
- `display_name text not null`
- `status varchar(32) not null default 'not_connected'` — `not_connected`, `connected`, `degraded`, `blocked`, `disabled`
- `capabilities jsonb not null default []` — `read_metrics`, `draft_asset`, `publish_asset`, `send_message`, `adjust_spend`, etc.
- `last_sync_at timestamp`
- `freshness_state varchar(32) not null default 'unknown'` — `fresh`, `stale`, `missing`, `error`, `unknown`
- `error_summary text`
- `metadata jsonb not null default {}`
- `created_at`, `updated_at`

Indexes:

- `(hive_id, channel_type, status)`
- `(connector_install_id)`

### `growth_campaigns`

Campaign/objective record for both operating systems.

Key fields:

- `id uuid primary key`
- `hive_id uuid not null references hives(id) on delete cascade`
- `domain varchar(32) not null` — `marketing_attention` or `sales_conversion`
- `name text not null`
- `objective text not null`
- `status varchar(32) not null default 'idea'` — `idea`, `draft`, `approval`, `approved`, `running`, `paused`, `completed`, `killed`
- `channels jsonb not null default []`
- `target_audience jsonb not null default {}`
- `offer jsonb not null default {}`
- `budget_policy jsonb not null default {}`
- `start_at timestamp`, `end_at timestamp`
- `success_metrics jsonb not null default []`
- `loop_template_id uuid references growth_loop_templates(id) on delete set null`
- `current_loop_run_id uuid references growth_loop_runs(id) on delete set null`
- `metadata jsonb not null default {}`
- `created_at`, `updated_at`

Constraints/indexes:

- check domain and status values;
- `(hive_id, domain, status)`;
- `(hive_id, start_at, end_at)`.

### `growth_assets`

Draft/public assets linked to campaigns and approvals.

Key fields:

- `id uuid primary key`
- `hive_id uuid not null references hives(id) on delete cascade`
- `campaign_id uuid references growth_campaigns(id) on delete cascade`
- `asset_type varchar(64) not null` — `social_post`, `email`, `ad`, `landing_page`, `blog`, `gbp_update`, `print_brief`, `script`, `sms`, `call_script`, `review_request`, `referral_ask`
- `channel_type varchar(64)`
- `title text not null`
- `draft_body text`
- `variants jsonb not null default []`
- `approval_state varchar(32) not null default 'draft'` — `draft`, `awaiting_approval`, `approved`, `rejected`, `changes_requested`, `expired`
- `publication_state varchar(32) not null default 'not_published'` — `not_published`, `queued`, `published`, `failed`, `cancelled`
- `external_action_request_id uuid references external_action_requests(id) on delete set null`
- `published_at timestamp`
- `metadata jsonb not null default {}`
- `created_at`, `updated_at`

Indexes:

- `(hive_id, campaign_id)`;
- `(hive_id, approval_state)`;
- `(hive_id, publication_state)`.

### `growth_loop_templates`

Reusable closed-loop definitions.

Key fields:

- `id uuid primary key`
- `hive_id uuid references hives(id) on delete cascade` — nullable only for system templates
- `domain varchar(32) not null` — `marketing_attention`, `sales_conversion`
- `slug varchar(128) not null`
- `name text not null`
- `objective text not null`
- `stages jsonb not null` — ordered observe/plan/execute/measure/optimise definitions
- `success_metric text not null`
- `owner_visible_output varchar(32) not null` — `exception_only`, `approval_request`, `weekly_summary`
- `default_autonomy_level integer not null default 1`
- `approval_policy jsonb not null default {}`
- `created_at`, `updated_at`

Constraints/indexes:

- unique `(hive_id, slug)` nulls-not-distinct;
- check autonomy level 0-5;
- JSON checks for stage array.

### `growth_loop_runs`

Actual loop/cycle execution state.

Key fields:

- `id uuid primary key`
- `hive_id uuid not null references hives(id) on delete cascade`
- `template_id uuid references growth_loop_templates(id) on delete set null`
- `campaign_id uuid references growth_campaigns(id) on delete set null`
- `domain varchar(32) not null`
- `stage varchar(32) not null` — `observe`, `plan`, `execute`, `measure`, `optimise`
- `status varchar(32) not null default 'queued'` — `queued`, `running`, `awaiting_approval`, `blocked`, `completed`, `failed`, `cancelled`
- `cycle_key varchar(128) not null`
- `inputs_manifest jsonb not null default []`
- `outputs_manifest jsonb not null default []`
- `state jsonb not null default {}`
- `next_stage varchar(32)`
- `approvals_required jsonb not null default []`
- `external_action_request_id uuid references external_action_requests(id) on delete set null`
- `metrics_snapshot_id uuid references growth_metrics_snapshots(id) on delete set null`
- `optimiser_decision varchar(32)` — `kill`, `keep`, `change`, `scale`, `observe_more`
- `started_at timestamp`, `completed_at timestamp`
- `created_at`, `updated_at`

Indexes:

- `(hive_id, domain, status)`;
- `(hive_id, cycle_key)`;
- `(template_id, created_at)`.

### `growth_metrics_snapshots`

Normalized metrics snapshots by source/channel/campaign.

Key fields:

- `id uuid primary key`
- `hive_id uuid not null references hives(id) on delete cascade`
- `campaign_id uuid references growth_campaigns(id) on delete set null`
- `channel_account_id uuid references growth_channel_accounts(id) on delete set null`
- `source_connector varchar(128) not null`
- `metric_domain varchar(32) not null` — `attention`, `conversion`, `revenue`, `reviews`, `referrals`
- `period_start timestamp not null`
- `period_end timestamp not null`
- `metrics jsonb not null default {}` — normalized values
- `raw_redacted jsonb not null default {}`
- `attribution_confidence varchar(32) not null default 'unknown'`
- `data_freshness varchar(32) not null default 'unknown'`
- `connector_errors jsonb not null default []`
- `created_at timestamp not null default now()`

Indexes:

- `(hive_id, metric_domain, period_end)`;
- `(campaign_id, period_end)`;
- `(channel_account_id, period_end)`.

### Approval queue integration

Do not create a duplicate approvals system unless the existing one cannot serve the flow. Use `external_action_requests` for execution approval and add growth-specific references as needed:

- preferred: `growth_assets.external_action_request_id` and `growth_loop_runs.external_action_request_id` link to existing requests;
- if owner-decision UX requires a separate growth approval list, it should be a read model over `external_action_requests` plus `growth_assets`/`growth_loop_runs`, not a second source of truth.

Approval request payload should include:

- action type;
- risk level;
- preview;
- reason;
- expected outcome;
- rollback/pause plan;
- expiry;
- campaign/loop/asset links;
- spend cap where relevant.

## Route/component map

Use dedicated dashboard sections. Marketing and Sales must not be hidden under generic schedules.

### Navigation

Add two top-level nav groups, or one `Growth` group with clearly separated Marketing and Sales children. Preferred initial map:

- `Marketing` group
  - `/marketing` — overview
  - `/marketing/campaigns`
  - `/marketing/channels`
  - `/marketing/calendar`
  - `/marketing/assets`
  - `/marketing/metrics`
  - `/marketing/loops`
- `Sales` group
  - `/sales` — overview
  - `/sales/pipeline`
  - `/sales/leakage`
  - `/sales/conversations`
  - `/sales/reviews-referrals`
  - `/sales/reactivation`
  - `/sales/metrics`
  - `/sales/loops`
- optional later: `/growth` command center for the combined attention-to-conversion handoff.

### API route proposal

- `GET/PUT /api/hives/[id]/growth-profile`
- `GET/POST /api/hives/[id]/growth-channel-accounts`
- `GET/POST /api/hives/[id]/growth-campaigns`
- `GET/PATCH /api/hives/[id]/growth-campaigns/[campaignId]`
- `GET/POST /api/hives/[id]/growth-assets`
- `GET/PATCH /api/hives/[id]/growth-assets/[assetId]`
- `GET/POST /api/hives/[id]/growth-loop-templates`
- `GET/POST /api/hives/[id]/growth-loop-runs`
- `POST /api/hives/[id]/growth-loop-runs/[runId]/advance`
- `GET/POST /api/hives/[id]/growth-metrics-snapshots`
- `GET /api/hives/[id]/marketing/overview`
- `GET /api/hives/[id]/sales/overview`

All routes must enforce hive access, active-hive context, and existing auth invariants. Routes must treat connector/document/email content as untrusted data.

### Component/page proposal

Marketing pages:

- `src/app/(dashboard)/marketing/page.tsx`
- `src/app/(dashboard)/marketing/campaigns/page.tsx`
- `src/app/(dashboard)/marketing/channels/page.tsx`
- `src/app/(dashboard)/marketing/calendar/page.tsx`
- `src/app/(dashboard)/marketing/assets/page.tsx`
- `src/app/(dashboard)/marketing/metrics/page.tsx`
- `src/app/(dashboard)/marketing/loops/page.tsx`
- `src/components/growth/marketing-overview.tsx`
- `src/components/growth/campaign-list.tsx`
- `src/components/growth/channel-health-panel.tsx`
- `src/components/growth/content-calendar.tsx`
- `src/components/growth/asset-approval-list.tsx`
- `src/components/growth/attention-metrics-panel.tsx`
- `src/components/growth/loop-state-timeline.tsx`

Sales pages:

- `src/app/(dashboard)/sales/page.tsx`
- `src/app/(dashboard)/sales/pipeline/page.tsx`
- `src/app/(dashboard)/sales/leakage/page.tsx`
- `src/app/(dashboard)/sales/conversations/page.tsx`
- `src/app/(dashboard)/sales/reviews-referrals/page.tsx`
- `src/app/(dashboard)/sales/reactivation/page.tsx`
- `src/app/(dashboard)/sales/metrics/page.tsx`
- `src/app/(dashboard)/sales/loops/page.tsx`
- `src/components/growth/sales-overview.tsx`
- `src/components/growth/lead-pipeline.tsx`
- `src/components/growth/leakage-map.tsx`
- `src/components/growth/conversation-review-panel.tsx`
- `src/components/growth/reviews-referrals-panel.tsx`
- `src/components/growth/reactivation-panel.tsx`
- `src/components/growth/conversion-metrics-panel.tsx`
- `src/components/growth/loop-state-timeline.tsx` shared with Marketing

Shared optional command center:

- `src/app/(dashboard)/growth/page.tsx`
- `src/components/growth/growth-command-center.tsx`
- `src/components/growth/funnel-handoff.tsx`
- `src/components/growth/current-bottleneck-card.tsx`

## First PR breakdown

No production code should be written before this ADR/schema/UI plan is reviewed.

### PR 1: Action-loop substrate schema and contracts

Scope:

- Add `growth_loop_templates` and `growth_loop_runs` schema/migration.
- Add TypeScript domain types and validation helpers for stages and handoff manifests.
- Add tests for stage ordering, next-stage calculation, and report-only dead-end rejection.

Acceptance:

- A loop template can define observe/plan/execute/measure/optimise.
- A loop run records structured inputs/outputs and next stage.
- Execute stage cannot proceed for unsafe public/spend/customer-facing actions without approval link.

### PR 2: Business growth profile and channel accounts

Scope:

- Add `business_growth_profiles` and `growth_channel_accounts` schema/migration.
- Add CRUD API routes with hive auth.
- Add basic setup UI or settings panel for profile/channel freshness.

Acceptance:

- A hive can store growth profile, approval policy, channel accounts, and connector freshness.
- No connector credentials are duplicated in growth tables.

### PR 3: Campaigns, assets, and approvals

Scope:

- Add `growth_campaigns` and `growth_assets` schema/migration.
- Link assets/loop execution to `external_action_requests`.
- Add campaign list and asset approvals UI.

Acceptance:

- Owner can see campaigns and pending asset approvals.
- Approved execution creates traceable external action requests/execution logs.

### PR 4: Marketing OS foundation

Scope:

- Add Marketing nav/routes/pages.
- Add overview, campaigns, channels, calendar, assets, metrics, loops views.
- Support manual/imported metrics before connectors are complete.

Acceptance:

- A hive can create a marketing objective.
- System can produce a campaign plan/assets as drafts.
- Dashboard shows active campaigns, pending approvals, connector freshness, and results.

### PR 5: Sales/Conversion OS foundation

Scope:

- Add Sales nav/routes/pages.
- Add pipeline/leakage model using existing business records where possible.
- Add sales loop templates: reactivation, lead follow-up, reviews/referrals, missed-call recovery, sales training.

Acceptance:

- A hive can see conversion leakage.
- System identifies one bottleneck and creates a bounded action plan.
- Approved action is executed/logged or queued to a connector.

### PR 6: Connector integrations and dogfood hardening

Scope:

- Prioritise GA4/Search Console/forms, Google Business Profile/reviews, email/CRM/booking, then ads/phone.
- Add metric snapshot ingestion and freshness/error UI.
- Add dogfood fixtures and first real hive runbook.

Acceptance:

- Missing/untrusted/manual data is clearly labelled.
- At least one observe-plan-execute-measure-optimise cycle completes for a real hive with approval-gated execution.

## Dogfood criteria for first real hive

Use one real hive at low autonomy, likely Lakes if data access is available.

Entry criteria:

- business growth profile completed;
- at least one usable attention source or manual metric path;
- at least one usable conversion/review/referral/reactivation source or manual metric path;
- approval policy explicitly set;
- no autonomous ad spend;
- owner-visible approval queue works;
- connector freshness/errors visible.

First Marketing loop:

- objective: content/GBP/email/SEO opportunity that creates qualified attention;
- autonomy: Level 1 draft-only or Level 2 approved execution;
- execute stage produces an approval request for any public/customer-facing action;
- measure stage compares result to a baseline and writes structured metrics.

First Sales loop:

- objective: reviews/referrals/reactivation or lead follow-up if data exists;
- autonomy: Level 1 draft-only or Level 2 approved execution;
- execute stage queues/sends only approved customer-facing messages;
- measure stage compares response/booking/review/referral metrics and feeds optimiser.

Pass criteria:

- at least one full observe-plan-execute-measure-optimise cycle completes;
- at least one approved public action is executed or queued to an external connector with an audit trail;
- results are measured and used in the next cycle;
- owner sees concise approvals/outcomes, not giant reports;
- no connector content becomes executable instructions;
- all work remains hive-isolated.

## Spike reconciliation: commit `f947015`

### Keep

- The canonical stage vocabulary: `observe`, `plan`, `execute`, `measure`, `optimise`.
- The domain split for `marketing-attention` and `sales-conversion`.
- The idea that loop metadata belongs on scheduled work, including objective, reads/writes, next stage, approval mode, success metric, and owner-visible output.
- The test coverage proving loop schedule generation and business growth blueprint generation.
- The language in stage briefs that rejects dead-end narrative reports and pushes toward executable plans, approvals, measurement, and next actions.

### Keep only after redesign/refactor

- `buildActionLoopScheduleDefinitions(...)`: useful as a seed/template generator, but it should not be the core runtime model. Refactor it to emit `growth_loop_templates`/stage definitions rather than schedule-only task templates.
- `BusinessGrowthLoopBlueprint`: keep conceptually, but move from a static schedule bundle into seed data/template definitions for first marketing/sales loops.
- `src/db/schema/schedules.ts` `template.actionLoop` metadata: keep as compatibility/handoff metadata only; the authoritative loop state should live in `growth_loop_runs` and related tables.

### Discard / do not merge as product

- Treating schedules as the main product primitive for Marketing/Sales OS.
- Workspace-file/business-record path strings as the only state model; proper typed records and manifests are needed.
- Default roles like `researcher`, `strategist`, `executor`, `analyst` without checking current role-library alignment and hive-specific assignments.
- Hard-coded default cron timings as product behavior; cadence should come from loop templates and owner/hive policy.
- The broad `ActionLoopDomain` list (`operations`, `finance`, `custom`) for this product slice. Keep the substrate extensible, but the PRs should initially lock to marketing attention and sales conversion.
- Any assumption that `bounded-autonomy` is safe for optimise/execution without policy checks. Public/spend/customer-facing actions default to approval-required.

## Consequences

Positive:

- Marketing and Sales become owner-visible operating systems, not hidden schedule mechanics.
- Loop state becomes auditable and reusable across stages.
- Approval gates are designed into execution rather than bolted on later.
- The spike contributes vocabulary and tests without dictating product architecture.

Tradeoffs:

- More schema/UI work before a visible feature ships.
- More explicit data modelling than a simple schedule-template patch.
- Connector integration remains staged; early UI must honestly label manual/missing data.

Risks and mitigations:

- Risk: too many tables before dogfood. Mitigation: PRs 1-3 should implement only fields needed for first loops, while preserving extension points in JSON metadata.
- Risk: dashboard becomes another report surface. Mitigation: every loop view must show current stage, next action, approvals needed, and measured result.
- Risk: public/spend actions execute too freely. Mitigation: default Level 1-2 autonomy, approval link required for execute stage, spend caps before paid ads.
- Risk: connector content prompt-injects agents. Mitigation: route all external content through data ingestion/normalization, never as trusted instructions.

## Review checklist

A reviewer should verify this plan against the source plan before allowing production code:

- [ ] Marketing remains attention-focused.
- [ ] Sales remains conversion-focused.
- [ ] The action-loop substrate prevents report-only dead ends.
- [ ] Schema proposal covers growth profile, campaigns, assets, loop runs/state, metrics snapshots, and approvals.
- [ ] Routes/components give Marketing and Sales dedicated dashboard sections.
- [ ] PR breakdown avoids merging spike code as product without redesign.
- [ ] Dogfood criteria require a real closed loop with measured outcomes.
- [ ] `f947015` keep/discard decisions are explicit.
