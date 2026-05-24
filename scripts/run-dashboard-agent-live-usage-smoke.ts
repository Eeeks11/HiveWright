import postgres from "postgres";
import {
  getOwnerSessionSmokeConfig,
  resetOwnerSessionLocalFixture,
} from "../src/auth/owner-session-smoke";
import { assertLocalOwnerSessionResetAllowed } from "../src/auth/local-owner-session";

interface CookieJar {
  values: Map<string, string>;
}

type JsonRecord = Record<string, unknown>;

const FIXTURE_SLUG = "dashboard-agent-live-smoke";
const USER_AGENT = "HiveWright-Agent-Live-Smoke/phase-0-6";

function requireOptIn(env: NodeJS.ProcessEnv = process.env): void {
  if (env.HIVEWRIGHT_LIVE_SMOKE_ALLOW_DB_WRITES !== "1") {
    throw new Error(
      "HIVEWRIGHT_LIVE_SMOKE_ALLOW_DB_WRITES=1 is required; this smoke creates and cleans a local system-fixture hive.",
    );
  }
}

function cookieHeader(jar: CookieJar): string {
  return Array.from(jar.values.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
}

function storeCookies(jar: CookieJar, response: Response): void {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const values = typeof getSetCookie === "function"
    ? getSetCookie.call(response.headers)
    : response.headers.get("set-cookie")?.split(/,(?=\s*[^;,]+=)/) ?? [];

  for (const raw of values) {
    const first = raw.split(";")[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    jar.values.set(first.slice(0, eq), first.slice(eq + 1));
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

async function signIn(baseUrl: string, ownerEmail: string, ownerPassword: string): Promise<CookieJar> {
  const jar: CookieJar = { values: new Map() };
  const csrf = await fetch(`${baseUrl}/api/auth/csrf`, {
    headers: { "user-agent": USER_AGENT },
  });
  storeCookies(jar, csrf);
  if (!csrf.ok) throw new Error(`CSRF request failed with ${csrf.status}`);
  const csrfBody = asRecord(await csrf.json());
  const csrfToken = typeof csrfBody.csrfToken === "string" ? csrfBody.csrfToken : null;
  if (!csrfToken) throw new Error("CSRF response did not include csrfToken");

  const body = new URLSearchParams({
    email: ownerEmail,
    password: ownerPassword,
    csrfToken,
    callbackUrl: `${baseUrl}/`,
    json: "true",
  });
  const login = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(jar),
      "user-agent": USER_AGENT,
    },
    body,
  });
  storeCookies(jar, login);
  if (login.status !== 302) {
    throw new Error(`Login failed; expected 302, got ${login.status}`);
  }
  return jar;
}

async function fetchAuthed(baseUrl: string, jar: CookieJar, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      cookie: cookieHeader(jar),
      "user-agent": USER_AGENT,
    },
    redirect: "manual",
  });
}

