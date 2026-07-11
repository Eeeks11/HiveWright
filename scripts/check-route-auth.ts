import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as ts from "typescript";

type Finding = {
  file: string;
  message: string;
};

type AuthBindings = {
  accessFunctions: Set<string>;
  authNamespaces: Set<string>;
  mutationFunctions: Set<string>;
  mutationAuthorizers: Set<string>;
  strictTargetFunctions: Set<string>;
  strictTargetNamespaces: Set<string>;
  systemOwnerFunctions: Set<string>;
};

type HandlerAuthAnalysis = {
  hasAccessOnlyGate: boolean;
  hasDominatingMutationGate: boolean;
};

const HIVE_ID_QUERY_READ = /\bsearchParams\s*\.\s*get\s*\(\s*(['"`])hiveId\1\s*\)/;
const STRICT_HIVE_TARGET_HELPER = "requireStrictHiveTarget";
const ROUTE_HANDLER = /export\s+(?:async\s+)?function\s+(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\b/g;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SIDE_EFFECTING_CALL_NAME = /(?:mutate|insert|update|delete|create|upsert|set|save|send|enqueue|publish|write|append|remove|start|stop|schedule|trigger|resolve|approve|reject|subscribe|unsubscribe|dispatch|execute|complete|archive|cancel)/i;
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

  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const reason = match[1]?.trim() ?? "";
    if (reason.length > 0) {
      hasValid = true;
    } else {
      hasInvalid = true;
    }
  }
  pattern.lastIndex = 0;

  return { hasValid, hasInvalid };
}

function parseRouteSource(source: string): ts.SourceFile {
  return ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function createBindings(): AuthBindings {
  return {
    accessFunctions: new Set(),
    authNamespaces: new Set(),
    mutationFunctions: new Set(),
    mutationAuthorizers: new Set(),
    strictTargetFunctions: new Set(),
    strictTargetNamespaces: new Set(),
    systemOwnerFunctions: new Set(),
  };
}

function importedName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) ? name.text : null;
}

function moduleSpecifierText(moduleSpecifier: ts.Expression): string {
  return ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : "";
}

function isAuthUsersModule(specifier: string): boolean {
  return specifier === "@/auth/users" || specifier.endsWith("/auth/users");
}

function isHiveTargetModule(specifier: string): boolean {
  return specifier.endsWith("/_lib/hive-target") || specifier.endsWith("../_lib/hive-target") || specifier === "@/app/api/_lib/hive-target";
}

function isApiAuthModule(specifier: string): boolean {
  return specifier.endsWith("/_lib/auth") || specifier.endsWith("../_lib/auth") || specifier === "@/app/api/_lib/auth";
}

function collectImportBindings(sourceFile: ts.SourceFile): AuthBindings {
  const bindings = createBindings();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const specifier = moduleSpecifierText(statement.moduleSpecifier);
    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) continue;

    if (ts.isNamespaceImport(namedBindings)) {
      if (isAuthUsersModule(specifier)) {
        bindings.authNamespaces.add(namedBindings.name.text);
      }
      if (isHiveTargetModule(specifier)) {
        bindings.strictTargetNamespaces.add(namedBindings.name.text);
      }
      continue;
    }

    if (!ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      const sourceName = importedName(element.propertyName ?? element.name);
      const localName = element.name.text;
      if (!sourceName) continue;

      if (isAuthUsersModule(specifier)) {
        if (sourceName === "canAccessHive") bindings.accessFunctions.add(localName);
        if (["canMutateHive", "ensureCanMutateHive", "requireHiveMutationAccess"].includes(sourceName)) {
          bindings.mutationFunctions.add(localName);
        }
      }

      if (isHiveTargetModule(specifier)) {
        if (sourceName === "requireStrictHiveTarget" || sourceName === "requireHiveAccess") {
          bindings.strictTargetFunctions.add(localName);
        }
      }

      if (isApiAuthModule(specifier) && sourceName === "requireSystemOwner") {
        bindings.systemOwnerFunctions.add(localName);
      }
    }
  }

  return bindings;
}

function callExpressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isNamespaceMemberCall(expression: ts.Expression, namespaces: Set<string>, memberNames: string[]): boolean {
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && namespaces.has(expression.expression.text)
    && memberNames.includes(expression.name.text);
}

function callHasMutateArgument(node: ts.CallExpression): boolean {
  return node.arguments.some((argument) => {
    if (ts.isStringLiteralLike(argument)) return argument.text === "mutate";
    if (ts.isObjectLiteralExpression(argument)) {
      return argument.properties.some((property) => {
        if (!ts.isPropertyAssignment(property)) return false;
        const name = property.name;
        const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
        return key === "mode" && ts.isStringLiteralLike(property.initializer) && property.initializer.text === "mutate";
      });
    }
    return false;
  });
}

function isImportedMutationCall(node: ts.CallExpression, bindings: AuthBindings): boolean {
  const callee = callExpressionName(node.expression);
  if (callee && bindings.mutationFunctions.has(callee)) return true;
  return isNamespaceMemberCall(node.expression, bindings.authNamespaces, [
    "canMutateHive",
    "ensureCanMutateHive",
    "requireHiveMutationAccess",
  ]);
}

function isStrictTargetCall(node: ts.CallExpression, bindings: AuthBindings): boolean {
  const callee = callExpressionName(node.expression);
  if (callee && bindings.strictTargetFunctions.has(callee)) return true;
  return isNamespaceMemberCall(node.expression, bindings.strictTargetNamespaces, ["requireStrictHiveTarget", "requireHiveAccess"]);
}

function isMutationAuthorizerCall(node: ts.CallExpression, bindings: AuthBindings): boolean {
  const callee = callExpressionName(node.expression);
  if (callee && bindings.mutationAuthorizers.has(callee) && callHasMutateArgument(node)) return true;
  return isStrictTargetCall(node, bindings) && callHasMutateArgument(node);
}

function isAccessOnlyGateCall(node: ts.CallExpression, bindings: AuthBindings): boolean {
  const callee = callExpressionName(node.expression);
  if (callee && bindings.accessFunctions.has(callee)) return true;
  if (isNamespaceMemberCall(node.expression, bindings.authNamespaces, ["canAccessHive"])) return true;
  if (isStrictTargetCall(node, bindings) && !callHasMutateArgument(node)) return true;
  return callee !== null && bindings.mutationAuthorizers.has(callee) && !callHasMutateArgument(node);
}

function isSystemOwnerHelperCall(node: ts.CallExpression, bindings: AuthBindings): boolean {
  const callee = callExpressionName(node.expression);
  return callee !== null && bindings.systemOwnerFunctions.has(callee);
}

function expressionIsFalse(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.FalseKeyword;
}

function returnsForbiddenResponse(statement: ts.Statement): boolean {
  const text = statement.getText();
  return /\breturn\b/.test(text) && /\b(?:jsonError|new\s+Response|Response\.json)\b/.test(text) && /\b403\b/.test(text);
}

function isSystemOwnerDenial(statement: ts.IfStatement): boolean {
  const expression = statement.expression.getText();
  if (!/!\s*[^\s()]+\.isSystemOwner/.test(expression) && !/[^\s()]+\.isSystemOwner\s*===\s*false/.test(expression)) {
    return false;
  }

  const thenStatement = statement.thenStatement;
  if (returnsForbiddenResponse(thenStatement)) return true;
  if (ts.isBlock(thenStatement)) {
    return thenStatement.statements.some((child) => returnsForbiddenResponse(child));
  }
  return false;
}

function isSideEffectCall(node: ts.CallExpression, bindings: AuthBindings): boolean {
  if (
    isImportedMutationCall(node, bindings) ||
    isMutationAuthorizerCall(node, bindings) ||
    isAccessOnlyGateCall(node, bindings) ||
    isSystemOwnerHelperCall(node, bindings)
  ) {
    return false;
  }

  const name = callExpressionName(node.expression);
  return name !== null && SIDE_EFFECTING_CALL_NAME.test(name);
}

