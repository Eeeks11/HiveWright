import fs from "fs";
import path from "path";
import { sql } from "../_lib/db";
import { jsonOk, jsonError } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { isHiveKind, normalizeHiveKind } from "@/hives/kind";
import { seedDefaultSchedules } from "@/hives/seed-schedules";
import { hiveProjectsPath } from "@/hives/workspace-root";

const HIVE_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,63}$/;

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const includeSystemFixtures =
      new URL(request.url).searchParams.get("includeSystemFixtures") === "true";
    const rows = authz.user.isSystemOwner
      ? includeSystemFixtures
        ? await sql`
        SELECT h.id, h.slug, h.name, h.type, h.kind, h.description, h.workspace_path, h.is_system_fixture, h.created_at,
               bop.id AS business_os_profile_id,
               bop.business_mode AS business_os_mode,
               CASE
                 WHEN h.kind <> 'business' THEN NULL
                 WHEN bop.id IS NULL THEN 'setup_required'
                 WHEN bop.business_mode = 'existing_business' THEN 'audit_in_progress'
                 ELSE 'setup_in_progress'
               END AS business_os_status,
               readiness.avg_score AS business_os_average_readiness_score,
               COALESCE(open_gaps.count, 0)::int AS business_os_open_gaps_count,
               COALESCE(approvals.count, 0)::int AS business_os_approvals_required_count,
               CASE
                 WHEN h.kind <> 'business' THEN NULL
                 WHEN bop.id IS NULL THEN 'Set up or audit this business'
                 WHEN next_action.title IS NOT NULL THEN next_action.title
                 WHEN COALESCE(approvals.count, 0) > 0 THEN 'Review owner approvals'
                 WHEN COALESCE(open_gaps.count, 0) > 0 THEN 'Review open Business OS gaps'
                 ELSE 'Open Business OS dashboard'
               END AS business_os_next_action
        FROM hives h
        LEFT JOIN business_os_profiles bop ON bop.hive_id = h.id
        LEFT JOIN LATERAL (
          SELECT ROUND(AVG(readiness_score))::int AS avg_score
          FROM business_system_readiness
          WHERE hive_id = h.id
        ) readiness ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS count
          FROM business_gaps
          WHERE hive_id = h.id
            AND status IN ('open', 'accepted', 'in_progress')
        ) open_gaps ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS count
          FROM business_actions
          WHERE hive_id = h.id
            AND approval_required = true
            AND status IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked')
        ) approvals ON TRUE
        LEFT JOIN LATERAL (
          SELECT title
          FROM business_actions
          WHERE hive_id = h.id
            AND status IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked')
          ORDER BY priority DESC, updated_at DESC
          LIMIT 1
        ) next_action ON TRUE
        ORDER BY h.name ASC
      `
        : await sql`
        SELECT h.id, h.slug, h.name, h.type, h.kind, h.description, h.workspace_path, h.is_system_fixture, h.created_at,
               bop.id AS business_os_profile_id,
               bop.business_mode AS business_os_mode,
               CASE
                 WHEN h.kind <> 'business' THEN NULL
                 WHEN bop.id IS NULL THEN 'setup_required'
                 WHEN bop.business_mode = 'existing_business' THEN 'audit_in_progress'
                 ELSE 'setup_in_progress'
               END AS business_os_status,
               readiness.avg_score AS business_os_average_readiness_score,
               COALESCE(open_gaps.count, 0)::int AS business_os_open_gaps_count,
               COALESCE(approvals.count, 0)::int AS business_os_approvals_required_count,
               CASE
                 WHEN h.kind <> 'business' THEN NULL
                 WHEN bop.id IS NULL THEN 'Set up or audit this business'
                 WHEN next_action.title IS NOT NULL THEN next_action.title
                 WHEN COALESCE(approvals.count, 0) > 0 THEN 'Review owner approvals'
                 WHEN COALESCE(open_gaps.count, 0) > 0 THEN 'Review open Business OS gaps'
                 ELSE 'Open Business OS dashboard'
               END AS business_os_next_action
        FROM hives h
        LEFT JOIN business_os_profiles bop ON bop.hive_id = h.id
        LEFT JOIN LATERAL (
          SELECT ROUND(AVG(readiness_score))::int AS avg_score
          FROM business_system_readiness
          WHERE hive_id = h.id
        ) readiness ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS count
          FROM business_gaps
          WHERE hive_id = h.id
            AND status IN ('open', 'accepted', 'in_progress')
        ) open_gaps ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS count
          FROM business_actions
          WHERE hive_id = h.id
            AND approval_required = true
            AND status IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked')
        ) approvals ON TRUE
        LEFT JOIN LATERAL (
          SELECT title
          FROM business_actions
          WHERE hive_id = h.id
            AND status IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked')
          ORDER BY priority DESC, updated_at DESC
          LIMIT 1
        ) next_action ON TRUE
        WHERE h.is_system_fixture = false
        ORDER BY h.name ASC
      `
      : includeSystemFixtures
        ? await sql`
        SELECT h.id, h.slug, h.name, h.type, h.kind, h.description, h.workspace_path, h.is_system_fixture, h.created_at,
               bop.id AS business_os_profile_id,
               bop.business_mode AS business_os_mode,
               CASE
                 WHEN h.kind <> 'business' THEN NULL
                 WHEN bop.id IS NULL THEN 'setup_required'
                 WHEN bop.business_mode = 'existing_business' THEN 'audit_in_progress'
                 ELSE 'setup_in_progress'
               END AS business_os_status,
               readiness.avg_score AS business_os_average_readiness_score,
               COALESCE(open_gaps.count, 0)::int AS business_os_open_gaps_count,
               COALESCE(approvals.count, 0)::int AS business_os_approvals_required_count,
               CASE
                 WHEN h.kind <> 'business' THEN NULL
                 WHEN bop.id IS NULL THEN 'Set up or audit this business'
                 WHEN next_action.title IS NOT NULL THEN next_action.title
                 WHEN COALESCE(approvals.count, 0) > 0 THEN 'Review owner approvals'
                 WHEN COALESCE(open_gaps.count, 0) > 0 THEN 'Review open Business OS gaps'
                 ELSE 'Open Business OS dashboard'
               END AS business_os_next_action
        FROM hives h
        INNER JOIN hive_memberships hm ON hm.hive_id = h.id
        LEFT JOIN business_os_profiles bop ON bop.hive_id = h.id
        LEFT JOIN LATERAL (
          SELECT ROUND(AVG(readiness_score))::int AS avg_score
          FROM business_system_readiness
          WHERE hive_id = h.id
        ) readiness ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS count
          FROM business_gaps
          WHERE hive_id = h.id
            AND status IN ('open', 'accepted', 'in_progress')
        ) open_gaps ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS count
          FROM business_actions
          WHERE hive_id = h.id
            AND approval_required = true
            AND status IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked')
        ) approvals ON TRUE
        LEFT JOIN LATERAL (
          SELECT title
          FROM business_actions
          WHERE hive_id = h.id
            AND status IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked')
          ORDER BY priority DESC, updated_at DESC
          LIMIT 1
        ) next_action ON TRUE
        WHERE hm.user_id = ${authz.user.id}
        ORDER BY h.name ASC
      `
        : await sql`
        SELECT h.id, h.slug, h.name, h.type, h.kind, h.description, h.workspace_path, h.is_system_fixture, h.created_at,
               bop.id AS business_os_profile_id,
               bop.business_mode AS business_os_mode,
               CASE
                 WHEN h.kind <> 'business' THEN NULL
                 WHEN bop.id IS NULL THEN 'setup_required'
                 WHEN bop.business_mode = 'existing_business' THEN 'audit_in_progress'
                 ELSE 'setup_in_progress'
               END AS business_os_status,
               readiness.avg_score AS business_os_average_readiness_score,
               COALESCE(open_gaps.count, 0)::int AS business_os_open_gaps_count,
               COALESCE(approvals.count, 0)::int AS business_os_approvals_required_count,
               CASE
                 WHEN h.kind <> 'business' THEN NULL
                 WHEN bop.id IS NULL THEN 'Set up or audit this business'
                 WHEN next_action.title IS NOT NULL THEN next_action.title
                 WHEN COALESCE(approvals.count, 0) > 0 THEN 'Review owner approvals'
                 WHEN COALESCE(open_gaps.count, 0) > 0 THEN 'Review open Business OS gaps'
                 ELSE 'Open Business OS dashboard'
               END AS business_os_next_action
        FROM hives h
        INNER JOIN hive_memberships hm ON hm.hive_id = h.id
        LEFT JOIN business_os_profiles bop ON bop.hive_id = h.id
        LEFT JOIN LATERAL (
          SELECT ROUND(AVG(readiness_score))::int AS avg_score
          FROM business_system_readiness
          WHERE hive_id = h.id
        ) readiness ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS count
          FROM business_gaps
          WHERE hive_id = h.id
            AND status IN ('open', 'accepted', 'in_progress')
        ) open_gaps ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS count
          FROM business_actions
          WHERE hive_id = h.id
            AND approval_required = true
            AND status IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked')
        ) approvals ON TRUE
        LEFT JOIN LATERAL (
          SELECT title
          FROM business_actions
          WHERE hive_id = h.id
            AND status IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked')
          ORDER BY priority DESC, updated_at DESC
          LIMIT 1
        ) next_action ON TRUE
        WHERE hm.user_id = ${authz.user.id}
          AND h.is_system_fixture = false
        ORDER BY h.name ASC
      `;
    const data = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      type: r.type,
      kind: normalizeHiveKind(r.kind),
      description: r.description,
      workspacePath: r.workspace_path,
      isSystemFixture: r.is_system_fixture,
      createdAt: r.created_at,
      businessOs: normalizeHiveKind(r.kind) === "business" ? {
        status: r.business_os_status ?? (r.business_os_profile_id ? "setup_in_progress" : "setup_required"),
        mode: r.business_os_mode ?? null,
        profileId: r.business_os_profile_id ?? null,
        href: r.business_os_profile_id
          ? `/business-os/${r.id}`
          : `/hives/${r.id}/business-os/setup`,
        readiness: {
          state: r.business_os_average_readiness_score === null || r.business_os_average_readiness_score === undefined ? "unknown" : "measured",
          averageScore: r.business_os_average_readiness_score === null || r.business_os_average_readiness_score === undefined ? null : Number(r.business_os_average_readiness_score),
          label: r.business_os_average_readiness_score === null || r.business_os_average_readiness_score === undefined ? "Not measured" : `${Number(r.business_os_average_readiness_score)}% ready`,
        },
        openGapsCount: Number(r.business_os_open_gaps_count ?? 0),
        approvalsRequiredCount: Number(r.business_os_approvals_required_count ?? 0),
        nextAction: r.business_os_next_action ?? (r.business_os_profile_id ? "Open Business OS dashboard" : "Set up or audit this business"),
        actionPreview: r.business_os_next_action && r.business_os_profile_id && r.business_os_next_action !== "Open Business OS dashboard" ? {
          title: r.business_os_next_action,
          href: null,
          stateLabel: "Missing target",
          description: "This Business OS action is informational until HiveWright links it to a decision, task, deliverable, or conversion target.",
        } : null,
      } : null,
    }));
    return jsonOk(data);
  } catch {
    return jsonError("Failed to fetch hives", 500);
  }
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  if (!authz.user.isSystemOwner) {
    return jsonError("Forbidden: system owner role required", 403);
  }
  try {
    const body = await request.json();
    const { name, slug, type, kind, description, mission } = body;
    if (!name || !slug || !type || !kind) return jsonError("name, slug, type, and kind are required", 400);
    if (!isHiveKind(kind)) return jsonError("kind must be one of business, personal_project, personal_assistant, research, creative", 400);
    if (typeof slug !== "string" || !HIVE_SLUG_REGEX.test(slug)) {
      return jsonError("slug must match ^[a-z0-9][a-z0-9-]{1,63}$", 400);
    }
    const workspacePath = hiveProjectsPath(slug);
    const [row] = await sql`
      INSERT INTO hives (name, slug, type, kind, operating_mode, description, mission, workspace_path)
      VALUES (${name}, ${slug}, ${type}, ${kind}, ${"exploring"}, ${description || null}, ${mission || null}, ${workspacePath})
      RETURNING *
    `;

    // Create hive workspace directory structure
    const bizRoot = path.dirname(workspacePath);
    for (const dir of ["projects", "skills", "ea"]) {
      fs.mkdirSync(path.join(bizRoot, dir), { recursive: true });
    }

    // Seed the built-in daily world-scan schedule. Non-fatal — a scheduling
    // hiccup shouldn't prevent hive creation.
    try {
      await seedDefaultSchedules(sql, {
        id: row.id as string,
        name: row.name as string,
        description: (row.description as string | null) ?? null,
        kind,
      }, {
        coreEnabled: true,
        proactiveEnabled: true,
      });
    } catch (err) {
      console.warn("[api/hives POST] failed to seed default schedules:", err);
    }

    return jsonOk({ id: row.id, name: row.name, slug: row.slug, type: row.type, kind: normalizeHiveKind(row.kind) }, 201);
  } catch {
    return jsonError("Failed to create hive", 500);
  }
}