async function seedFixture(sql: postgres.Sql): Promise<{ hiveId: string; goalId: string; completionId: string; outcomeId: string }> {
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type, kind, operating_mode, description, mission, is_system_fixture)
    VALUES (
      ${FIXTURE_SLUG},
      'Dashboard Agent Live Smoke',
      'digital',
      'research',
      'active',
      'System fixture used by live dashboard smoke tests.',
      'Verify that autonomous agents can use owner dashboard surfaces without creating product issues.',
      true
    )
    ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name,
        kind = EXCLUDED.kind,
        operating_mode = EXCLUDED.operating_mode,
        description = EXCLUDED.description,
        mission = EXCLUDED.mission,
        is_system_fixture = true
    RETURNING id
  `;

  await sql`
    INSERT INTO hive_operating_profiles (
      hive_id,
      kind,
      purpose,
      desired_outcome,
      current_30_day_outcome,
      constraints,
      approval_rules,
      forbidden_actions,
      important_context,
      success_criteria,
      stop_or_pause_criteria,
      kind_profile
    ) VALUES (
      ${hive.id},
      'research',
      'Live dashboard agent smoke test',
      'Prove phase 0-6 owner dashboard surfaces are reachable and coherent for an agent-run hive.',
      'Keep dashboard usage checks green without leaking fixture data into normal owner views.',
      ${sql.json(["Use only system-fixture data", "Do not perform external actions"])},
      ${sql.json(["Owner approval required before any external side effect"])},
      ${sql.json(["No external messages", "No connector writes"])},
      ${sql.json(["Fixture slug is dashboard-agent-live-smoke"])},
      ${sql.json(["Dashboard pages return 200", "Records and scoreboard APIs expose seeded data", "Outcome handoff is reviewable"])},
      ${sql.json(["Stop if dashboard auth fails", "Stop if fixture cleanup cannot be confirmed"])},
      ${sql.json({ questions: ["Can agents use the dashboard live?"], confidenceBar: "high" })}
    )
    ON CONFLICT (hive_id) DO UPDATE
    SET kind = EXCLUDED.kind,
        purpose = EXCLUDED.purpose,
        desired_outcome = EXCLUDED.desired_outcome,
        current_30_day_outcome = EXCLUDED.current_30_day_outcome,
        constraints = EXCLUDED.constraints,
        approval_rules = EXCLUDED.approval_rules,
        forbidden_actions = EXCLUDED.forbidden_actions,
        important_context = EXCLUDED.important_context,
        success_criteria = EXCLUDED.success_criteria,
        stop_or_pause_criteria = EXCLUDED.stop_or_pause_criteria,
        kind_profile = EXCLUDED.kind_profile,
        updated_at = now()
  `;

  await sql`
    INSERT INTO business_records (
      hive_id,
      source_connector,
      external_id,
      record_family,
      record_type,
      status,
      title,
      occurred_at,
      summary,
      metadata,
      normalized,
      raw_redacted
    ) VALUES
      (
        ${hive.id},
        'manual',
        'dashboard-agent-live-smoke-source',
        'evidence',
        'source',
        'reviewed',
        'Dashboard smoke source reviewed',
        now(),
        'Agent reviewed the live dashboard source pages.',
        ${sql.json({ smoke: true })},
        ${sql.json({ confidence: 0.95 })},
        ${sql.json({ redacted: true })}
      ),
      (
        ${hive.id},
        'manual',
        'dashboard-agent-live-smoke-finding',
        'evidence',
        'finding',
        'closed',
        'Dashboard smoke finding',
        now(),
        'Live phase dashboard surfaces returned coherent owner-facing data.',
        ${sql.json({ smoke: true })},
        ${sql.json({ confidence: 0.95 })},
        ${sql.json({ redacted: true })}
      )
    ON CONFLICT (hive_id, source_connector, external_id, record_type) DO UPDATE
    SET status = EXCLUDED.status,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        updated_at = now()
  `;

  const [goal] = await sql<{ id: string }[]>`
    INSERT INTO goals (hive_id, title, description, priority, status)
    VALUES (${hive.id}, 'Verify dashboard live usage by agents', 'Live smoke goal for phase 0-6 dashboard usage.', 1, 'achieved')
    RETURNING id
  `;
  const [completion] = await sql<{ id: string }[]>`
    INSERT INTO goal_completions (goal_id, summary, evidence, learning_gate, created_by)
    VALUES (
      ${goal.id},
      'Dashboard live usage smoke fixture completed.',
      ${sql.json({ bundle: [{ type: "live_dashboard_smoke", description: "Agent fetched owner dashboard routes and APIs.", verified: true }] })},
      ${sql.json({ category: "nothing", rationale: "Live smoke fixture only." })},
      'dashboard-agent-live-smoke'
    )
    RETURNING id
  `;
  const [outcome] = await sql<{ id: string }[]>`
    INSERT INTO owner_outcomes (
      hive_id,
      goal_id,
      goal_completion_id,
      summary,
      why_it_matters,
      impact_statement,
      recommended_next_action,
      evidence,
      primary_open_url,
      primary_artifact_title,
      primary_artifact_render_mode,
      review_state,
      route_metadata
    ) VALUES (
      ${hive.id},
      ${goal.id},
      ${completion.id},
      'Agent live dashboard smoke completed',
      'Confirms the owner-facing dashboard can be used against a real running app, not just mocked units.',
      'Phase 0-6 surfaces are reachable for a research hive fixture.',
      'No owner action required; delete fixture after smoke.',
      ${sql.json({ smoke: true, goalCompletionId: completion.id })},
      ${`/hives/${hive.id}`},
      'Dashboard live smoke fixture',
      'text',
      'new',
      ${sql.json({ source: "dashboard-agent-live-smoke" })}
    )
    RETURNING id
  `;

  return { hiveId: hive.id, goalId: goal.id, completionId: completion.id, outcomeId: outcome.id };
}

async function cleanupFixture(sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM hives WHERE slug = ${FIXTURE_SLUG}`;
  let deleted = 0;
  for (const row of rows) {
    await sql`DELETE FROM schedule_fire_snapshots WHERE hive_id = ${row.id}`;
    await sql`DELETE FROM schedules WHERE hive_id = ${row.id}`;
    await sql`DELETE FROM owner_outcomes WHERE hive_id = ${row.id}`;
    await sql`DELETE FROM goal_completions WHERE goal_id IN (SELECT id FROM goals WHERE hive_id = ${row.id})`;
    await sql`DELETE FROM goals WHERE hive_id = ${row.id}`;
    await sql`DELETE FROM business_records WHERE hive_id = ${row.id}`;
    await sql`DELETE FROM hive_operating_profiles WHERE hive_id = ${row.id}`;
    await sql`DELETE FROM hives WHERE id = ${row.id}`;
    deleted += 1;
  }
  return deleted;
}