function unionSet(first: Set<string>, second: Set<string>): Set<string> {
  return new Set([...Array.from(first), ...Array.from(second)]);
}

function mergeBindings(base: AuthBindings, extra: AuthBindings): AuthBindings {
  return {
    accessFunctions: unionSet(base.accessFunctions, extra.accessFunctions),
    authNamespaces: unionSet(base.authNamespaces, extra.authNamespaces),
    mutationFunctions: unionSet(base.mutationFunctions, extra.mutationFunctions),
    mutationAuthorizers: unionSet(base.mutationAuthorizers, extra.mutationAuthorizers),
    strictTargetFunctions: unionSet(base.strictTargetFunctions, extra.strictTargetFunctions),
    strictTargetNamespaces: unionSet(base.strictTargetNamespaces, extra.strictTargetNamespaces),
    systemOwnerFunctions: unionSet(base.systemOwnerFunctions, extra.systemOwnerFunctions),
  };
}

function functionContainsImportedMutationGate(node: ts.FunctionLikeDeclaration, bindings: AuthBindings): boolean {
  if (!node.body) return false;
  let found = false;

  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child) && (isImportedMutationCall(child, bindings) || isMutationAuthorizerCall(child, bindings))) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };

  visit(node.body);
  return found;
}

function collectLocalMutationAuthorizers(sourceFile: ts.SourceFile, importedBindings: AuthBindings): AuthBindings {
  const localBindings = createBindings();

  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    if (!functionContainsImportedMutationGate(statement, importedBindings)) continue;
    if (/mutat(?:e|ion)/i.test(statement.name.text)) {
      localBindings.mutationFunctions.add(statement.name.text);
    } else {
      localBindings.mutationAuthorizers.add(statement.name.text);
    }
  }

  return localBindings;
}

function analyzeHandlerMutationAuth(handlerSource: string, bindings: AuthBindings): HandlerAuthAnalysis {
  const sourceFile = parseRouteSource(handlerSource);
  let hasAccessOnlyGate = false;
  let hasMutationGateBeforeSideEffect = false;
  let sawSideEffectBeforeMutationGate = false;

  const visit = (node: ts.Node, reachable = true): void => {
    if (!reachable) return;

    if (ts.isIfStatement(node)) {
      if (isSystemOwnerDenial(node)) {
        hasMutationGateBeforeSideEffect ||= !sawSideEffectBeforeMutationGate;
      }

      visit(node.thenStatement, !expressionIsFalse(node.expression));
      if (node.elseStatement) visit(node.elseStatement, true);
      return;
    }

    if (ts.isCallExpression(node)) {
      if (isAccessOnlyGateCall(node, bindings)) {
        hasAccessOnlyGate = true;
      }

      if (isImportedMutationCall(node, bindings) || isMutationAuthorizerCall(node, bindings) || isSystemOwnerHelperCall(node, bindings)) {
        hasMutationGateBeforeSideEffect ||= !sawSideEffectBeforeMutationGate;
      } else if (isSideEffectCall(node, bindings)) {
        sawSideEffectBeforeMutationGate ||= !hasMutationGateBeforeSideEffect;
      }
    }

    ts.forEachChild(node, (child) => visit(child, reachable));
  };

  visit(sourceFile);

  return {
    hasAccessOnlyGate,
    hasDominatingMutationGate: hasMutationGateBeforeSideEffect,
  };
}

