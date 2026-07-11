import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

type Finding = {
  file: string;
  message: string;
};

const HIVE_ID_QUERY_READ = /\bsearchParams\s*\.\s*get\s*\(\s*(['"`])hiveId\1\s*\)/;
const STRICT_HIVE_TARGET_HELPER = "requireStrictHiveTarget";
const ROUTE_HANDLER = /export\s+(?:async\s+)?function\s+(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\b/g;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ACCESS_ONLY_HIVE_GATE = /\bcanAccessHive\b|\brequireStrictHiveTarget\s*\(|\brequireHiveAccess\s*\(|\bauthorizeHive(?:Request)?\s*\(|\bresolveHiveAccess\s*\(/;
const DIRECT_MUTATION_GATE_HELPERS = new Set([
  "canMutateHive",
  "requireSystemOwner",
  "ensureCanMutateHive",
  "requireHiveMutationAccess",
]);
// These route-local wrappers are approved only when the final call argument
// explicitly selects their mutation branch.
const SCOPED_MUTATION_MODE_HELPERS = new Set(["authorizeHive", "authorizeHiveRequest", "resolveHiveAccess"]);
const MANUAL_HIVE_TARGET_ALLOWLIST = new Map<string, string>([
  ["src/app/api/action-policies/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/active-supervisors/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/active-tasks/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/board/sessions/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/budget-controls/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/capture-sessions/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/connector-installs/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/connector-plugins/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/connectors/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/dashboard/summary/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/deliverables/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/ea/chat/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/events/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/oauth/[slug]/start/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/outcomes/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/roles/[slug]/observability/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/roles/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/runtime-drift/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/setup-health/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/supervisor-reports/route.ts", "existing manual access check; migrate in route-hardening slices"],
  ["src/app/api/voice/sessions/latest/route.ts", "existing manual access check; migrate in route-hardening slices"],
]);
const FORBIDDEN_HIVE_TARGET_FALLBACK = /\b(activeHiveId|activeHive|getActiveHive|membershipHiveId|globalHiveId|defaultHiveId)\b/;
const ESCAPE_HATCH = /\/\/\s*hive-access-not-required\s*:(.*)$/gm;
const MUTATION_ESCAPE_HATCH = /\/\/\s*hive-mutation-not-required\s*:(.*)$/gm;

async function findRouteFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return findRouteFiles(entryPath);
      }
      return entry.isFile() && entry.name === "route.ts" ? [entryPath] : [];
    }),
  );

  return files.flat();
}

function routeHandlerSections(source: string): Array<{ method: string; source: string }> {
  const matches = Array.from(source.matchAll(ROUTE_HANDLER));
  ROUTE_HANDLER.lastIndex = 0;
  return matches.map((match, index) => ({
    method: match[1],
    source: source.slice(match.index, matches[index + 1]?.index ?? source.length),
  }));
}

function escapeHatchState(source: string, pattern = ESCAPE_HATCH): { hasValid: boolean; hasInvalid: boolean } {
  let hasValid = false;
  let hasInvalid = false;

  for (const match of source.matchAll(pattern)) {
    const reason = match[1]?.trim() ?? "";
    if (reason.length > 0) {
      hasValid = true;
    } else {
      hasInvalid = true;
    }
  }

  return { hasValid, hasInvalid };
}

function stringLiteralValue(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function calledIdentifier(node: ts.CallExpression): string | null {
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

function hasMutationModeOption(call: ts.CallExpression): boolean {
  return call.arguments.some((argument) => {
    if (!ts.isObjectLiteralExpression(argument)) return false;
    return argument.properties.some((property) => {
      if (!ts.isPropertyAssignment(property)) return false;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      return name === "mode" && stringLiteralValue(property.initializer) === "mutate";
    });
  });
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isSystemOwnerDenial(statement: ts.IfStatement): boolean {
  const condition = unwrapParentheses(statement.expression);
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const ownerCheck = unwrapParentheses(condition.operand);
  if (!ts.isPropertyAccessExpression(ownerCheck) || ownerCheck.name.text !== "isSystemOwner") return false;

  const denied = ts.isBlock(statement.thenStatement)
    ? statement.thenStatement.statements.length === 1 ? statement.thenStatement.statements[0] : undefined
    : statement.thenStatement;
  if (!denied || !ts.isReturnStatement(denied) || !denied.expression || !ts.isCallExpression(denied.expression)) return false;
  const call = denied.expression;
  if (calledIdentifier(call) !== "jsonError") return false;
  const message = stringLiteralValue(call.arguments[0])?.toLowerCase() ?? "";
  return message.includes("system owner") && message.includes("required") && call.arguments[1]?.getText() === "403";
}

function hasExplicitMutationGate(source: string): boolean {
  const sourceFile = ts.createSourceFile("route-handler.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isIfStatement(node) && isSystemOwnerDenial(node)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const helper = calledIdentifier(node);
      if (helper && DIRECT_MUTATION_GATE_HELPERS.has(helper)) {
        found = true;
        return;
      }
      if (helper === "requireStrictHiveTarget" && hasMutationModeOption(node)) {
        found = true;
        return;
      }
      if (helper && SCOPED_MUTATION_MODE_HELPERS.has(helper)) {
        const finalArgument = node.arguments.at(-1);
        if (stringLiteralValue(finalArgument) === "mutate") {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

export async function checkRouteAuth(rootDir = process.cwd()): Promise<Finding[]> {
  const apiDir = path.join(rootDir, "src", "app", "api");
  const routeFiles = await findRouteFiles(apiDir);
  const findings: Finding[] = [];

  for (const file of routeFiles) {
    const source = await readFile(file, "utf8");
    const relativeFile = path.relative(rootDir, file);
    const escapeHatch = escapeHatchState(source);
    const mutationEscapeHatch = escapeHatchState(source, MUTATION_ESCAPE_HATCH);

    if (escapeHatch.hasInvalid) {
      findings.push({
        file: relativeFile,
        message: "hive-access-not-required escape hatch must include a non-empty reason after the colon.",
      });
    }

    if (FORBIDDEN_HIVE_TARGET_FALLBACK.test(source) && !escapeHatch.hasValid) {
      findings.push({
        file: relativeFile,
        message:
          "route references an active/membership/global hive fallback; use requireStrictHiveTarget or document why this route is not hive-scoped.",
      });
    }

    if (MUTATION_ESCAPE_HATCH.test(source) && !mutationEscapeHatch.hasValid) {
      findings.push({
        file: relativeFile,
        message: "hive-mutation-not-required escape hatch must include a non-empty reason after the colon.",
      });
    }
    MUTATION_ESCAPE_HATCH.lastIndex = 0;

    for (const handler of routeHandlerSections(source)) {
      const handlerMutationEscape = escapeHatchState(handler.source, MUTATION_ESCAPE_HATCH);
      if (
        MUTATION_METHODS.has(handler.method) &&
        ACCESS_ONLY_HIVE_GATE.test(handler.source) &&
        !hasExplicitMutationGate(handler.source) &&
        !handlerMutationEscape.hasValid
      ) {
        findings.push({
          file: relativeFile,
          message:
            `${handler.method} handler uses a hive access-only gate; require explicit mutation permission via canMutateHive, requireStrictHiveTarget mode=mutate, or a stricter system-owner gate.`,
        });
      }
    }

    if (!HIVE_ID_QUERY_READ.test(source)) {
      continue;
    }

    if (source.includes(STRICT_HIVE_TARGET_HELPER) || escapeHatch.hasValid) {
      continue;
    }

    if (MANUAL_HIVE_TARGET_ALLOWLIST.has(relativeFile) && source.includes("canAccessHive")) {
      continue;
    }

    findings.push({
      file: relativeFile,
      message:
        'reads searchParams.get("hiveId") but does not use requireStrictHiveTarget, or a valid hive-access-not-required reason. Existing manual canAccessHive routes must be listed in MANUAL_HIVE_TARGET_ALLOWLIST with a migration reason.',
    });
  }

  return findings;
}

async function writeRoute(rootDir: string, routePath: string, source: string): Promise<void> {
  const file = path.join(rootDir, "src", "app", "api", routePath, "route.ts");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
}

async function runSelfTest(): Promise<void> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "check-route-auth-"));

  try {
    await writeRoute(
      rootDir,
      "missing-access",
      'export function GET(request: Request) { return new URL(request.url).searchParams.get("hiveId"); }\n',
    );
    await writeRoute(
      rootDir,
      "valid-access",
      'import { requireStrictHiveTarget } from "@/app/api/_lib/hive-target";\nexport function GET(request: Request) { return new URL(request.url).searchParams.get("hiveId") && requireStrictHiveTarget; }\n',
    );
    await writeRoute(
      rootDir,
      "read-only-access",
      'import { canAccessHive } from "@/auth/users";\nexport function GET() { return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "access-only-mutation",
      'import { canAccessHive } from "@/auth/users";\nexport function PATCH() { return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "owner-bypass-access-mutation",
      'import { canAccessHive } from "@/auth/users";\nexport function POST(user: { isSystemOwner: boolean }) { if (!user.isSystemOwner) { return canAccessHive; } }\n',
    );
    await writeRoute(
      rootDir,
      "owner-only-mutation",
      'import { canAccessHive } from "@/auth/users";\nexport function DELETE(user: { isSystemOwner: boolean }) { if (!user.isSystemOwner) return new Response(null, { status: 403 }); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "unrelated-mutate-literal",
      'import { canAccessHive } from "@/auth/users";\nexport function PUT() { const auditLabel = "mutate"; return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "unrelated-mutate-template-literal",
      'import { canAccessHive } from "@/auth/users";\nexport function PATCH() { const auditLabel = `mutate`; return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "unrelated-owner-check",
      'import { canAccessHive } from "@/auth/users";\nexport function POST(user: { isSystemOwner: boolean }) { const owner = user.isSystemOwner; return owner ? canAccessHive : canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "mutation-helper-reference-only",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nexport function DELETE() { void canMutateHive; return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "system-owner-helper-reference-only",
      'import { canAccessHive } from "@/auth/users";\nimport { requireSystemOwner } from "../_lib/auth";\nexport function PUT() { void requireSystemOwner; return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "mutation-helper-call-literal-only",
      'import { canAccessHive } from "@/auth/users";\nexport function PATCH() { const note = "canMutateHive()"; return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "system-owner-helper-call-comment-only",
      'import { canAccessHive } from "@/auth/users";\nexport function DELETE() { /* requireSystemOwner() */ return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "system-owner-denial-comment-only",
      'import { canAccessHive } from "@/auth/users";\nexport function POST() { /* if (!user.isSystemOwner) return jsonError("system owner required", 403) */ return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "read-target-with-unrelated-mutate-literal",
      'import { requireStrictHiveTarget } from "../_lib/hive-target";\nexport function POST() { const label = "mutate"; return requireStrictHiveTarget(sql, user, { kind: "query", request }); }\n',
    );
    await writeRoute(
      rootDir,
      "access-helper-with-unrelated-mutate-literal",
      'export function PATCH() { const label = "mutate"; return authorizeHiveRequest(request); }\n',
    );
    await writeRoute(
      rootDir,
      "valid-mutation",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nexport function GET() { return canAccessHive; }\nexport function PATCH() { return canMutateHive(sql, user.id, hiveId); }\n',
    );
    await writeRoute(
      rootDir,
      "valid-strict-target-mutation",
      'import { requireStrictHiveTarget } from "../_lib/hive-target";\nexport function POST() { return requireStrictHiveTarget(\n  sql,\n  user,\n  { kind: "query", request },\n  { label: "hiveId", mode: "mutate" },\n); }\n',
    );
    await writeRoute(
      rootDir,
      "valid-system-owner-helper",
      'import { canAccessHive } from "@/auth/users";\nimport { requireSystemOwner } from "../_lib/auth";\nexport function DELETE() { const authz = requireSystemOwner(); return authz ?? canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-system-owner-denial",
      'import { canAccessHive } from "@/auth/users";\nexport function DELETE(user: { isSystemOwner: boolean }) { if (!user.isSystemOwner) return jsonError("Forbidden: system owner role required", 403); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-approved-mutation-helpers",
      'import { canAccessHive } from "@/auth/users";\nexport function POST() { ensureCanMutateHive(user, hiveId); return canAccessHive; }\nexport function PUT() { requireHiveMutationAccess(user, hiveId); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-scoped-mutation-mode-helpers",
      'export function POST() { return authorizeHive(user, hiveId, "mutate"); }\nexport function PATCH() { return authorizeHiveRequest(request, "mutate"); }\nexport function DELETE() { return resolveHiveAccess(params, "mutate"); }\n',
    );
    await writeRoute(
      rootDir,
      "read-only-post",
      'import { canAccessHive } from "@/auth/users";\nexport function POST() { // hive-mutation-not-required: POST returns a read-only export\nreturn canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "get-exception-does-not-cover-patch",
      'import { canAccessHive } from "@/auth/users";\nexport function GET() { // hive-mutation-not-required: read-only handler\nreturn canAccessHive; }\nexport function PATCH() { return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "post-exception-does-not-cover-delete",
      'import { canAccessHive } from "@/auth/users";\nexport function POST() { // hive-mutation-not-required: read-only export alias\nreturn canAccessHive; }\nexport function DELETE() { return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "legacy-manual-access",
      'import { canAccessHive } from "@/auth/users";\nexport function GET(request: Request) { return new URL(request.url).searchParams.get("hiveId") && canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-escape",
      '// hive-access-not-required: endpoint is system-owned metadata\nexport function GET(request: Request) { return new URL(request.url).searchParams.get(\'hiveId\'); }\n',
    );
    await writeRoute(
      rootDir,
      "fallback-active-hive",
      "export function GET() { const hiveId = activeHiveId; return Response.json({ hiveId }); }\n",
    );
    await writeRoute(
      rootDir,
      "empty-escape",
      "// hive-access-not-required:   \nexport function GET() { return Response.json({ ok: true }); }\n",
    );

    const findings = await checkRouteAuth(rootDir);
    const files = new Set(findings.map((finding) => finding.file));
    const expected = [
      "src/app/api/missing-access/route.ts",
      "src/app/api/legacy-manual-access/route.ts",
      "src/app/api/fallback-active-hive/route.ts",
      "src/app/api/empty-escape/route.ts",
      "src/app/api/access-only-mutation/route.ts",
      "src/app/api/owner-bypass-access-mutation/route.ts",
      "src/app/api/owner-only-mutation/route.ts",
      "src/app/api/unrelated-mutate-literal/route.ts",
      "src/app/api/unrelated-mutate-template-literal/route.ts",
      "src/app/api/unrelated-owner-check/route.ts",
      "src/app/api/mutation-helper-reference-only/route.ts",
      "src/app/api/system-owner-helper-reference-only/route.ts",
      "src/app/api/mutation-helper-call-literal-only/route.ts",
      "src/app/api/system-owner-helper-call-comment-only/route.ts",
      "src/app/api/system-owner-denial-comment-only/route.ts",
      "src/app/api/read-target-with-unrelated-mutate-literal/route.ts",
      "src/app/api/access-helper-with-unrelated-mutate-literal/route.ts",
      "src/app/api/get-exception-does-not-cover-patch/route.ts",
      "src/app/api/post-exception-does-not-cover-delete/route.ts",
    ];

    for (const file of expected) {
      if (!files.has(file)) {
        throw new Error(`self-test expected finding for ${file}`);
      }
    }

    if (
      files.has("src/app/api/valid-access/route.ts") ||
      files.has("src/app/api/valid-escape/route.ts") ||
      files.has("src/app/api/read-only-access/route.ts") ||
      files.has("src/app/api/read-only-post/route.ts") ||
      files.has("src/app/api/valid-mutation/route.ts") ||
      files.has("src/app/api/valid-strict-target-mutation/route.ts") ||
      files.has("src/app/api/valid-system-owner-helper/route.ts") ||
      files.has("src/app/api/valid-system-owner-denial/route.ts") ||
      files.has("src/app/api/valid-approved-mutation-helpers/route.ts") ||
      files.has("src/app/api/valid-scoped-mutation-mode-helpers/route.ts")
    ) {
      throw new Error("self-test produced a false positive for a valid route");
    }

    console.log("check-route-auth self-test passed");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }

  const findings = await checkRouteAuth();

  if (findings.length === 0) {
    console.log("check-route-auth passed");
    return;
  }

  console.error("check-route-auth failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.message}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