function assertStatus(label: string, response: Response, expected = 200): void {
  if (response.status !== expected) {
    throw new Error(`${label} expected HTTP ${expected}, got ${response.status}`);
  }
}

async function assertJsonResponse(label: string, response: Response): Promise<JsonRecord> {
  assertStatus(label, response, 200);
  return asRecord(await readJson(response));
}

async function main() {
  requireOptIn();
  const config = getOwnerSessionSmokeConfig();
  if (!config.ownerPassword) throw new Error("OWNER_PASSWORD is required.");
  assertLocalOwnerSessionResetAllowed(config.databaseUrl);

  await resetOwnerSessionLocalFixture(config);
  const db = postgres(config.databaseUrl, { max: 1 });
  let seeded: Awaited<ReturnType<typeof seedFixture>> | null = null;
  try {
    await cleanupFixture(db);
    seeded = await seedFixture(db);
    const jar = await signIn(config.baseUrl, config.ownerEmail, config.ownerPassword);

    const checks: Array<{ label: string; status: number; detail?: unknown }> = [];
    const recordPage = async (label: string, path: string) => {
      const response = await fetchAuthed(config.baseUrl, jar, path);
      assertStatus(label, response, 200);
      const text = await response.text();
      if (!text.includes("HiveWright") && !text.includes("Dashboard") && !text.includes("hive")) {
        throw new Error(`${label} did not look like a dashboard page`);
      }
      checks.push({ label, status: response.status });
    };
    const recordApi = async (label: string, path: string, predicate?: (body: JsonRecord) => void) => {
      const response = await fetchAuthed(config.baseUrl, jar, path);
      const body = await assertJsonResponse(label, response);
      predicate?.(body);
      checks.push({ label, status: response.status, detail: Object.keys(body) });
    };

    await recordPage("dashboard home", "/");
    await recordPage("hive detail page", `/hives/${seeded.hiveId}`);
    await recordPage("decisions page", "/decisions");
    await recordPage("final outputs page", "/deliverables");
    await recordPage("analytics page", "/analytics");

    await recordApi("dashboard summary API", `/api/dashboard/summary?hiveId=${seeded.hiveId}`);
    await recordApi("hive detail API", `/api/hives/${seeded.hiveId}`, (body) => {
      const data = asRecord(body.data);
      if (data.kind !== "research") throw new Error("Hive detail API did not return research kind");
      if (!data.operatingProfile) throw new Error("Hive detail API did not return operatingProfile");
    });
    await recordApi("records API", `/api/hives/${seeded.hiveId}/records`, (body) => {
      const data = asRecord(body.data);
      const records = Array.isArray(data.records) ? data.records : [];
      if (records.length < 2) throw new Error("Records API did not return seeded fixture records");
    });
    await recordApi("scoreboard API", `/api/hives/${seeded.hiveId}/scoreboard`, (body) => {
      const data = asRecord(body.data);
      const hive = asRecord(data.hive);
      const kindMetrics = asRecord(data.kindMetrics);
      if (hive.kind !== "research" || kindMetrics.kind !== "research") {
        throw new Error("Scoreboard API did not return research hive/kind metrics");
      }
    });
    await recordApi("outcomes API", `/api/outcomes?hiveId=${seeded.hiveId}`, (body) => {
      const outcomes = Array.isArray(body.data) ? body.data : [];
      if (!outcomes.some((outcome) => asRecord(outcome).id === seeded?.outcomeId)) {
        throw new Error("Outcomes API did not return seeded owner outcome");
      }
    });

    console.log(JSON.stringify({ ok: true, baseUrl: config.baseUrl, hiveId: seeded.hiveId, checks }, null, 2));
  } finally {
    const deleted = await cleanupFixture(db);
    await db.end({ timeout: 5 });
    if (seeded) {
      console.error(`dashboard-agent-live-smoke cleanup deleted ${deleted} fixture hive(s).`);
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