export async function checkRouteAuth(rootDir = process.cwd()): Promise<Finding[]> {
  const apiDir = path.join(rootDir, "src", "app", "api");
  const routeFiles = await findRouteFiles(apiDir);
  const findings: Finding[] = [];

  for (const file of routeFiles) {
    const source = await readFile(file, "utf8");
    const sourceFile = parseRouteSource(source);
    const importedBindings = collectImportBindings(sourceFile);
    const bindings = mergeBindings(importedBindings, collectLocalMutationAuthorizers(sourceFile, importedBindings));
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
      const handlerAuth = analyzeHandlerMutationAuth(handler.source, bindings);
      if (
        MUTATION_METHODS.has(handler.method) &&
        handlerAuth.hasAccessOnlyGate &&
        !handlerAuth.hasDominatingMutationGate &&
        !handlerMutationEscape.hasValid
      ) {
        findings.push({
          file: relativeFile,
          message:
            `${handler.method} handler uses a hive access-only gate; require imported mutation permission before side effects via canMutateHive, requireStrictHiveTarget mode=mutate, or a stricter system-owner gate.`,
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
      'import { canAccessHive } from "@/auth/users";\nexport function PATCH() { return canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "effect-before-mutation-gate",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nasync function mutateDatabase() {}\nexport async function PATCH() { await mutateDatabase(); await canMutateHive(); return canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "dead-owner-denial-before-mutation",
      'import { canAccessHive } from "@/auth/users";\nasync function mutateDatabase() {}\nexport async function POST(user: { isSystemOwner: boolean }) { if (false) { if (!user.isSystemOwner) return new Response(null, { status: 403 }); } await mutateDatabase(); return canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "shadowed-mutation-helper",
      'import { canAccessHive } from "@/auth/users";\nfunction canMutateHive() { return false; }\nexport function PATCH() { canMutateHive(); return canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "owner-bypass-access-mutation",
      'import { canAccessHive } from "@/auth/users";\nexport function POST(user: { isSystemOwner: boolean }) { if (!user.isSystemOwner) { return canAccessHive(); } }\n',
    );
    await writeRoute(
      rootDir,
      "owner-shortcut-access-mutation",
      'import { canAccessHive } from "@/auth/users";\nexport function POST(user: { isSystemOwner: boolean }) { if (!user.isSystemOwner) return canAccessHive(); return Response.json({ ok: true }); }\n',
    );
    await writeRoute(
      rootDir,
      "mutate-string-access-mutation",
      'import { canAccessHive } from "@/auth/users";\nexport function PATCH() { const label = "mutate"; return canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "owner-only-mutation",
      'import { canAccessHive } from "@/auth/users";\nexport function DELETE(user: { isSystemOwner: boolean }) { if (!user.isSystemOwner) return new Response(null, { status: 403 }); return canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "valid-mutation",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nexport function GET() { return canAccessHive(); }\nexport function PATCH() { return canMutateHive() && canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "valid-mutation-alias",
      'import { canAccessHive, canMutateHive as mayMutateHive } from "@/auth/users";\nexport function PATCH() { mayMutateHive(); return canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "valid-mutation-member",
      'import * as userAuth from "@/auth/users";\nexport function PATCH() { userAuth.canMutateHive(); return userAuth.canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "read-only-post",
      'import { canAccessHive } from "@/auth/users";\nexport function POST() { // hive-mutation-not-required: POST returns a read-only export\nreturn canAccessHive(); }\n',
    );
    await writeRoute(
      rootDir,
      "legacy-manual-access",
      'import { canAccessHive } from "@/auth/users";\nexport function GET(request: Request) { return new URL(request.url).searchParams.get("hiveId") && canAccessHive(); }\n',
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
      "src/app/api/effect-before-mutation-gate/route.ts",
      "src/app/api/dead-owner-denial-before-mutation/route.ts",
      "src/app/api/shadowed-mutation-helper/route.ts",
      "src/app/api/owner-bypass-access-mutation/route.ts",
      "src/app/api/owner-shortcut-access-mutation/route.ts",
      "src/app/api/mutate-string-access-mutation/route.ts",
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
      files.has("src/app/api/owner-only-mutation/route.ts") ||
      files.has("src/app/api/valid-mutation/route.ts") ||
      files.has("src/app/api/valid-mutation-alias/route.ts") ||
      files.has("src/app/api/valid-mutation-member/route.ts")
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
