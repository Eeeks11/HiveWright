import "dotenv/config";

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { listDeliverables } from "@/deliverables/queries";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://hivewright@localhost:5432/hivewrightv2";
const FIXTURE_SLUG = "deliverables-demo-fixture";
const FIXTURE_ROLE_SLUG = "deliverables-demo-agent";
const WORKSPACE_ROOT = path.resolve(
  process.env.DELIVERABLES_DEMO_WORKSPACE ??
    path.join(process.cwd(), ".hivewright", "demo-fixtures", FIXTURE_SLUG),
);

export const MANUAL_QA_CHECKLIST = [
  "Local desktop browser can open /deliverables after signing in.",
  "Tailscale browser can open the same /deliverables route using the Tailscale host/IP.",
  "Mobile browser can open the same /deliverables route while signed in.",
  "Open buttons work for the seeded markdown report, HTML landing page, image, and generic file deliverables.",
  "Copy link produces a current-origin URL from the browser location, not a hard-coded localhost URL.",
  "Generated HTML is rendered in the HiveWright sandbox and cannot access HiveWright cookies, localStorage, or parent app context.",
  "Unauthorized user cannot access another hive’s deliverables; verify with a non-member account or API request and expect 403/redirect.",
  "Run this script again with --cleanup when manual QA is finished.",
] as const;

export type DemoFixtureDeliverableKind = "markdown" | "html" | "image" | "file";

export const DEMO_DELIVERABLES: ReadonlyArray<{
  kind: DemoFixtureDeliverableKind;
  title: string;
  filename: string;
  mimeType: string;
  renderMode: "markdown" | "html" | "image" | "file";
  artifactKind: string;
  taskTitle: string;
  summary: string;
}> = [
  {
    kind: "markdown",
    title: "Seeded Demo Markdown Report",
    filename: "seeded-demo-report.md",
    mimeType: "text/markdown; charset=utf-8",
    renderMode: "markdown",
    artifactKind: "text",
    taskTitle: "Write seeded markdown report deliverable",
    summary: "Markdown report used to prove readable report deliverables end-to-end.",
  },
  {
    kind: "html",
    title: "Seeded Demo HTML Landing Page",
    filename: "seeded-demo-landing-page.html",
    mimeType: "text/html; charset=utf-8",
    renderMode: "html",
    artifactKind: "html",
    taskTitle: "Produce seeded HTML landing page deliverable",
    summary: "HTML landing page used to prove sandboxed browser preview behavior.",
  },
  {
    kind: "image",
    title: "Seeded Demo Image Deliverable",
    filename: "seeded-demo-diagram.svg",
    mimeType: "image/svg+xml",
    renderMode: "image",
    artifactKind: "image",
    taskTitle: "Produce seeded image deliverable",
    summary: "SVG image used to prove inline image preview and download behavior.",
  },
  {
    kind: "file",
    title: "Seeded Demo Downloadable File",
    filename: "seeded-demo-download.bin",
    mimeType: "application/octet-stream",
    renderMode: "file",
    artifactKind: "file",
    taskTitle: "Package seeded generic downloadable file deliverable",
    summary: "Generic binary-like file used to prove non-preview download behavior.",
  },
] as const;

function usage(): string {
  return `Usage: npx tsx scripts/setup-deliverables-demo-fixture.ts [--cleanup] [--json]\n\nSeeds a HiveWright demo hive with clickable deliverables for end-to-end owner QA.\n\nEnvironment:\n  DATABASE_URL                         Postgres database to seed. Defaults to local hivewrightv2.\n  DELIVERABLES_DEMO_WORKSPACE          Optional workspace path for seeded file-backed artifacts.\n\nManual QA checklist:\n${MANUAL_QA_CHECKLIST.map((item) => `  - ${item}`).join("\n")}\n`;
}

function parseArgs(args: string[]) {
  return {
    cleanup: args.includes("--cleanup"),
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

function relativeWorkspacePath(filename: string): string {
  return path.posix.join("deliverables", filename);
}

function reportContent(): string {
  return `# Seeded demo report\n\nThis markdown report proves that HiveWright deliverables can be opened from the Deliverables inbox.\n\n## Checks\n\n- Markdown renders as readable text in the review surface.\n- Download returns the same report content.\n- Links stay relative/current-origin safe for desktop, Tailscale, and mobile access.\n`;
}

function landingPageContent(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Seeded Demo Landing Page</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #f8fafc; }
      main { min-height: 100vh; display: grid; place-items: center; padding: 48px 24px; }
      section { max-width: 760px; border: 1px solid rgba(148, 163, 184, 0.35); border-radius: 28px; padding: 40px; background: linear-gradient(135deg, rgba(15,23,42,.94), rgba(30,41,59,.88)); box-shadow: 0 24px 80px rgba(15,23,42,.45); }
      .eyebrow { color: #fbbf24; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 13px; }
      h1 { font-size: clamp(36px, 8vw, 72px); line-height: .95; margin: 16px 0; }
      p { color: #cbd5e1; font-size: 18px; line-height: 1.7; }
      code { color: #fde68a; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <div class="eyebrow">HiveWright seeded HTML deliverable</div>
        <h1>Clickable work, reviewable anywhere.</h1>
        <p>This intentionally generated HTML page is for sandbox QA. The script below attempts to read browser app context. In the HiveWright preview iframe it should be blocked from privileged cookies, localStorage, and parent app access.</p>
        <p id="sandbox-result"><code>Sandbox probe has not run.</code></p>
      </section>
    </main>
    <script>
      const result = document.getElementById("sandbox-result");
      try {
        const cookieLength = document.cookie.length;
        const storageLength = localStorage.length;
        const parentLocation = window.parent && window.parent !== window ? String(window.parent.location.href) : "no-parent";
        result.textContent = "Probe result: cookieLength=" + cookieLength + ", localStorageLength=" + storageLength + ", parentLocation=" + parentLocation;
      } catch (error) {
        result.textContent = "Sandbox blocked privileged access: " + error.message;
      }
    </script>
  </body>
</html>
`;
}

function imageContent(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-label="HiveWright deliverables demo diagram">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f59e0b"/>
      <stop offset="55%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
  </defs>
  <rect width="960" height="540" rx="36" fill="url(#bg)"/>
  <circle cx="168" cy="148" r="72" fill="rgba(255,255,255,.18)"/>
  <circle cx="802" cy="398" r="108" fill="rgba(255,255,255,.14)"/>
  <text x="80" y="260" fill="#ffffff" font-family="Arial, sans-serif" font-size="64" font-weight="800">Deliverables Demo</text>
  <text x="84" y="322" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="30">Markdown • HTML • Image • File</text>
  <text x="84" y="382" fill="#fef3c7" font-family="Arial, sans-serif" font-size="24">Seeded fixture for desktop, Tailscale, and mobile QA</text>
</svg>
`;
}

function fileContent(): string {
  return [
    "HiveWright seeded generic downloadable file",
    "This file intentionally uses application/octet-stream.",
    "It proves non-preview deliverables still have a stable download URL.",
    `Generated at: ${new Date().toISOString()}`,
    "",
  ].join("\n");
}

async function writeArtifactFiles(): Promise<Record<DemoFixtureDeliverableKind, string>> {
  const deliverablesDir = path.join(WORKSPACE_ROOT, "deliverables");
  await mkdir(deliverablesDir, { recursive: true });

  const byKind: Record<DemoFixtureDeliverableKind, string> = {
    markdown: reportContent(),
    html: landingPageContent(),
    image: imageContent(),
    file: fileContent(),
  };
  const paths = {} as Record<DemoFixtureDeliverableKind, string>;
  for (const deliverable of DEMO_DELIVERABLES) {
    const filePath = path.join(deliverablesDir, deliverable.filename);
    await writeFile(filePath, byKind[deliverable.kind]);
    paths[deliverable.kind] = relativeWorkspacePath(deliverable.filename);
  }
  return paths;
}

async function cleanupFixture(sql: Sql): Promise<void> {
  const existing = await sql<{ id: string }[]>`SELECT id FROM hives WHERE slug = ${FIXTURE_SLUG} LIMIT 1`;
  const hiveId = existing[0]?.id;
  if (hiveId) {
    await sql`
      DELETE FROM goal_completions
      WHERE goal_id IN (SELECT id FROM goals WHERE hive_id = ${hiveId})
    `;
    await sql`DELETE FROM work_products WHERE hive_id = ${hiveId}`;
    await sql`DELETE FROM tasks WHERE hive_id = ${hiveId}`;
    await sql`DELETE FROM goals WHERE hive_id = ${hiveId}`;
    await sql`DELETE FROM hive_memberships WHERE hive_id = ${hiveId}`;
    await sql`DELETE FROM hives WHERE id = ${hiveId}`;
  }
  await rm(WORKSPACE_ROOT, { recursive: true, force: true });
}

async function ensureFixtureRole(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO role_templates (
      slug,
      name,
      department,
      type,
      adapter_type,
      role_md,
      soul_md,
      tools_md,
      terminal,
      active
    ) VALUES (
      ${FIXTURE_ROLE_SLUG},
      'Deliverables Demo Agent',
      'qa',
      'executor',
      'fixture',
      'Seeded demo fixture role for clickable deliverables QA.',
      'Create deterministic demo deliverables only.',
      'No external tools required.',
      true,
      true
    )
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      department = EXCLUDED.department,
      adapter_type = EXCLUDED.adapter_type,
      active = true,
      updated_at = now()
  `;
}

async function grantExistingOwners(sql: Sql, hiveId: string): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE is_active = true AND is_system_owner = true
  `;
  for (const row of rows) {
    await sql`
      INSERT INTO hive_memberships (user_id, hive_id, role)
      VALUES (${row.id}, ${hiveId}, 'owner')
      ON CONFLICT (user_id, hive_id) DO UPDATE SET role = EXCLUDED.role
    `;
  }
  return rows.length;
}

export async function createDeliverablesDemoFixture(sql: Sql) {
  await cleanupFixture(sql);
  await ensureFixtureRole(sql);
  const filePaths = await writeArtifactFiles();

  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (
      slug,
      name,
      type,
      description,
      mission,
      workspace_path,
      is_system_fixture
    ) VALUES (
      ${FIXTURE_SLUG},
      'Deliverables Demo Fixture',
      'digital',
      'Seeded fixture proving clickable owner deliverables end-to-end.',
      'Prove markdown, HTML, image, and generic file deliverables are findable, openable, downloadable, and current-origin safe.',
      ${WORKSPACE_ROOT},
      false
    )
    RETURNING id
  `;

  const [goal] = await sql<{ id: string }[]>`
    INSERT INTO goals (
      hive_id,
      title,
      description,
      priority,
      status,
      budget_cents,
      spent_cents
    ) VALUES (
      ${hive.id},
      'Clickable deliverables seeded demo goal',
      'Goal containing multiple completed tasks, each with a reviewable deliverable for phase 8 QA.',
      1,
      'completed',
      0,
      0
    )
    RETURNING id
  `;

  const seededDeliverables = [] as Array<{ id: string; taskId: string; title: string; renderMode: string; reviewUrl: string; openUrl: string; downloadUrl: string }>;
  for (const deliverable of DEMO_DELIVERABLES) {
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        status,
        priority,
        title,
        brief,
        goal_id,
        result_summary,
        started_at,
        completed_at
      ) VALUES (
        ${hive.id},
        ${FIXTURE_ROLE_SLUG},
        'phase-8-demo-fixture',
        'completed',
        1,
        ${deliverable.taskTitle},
        ${`Seed task for ${deliverable.title}.`},
        ${goal.id},
        ${deliverable.summary},
        now(),
        now()
      )
      RETURNING id
    `;

    const [workProduct] = await sql<{ id: string }[]>`
      INSERT INTO work_products (
        task_id,
        hive_id,
        role_slug,
        department,
        content,
        title,
        summary,
        filename,
        artifact_kind,
        file_path,
        mime_type,
        review_status,
        render_mode,
        source_url,
        sensitivity,
        synthesized,
        metadata
      ) VALUES (
        ${task.id},
        ${hive.id},
        ${FIXTURE_ROLE_SLUG},
        'qa',
        ${deliverable.kind === "markdown" ? reportContent() : deliverable.summary},
        ${deliverable.title},
        ${deliverable.summary},
        ${deliverable.filename},
        ${deliverable.artifactKind},
        ${filePaths[deliverable.kind]},
        ${deliverable.mimeType},
        'needs_review',
        ${deliverable.renderMode},
        ${relativeWorkspacePath(deliverable.filename)},
        'internal',
        true,
        ${sql.json({ seededDemoFixture: true, phase: 8, kind: deliverable.kind })}
      )
      RETURNING id
    `;

    seededDeliverables.push({
      id: workProduct.id,
      taskId: task.id,
      title: deliverable.title,
      renderMode: deliverable.renderMode,
      reviewUrl: `/deliverables/${workProduct.id}`,
      openUrl: `/deliverables/${workProduct.id}/open`,
      downloadUrl: `/api/deliverables/${workProduct.id}/download`,
    });
  }

  await sql`
    INSERT INTO goal_completions (
      goal_id,
      summary,
      evidence,
      created_by
    ) VALUES (
      ${goal.id},
      'Seeded final owner output is ready. Use the primary Final Outputs action to open the generated landing page directly; review/provenance links remain secondary.',
      ${sql.json({
        taskIds: seededDeliverables.map((deliverable) => deliverable.taskId),
        workProductIds: seededDeliverables.map((deliverable) => deliverable.id),
        bundle: seededDeliverables.map((deliverable) => ({
          type: "work_product",
          description: deliverable.title,
          reference: deliverable.reviewUrl,
          value: { openUrl: deliverable.openUrl, renderMode: deliverable.renderMode },
          verified: true,
        })),
      })},
      'deliverables-demo-fixture'
    )
  `;

  const ownerMembershipsGranted = await grantExistingOwners(sql, hive.id);
  const listed = await listDeliverables(sql, { hiveId: hive.id, goalId: goal.id, completedOnly: true });
  const modes = new Set(listed.map((item) => item.renderMode));
  const missingModes = ["markdown", "html", "image", "file"].filter((mode) => !modes.has(mode as never));
  if (listed.length !== DEMO_DELIVERABLES.length || missingModes.length > 0) {
    throw new Error(
      `Fixture validation failed: listed=${listed.length}, missingModes=${missingModes.join(",") || "none"}`,
    );
  }

  return {
    hiveId: hive.id,
    hiveSlug: FIXTURE_SLUG,
    goalId: goal.id,
    workspacePath: WORKSPACE_ROOT,
    ownerMembershipsGranted,
    deliverables: seededDeliverables,
    routes: {
      inbox: "/deliverables",
      hiveScoped: `/hives/${hive.id}/deliverables`,
      goal: `/goals/${goal.id}`,
    },
    manualQaChecklist: MANUAL_QA_CHECKLIST,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    if (args.cleanup) {
      await cleanupFixture(sql);
      const payload = { ok: true, cleaned: true, hiveSlug: FIXTURE_SLUG, workspacePath: WORKSPACE_ROOT };
      console.log(args.json ? JSON.stringify(payload, null, 2) : `[deliverables-demo-fixture] cleaned ${FIXTURE_SLUG}`);
      return;
    }

    const fixture = await createDeliverablesDemoFixture(sql);
    if (args.json) {
      console.log(JSON.stringify({ ok: true, fixture }, null, 2));
      return;
    }

    console.log(`[deliverables-demo-fixture] seeded hive: ${fixture.hiveId} (${fixture.hiveSlug})`);
    console.log(`[deliverables-demo-fixture] goal: ${fixture.goalId}`);
    console.log(`[deliverables-demo-fixture] workspace: ${fixture.workspacePath}`);
    console.log(`[deliverables-demo-fixture] owner memberships granted: ${fixture.ownerMembershipsGranted}`);
    console.log("[deliverables-demo-fixture] routes:");
    console.log(`  - Inbox: ${fixture.routes.inbox}`);
    console.log(`  - Hive deliverables: ${fixture.routes.hiveScoped}`);
    console.log(`  - Goal: ${fixture.routes.goal}`);
    console.log("[deliverables-demo-fixture] deliverables:");
    for (const deliverable of fixture.deliverables) {
      console.log(`  - ${deliverable.title} (${deliverable.renderMode}): ${deliverable.reviewUrl} | open ${deliverable.openUrl} | download ${deliverable.downloadUrl}`);
    }
    console.log("\nManual QA checklist:");
    for (const item of MANUAL_QA_CHECKLIST) {
      console.log(`  - ${item}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[deliverables-demo-fixture] failed:", error);
    process.exit(1);
  });
}
