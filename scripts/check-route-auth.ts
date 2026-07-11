import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

type Finding = {
  file: string;
  message: string;
};

const HIVE_ID_QUERY_READ = /\bsearchParams\s*\.\s*get\s*\(\s*(['"`])hiveId\1\s*\)/;
const STRICT_HIVE_TARGET_HELPER = "requireStrictHiveTarget";
const HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_USERS_MODULE = "@/auth/users";
const MUTATION_HELPER_EXPORTS = new Set(["canMutateHive"]);
const ACCESS_HELPER_EXPORTS = new Set(["canAccessHive"]);
const LOCAL_AUTH_WRAPPER_NAMES = new Set([
  "authorizeHive",
  "authorizeHiveRequest",
  "resolveHiveAccess",
  "requireHiveMutationAccess",
  "ensureCanMutateHive",
]);
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
  while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) current = current.expression;
  return current;
}

type Handler = { method: string; node: ts.FunctionLikeDeclaration; body: ts.ConciseBody };
type TrustedCallKind = "allow-boolean" | "success-object" | "denial-value" | "throwing";
type Binding = { exported: string; namespace: boolean; moduleName: string };
type AnalysisContext = {
  sourceFile: ts.SourceFile;
  imports: Map<string, Binding>;
  invalidBindings: Set<string>;
  localWrappers: Map<string, { kind: TrustedCallKind; requiresMutationMode: boolean }>;
};
type FlowState = {
  authorized: boolean;
  terminated: boolean;
  sawGate: boolean;
  violation: boolean;
  pending: Map<string, TrustedCallKind>;
};

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function functionBody(node: ts.Node | undefined): ts.ConciseBody | null {
  return node && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.body
    ? node.body
    : null;
}

function exportedHandlers(sourceFile: ts.SourceFile): Handler[] {
  const declarations = new Map<string, ts.FunctionLikeDeclaration>();
  const handlers: Handler[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      declarations.set(statement.name.text, statement);
      if (hasExportModifier(statement) && HTTP_METHODS.has(statement.name.text)) {
        handlers.push({ method: statement.name.text, node: statement, body: statement.body });
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const body = functionBody(declaration.initializer);
        if (!body) continue;
        declarations.set(declaration.name.text, declaration.initializer as ts.FunctionLikeDeclaration);
        if (hasExportModifier(statement) && HTTP_METHODS.has(declaration.name.text)) {
          handlers.push({ method: declaration.name.text, node: declaration.initializer as ts.FunctionLikeDeclaration, body });
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const method = element.name.text;
      const localName = element.propertyName?.text ?? method;
      const declaration = declarations.get(localName);
      const body = functionBody(declaration);
      if (HTTP_METHODS.has(method) && declaration && body) handlers.push({ method, node: declaration, body });
    }
  }

  return handlers;
}

function approvedImport(moduleName: string, exported: string): boolean {
  if (moduleName === AUTH_USERS_MODULE) return MUTATION_HELPER_EXPORTS.has(exported) || ACCESS_HELPER_EXPORTS.has(exported);
  if (moduleName.endsWith("/_lib/hive-target")) return exported === "requireStrictHiveTarget";
  if (moduleName.endsWith("/_lib/auth")) return exported === "requireSystemOwner";
  return false;
}

function importedBindings(sourceFile: ts.SourceFile): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause?.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      if ([AUTH_USERS_MODULE].includes(moduleName) || moduleName.endsWith("/_lib/hive-target") || moduleName.endsWith("/_lib/auth")) {
        bindings.set(clause.namedBindings.name.text, { exported: moduleName, namespace: true, moduleName });
      }
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      const approvedCaptureHelper = moduleName === "./_shared" && exported === "ensureCanMutateHive" &&
        sourceFile.fileName.replaceAll("\\", "/").endsWith("/src/app/api/capture-sessions/route.ts");
      if (approvedImport(moduleName, exported) || approvedCaptureHelper) {
        bindings.set(element.name.text, { exported, namespace: false, moduleName });
      }
    }
  }
  return bindings;
}

function invalidatedBindings(sourceFile: ts.SourceFile, imports: Map<string, Binding>): Set<string> {
  const invalid = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const target = unwrapParentheses(node.left);
      if (ts.isIdentifier(target) && imports.has(target.text)) invalid.add(target.text);
      if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && imports.get(target.expression.text)?.namespace) {
        invalid.add(target.expression.text);
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand) && imports.has(node.operand.text)) {
      invalid.add(node.operand.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return invalid;
}

function declarationShadows(node: ts.Node, name: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current) && current.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)) return true;
    if (ts.isBlock(current)) {
      for (const statement of current.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return true;
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function trustedImportedCall(call: ts.CallExpression, context: AnalysisContext): { exported: string; kind: TrustedCallKind } | null {
  const expression = unwrapParentheses(call.expression);
  if (ts.isIdentifier(expression)) {
    const binding = context.imports.get(expression.text);
    if (!binding || binding.namespace || context.invalidBindings.has(expression.text) || declarationShadows(call, expression.text)) return null;
    if (binding.exported === "canMutateHive") return { exported: binding.exported, kind: "allow-boolean" };
    if (binding.exported === "requireStrictHiveTarget" && hasMutationModeOption(call)) return { exported: binding.exported, kind: "success-object" };
    if (binding.exported === "requireSystemOwner") return { exported: binding.exported, kind: "success-object" };
    if (binding.exported === "ensureCanMutateHive" && binding.moduleName === "./_shared") return { exported: binding.exported, kind: "denial-value" };
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const namespaceName = expression.expression.text;
    const binding = context.imports.get(namespaceName);
    if (!binding?.namespace || context.invalidBindings.has(namespaceName) || declarationShadows(call, namespaceName)) return null;
    const exported = expression.name.text;
    if (!approvedImport(binding.exported, exported)) return null;
    if (exported === "canMutateHive") return { exported, kind: "allow-boolean" };
    if (exported === "requireStrictHiveTarget" && hasMutationModeOption(call)) return { exported, kind: "success-object" };
    if (exported === "requireSystemOwner") return { exported, kind: "success-object" };
  }
  return null;
}

function hasImportedHelper(node: ts.Node, context: AnalysisContext, exports: Set<string>): boolean {
  let found = false;
  function visit(child: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(child)) {
      const binding = context.imports.get(child.text);
      if (binding && !binding.namespace && !context.invalidBindings.has(child.text) && exports.has(binding.exported) && !declarationShadows(child, child.text)) found = true;
    } else if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression)) {
      const binding = context.imports.get(child.expression.text);
      if (binding?.namespace && !context.invalidBindings.has(child.expression.text) && exports.has(child.name.text)) found = true;
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function usesHiveAccessAuthorization(node: ts.Node, context: AnalysisContext): boolean {
  if (hasImportedHelper(node, context, ACCESS_HELPER_EXPORTS)) return true;
  let found = false;
  function visit(child: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const expression = unwrapParentheses(child.expression);
      if (ts.isIdentifier(expression)) {
        const binding = context.imports.get(expression.text);
        if (binding?.exported === "requireStrictHiveTarget" || LOCAL_AUTH_WRAPPER_NAMES.has(expression.text)) found = true;
      } else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
        const binding = context.imports.get(expression.expression.text);
        if (binding?.namespace && expression.name.text === "requireStrictHiveTarget" && !context.invalidBindings.has(expression.expression.text)) found = true;
      }
    }
    if (!found) ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function trustedCall(call: ts.CallExpression, context: AnalysisContext): TrustedCallKind | null {
  const imported = trustedImportedCall(call, context);
  if (imported) return imported.kind;
  const expression = unwrapParentheses(call.expression);
  if (!ts.isIdentifier(expression)) return null;
  const wrapper = context.localWrappers.get(expression.text);
  if (!wrapper || declarationShadows(call, expression.text)) return null;
  if (wrapper.requiresMutationMode && stringLiteralValue(call.arguments.at(-1)) !== "mutate") return null;
  return wrapper.kind;
}

function callWithin(expression: ts.Node, context: AnalysisContext): { call: ts.CallExpression; kind: TrustedCallKind } | null {
  let result: { call: ts.CallExpression; kind: TrustedCallKind } | null = null;
  function visit(node: ts.Node): void {
    if (result) return;
    if (ts.isCallExpression(node)) {
      const kind = trustedCall(node, context);
      if (kind) {
        result = { call: node, kind };
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
  return result;
}

function localAuthWrappers(sourceFile: ts.SourceFile, baseContext: AnalysisContext): AnalysisContext["localWrappers"] {
  const wrappers: AnalysisContext["localWrappers"] = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || !LOCAL_AUTH_WRAPPER_NAMES.has(statement.name.text)) continue;
    if (baseContext.invalidBindings.has(statement.name.text)) continue;
    const hasMutation = Boolean(callWithin(statement.body, baseContext));
    if (!hasMutation) continue;
    const hasAccess = hasImportedHelper(statement.body, baseContext, ACCESS_HELPER_EXPORTS);
    let hasThrow = false;
    let returnsMutationCall = false;
    function inspect(node: ts.Node): void {
      if (ts.isThrowStatement(node)) hasThrow = true;
      if (ts.isReturnStatement(node) && node.expression && callWithin(node.expression, baseContext)) returnsMutationCall = true;
      ts.forEachChild(node, inspect);
    }
    inspect(statement.body);
    const kind: TrustedCallKind = statement.name.text === "requireHiveMutationAccess"
      ? "denial-value"
      : statement.name.text === "ensureCanMutateHive"
        ? hasThrow ? "throwing" : returnsMutationCall ? "allow-boolean" : "denial-value"
        : "success-object";
    wrappers.set(statement.name.text, { kind, requiresMutationMode: hasAccess });
  }
  return wrappers;
}

function commentEscapeHatchState(sourceFile: ts.SourceFile, node: ts.Node): { hasValid: boolean; hasInvalid: boolean } {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sourceFile.text);
  let hasValid = false;
  let hasInvalid = false;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const start = scanner.getTokenPos();
    if (start < node.getStart(sourceFile) || scanner.getTextPos() > node.end) continue;
    const match = /(?:hive-mutation-not-required|route-auth-exception)\s*:([\s\S]*?)(?:\*\/)?$/.exec(scanner.getTokenText());
    if (!match) continue;
    if (match[1].trim()) hasValid = true;
    else hasInvalid = true;
  }
  return { hasValid, hasInvalid };
}

function statementTerminates(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.length > 0 && statementTerminates(statement.statements.at(-1)!);
}

function isOwnerNegation(expression: ts.Expression): boolean {
  const condition = unwrapParentheses(expression);
  return ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPropertyAccessExpression(unwrapParentheses(condition.operand)) &&
    (unwrapParentheses(condition.operand) as ts.PropertyAccessExpression).name.text === "isSystemOwner";
}

function isSystemOwnerDenial(statement: ts.IfStatement): boolean {
  if (!isOwnerNegation(statement.expression) || !statementTerminates(statement.thenStatement)) return false;
  const denied = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements.at(-1) : statement.thenStatement;
  if (!denied || !ts.isReturnStatement(denied) || !denied.expression || !ts.isCallExpression(denied.expression)) return false;
  const message = denied.expression.arguments
    .map((argument) => stringLiteralValue(argument)?.toLowerCase() ?? "")
    .find((value) => value.includes("system owner") && value.includes("required"));
  const hasForbiddenStatus = denied.expression.arguments.some((argument) => argument.getText() === "403" ||
    (ts.isObjectLiteralExpression(argument) && argument.properties.some((property) =>
      ts.isPropertyAssignment(property) && property.name.getText() === "status" && property.initializer.getText() === "403")));
  return Boolean(message) && hasForbiddenStatus;
}

function referencedPending(expression: ts.Expression, pending: Map<string, TrustedCallKind>): { name: string; kind: TrustedCallKind } | null {
  let result: { name: string; kind: TrustedCallKind } | null = null;
  function visit(node: ts.Node): void {
    if (!result && ts.isIdentifier(node) && pending.has(node.text)) result = { name: node.text, kind: pending.get(node.text)! };
    if (!result) ts.forEachChild(node, visit);
  }
  visit(expression);
  return result;
}

function conditionDeniesUnauthorized(expression: ts.Expression, kind: TrustedCallKind): boolean {
  const condition = unwrapParentheses(expression);
  if (kind === "allow-boolean") {
    return ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken;
  }
  if (kind === "denial-value") return !ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken;
  if (kind === "success-object") {
    return (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) ||
      ts.isBinaryExpression(condition) || ts.isPropertyAccessExpression(condition);
  }
  return false;
}

// Before authorization, permit identity/authorization extraction, request URL/body
// parsing, validation/normalization, read-only lookup helpers, and response/logging
// construction. SQL tags are separately limited to non-mutation statements. All
// other calls are conservatively treated as potentially side effecting; unusual
// control flow needs a handler-local `route-auth-exception: <reason>` comment.
const PRE_GATE_SAFE_CALL_NAME = /^(?:parse|normalize|validate|clean|string|boolean|number|positive|negative|nonNegative|recordValue|safe|is|has|to|optional|require|assert|read|load|find|list|get|json|formData|text|arrayBuffer|blob|trim|filter|map|includes|test|catch|log|warn|error)/i;

function isImportedAccessCall(call: ts.CallExpression, context: AnalysisContext): boolean {
  const expression = unwrapParentheses(call.expression);
  if (ts.isIdentifier(expression)) {
    const binding = context.imports.get(expression.text);
    return Boolean(binding && !binding.namespace && ACCESS_HELPER_EXPORTS.has(binding.exported) &&
      !context.invalidBindings.has(expression.text) && !declarationShadows(call, expression.text));
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const binding = context.imports.get(expression.expression.text);
    return Boolean(binding?.namespace && ACCESS_HELPER_EXPORTS.has(expression.name.text) && !context.invalidBindings.has(expression.expression.text));
  }
  return false;
}

function potentiallySideEffecting(node: ts.Node, context: AnalysisContext): boolean {
  let found = false;
  function visit(child: ts.Node): void {
    if (found || (child !== node && ts.isFunctionLike(child))) return;
    if (ts.isTaggedTemplateExpression(child)) {
      const sqlText = child.template.getText().replace(/^`|`$/g, "").trim();
      if (/\b(?:insert\s+into|update\s+[a-z_]|delete\s+from|merge\s+into|create\s+(?:table|index)|alter\s+table|drop\s+|truncate\s+)/i.test(sqlText)) found = true;
    } else if (ts.isCallExpression(child)) {
      if (trustedCall(child, context)) return;
      if (isImportedAccessCall(child, context)) return;
      const called = ts.isIdentifier(child.expression)
        ? child.expression.text
        : ts.isPropertyAccessExpression(child.expression) ? child.expression.name.text : "";
      if (!PRE_GATE_SAFE_CALL_NAME.test(called)) found = true;
    } else if (ts.isNewExpression(child) && !ts.isIdentifier(child.expression)) {
      found = true;
    } else if (ts.isBinaryExpression(child) && isAssignmentOperator(child.operatorToken.kind) && ts.isPropertyAccessExpression(child.left)) {
      found = true;
    }
    if (!found) ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function initialFlow(): FlowState {
  return { authorized: false, terminated: false, sawGate: false, violation: false, pending: new Map() };
}

function analyzeStatements(statements: readonly ts.Statement[], context: AnalysisContext, incoming: FlowState): FlowState {
  let state: FlowState = { ...incoming, pending: new Map(incoming.pending) };
  for (const statement of statements) {
    if (state.terminated) break;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      if (statement.expression && callWithin(statement.expression, context)) state.sawGate = true;
      state.terminated = true;
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const gate = callWithin(declaration.initializer, context);
        if (gate) {
          state.sawGate = true;
          state.pending.set(declaration.name.text, gate.kind);
        }
      }
      if (!state.authorized && potentiallySideEffecting(statement, context)) state.violation = true;
      continue;
    }
    if (ts.isIfStatement(statement)) {
      if (isSystemOwnerDenial(statement)) {
        state.sawGate = true;
        state.authorized = true;
        continue;
      }
      const directGate = callWithin(statement.expression, context);
      if (directGate && statementTerminates(statement.thenStatement) && conditionDeniesUnauthorized(statement.expression, directGate.kind)) {
        state.sawGate = true;
        state.authorized = true;
        continue;
      }
      const pending = referencedPending(statement.expression, state.pending);
      if (pending && statementTerminates(statement.thenStatement) && conditionDeniesUnauthorized(statement.expression, pending.kind)) {
        state.sawGate = true;
        state.authorized = true;
        state.pending.delete(pending.name);
        continue;
      }
      const thenState = analyzeStatements(ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement], context, state);
      const elseState = statement.elseStatement
        ? analyzeStatements(ts.isBlock(statement.elseStatement) ? statement.elseStatement.statements : [statement.elseStatement], context, state)
        : { ...state, pending: new Map(state.pending) };
      const ownerBypass = isOwnerNegation(statement.expression) && (thenState.authorized || thenState.terminated);
      state = {
        authorized: ownerBypass || ((thenState.authorized || thenState.terminated) && (elseState.authorized || elseState.terminated)),
        terminated: thenState.terminated && elseState.terminated,
        sawGate: state.sawGate || thenState.sawGate || elseState.sawGate,
        violation: state.violation || thenState.violation || elseState.violation,
        pending: new Map(),
      };
      continue;
    }
    if (ts.isTryStatement(statement)) {
      const tryState = analyzeStatements(statement.tryBlock.statements, context, state);
      const catchState = statement.catchClause ? analyzeStatements(statement.catchClause.block.statements, context, state) : tryState;
      state = {
        authorized: (tryState.authorized || tryState.terminated) && (catchState.authorized || catchState.terminated),
        terminated: tryState.terminated && catchState.terminated,
        sawGate: state.sawGate || tryState.sawGate || catchState.sawGate,
        violation: state.violation || tryState.violation || catchState.violation,
        pending: new Map(),
      };
      if (statement.finallyBlock) state = analyzeStatements(statement.finallyBlock.statements, context, state);
      continue;
    }
    if (ts.isBlock(statement)) {
      state = analyzeStatements(statement.statements, context, state);
      continue;
    }
    const gate = ts.isExpressionStatement(statement) ? callWithin(statement.expression, context) : null;
    if (gate) {
      state.sawGate = true;
      if (gate.kind === "throwing") state.authorized = true;
    }
    if (!state.authorized && potentiallySideEffecting(statement, context)) state.violation = true;
  }
  return state;
}

export async function checkRouteAuth(rootDir = process.cwd()): Promise<Finding[]> {
  const apiDir = path.join(rootDir, "src", "app", "api");
  const routeFiles = await findRouteFiles(apiDir);
  const findings: Finding[] = [];

  for (const file of routeFiles) {
    const source = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const relativeFile = path.relative(rootDir, file);
    const escapeHatch = escapeHatchState(source);
    const imports = importedBindings(sourceFile);
    const context: AnalysisContext = {
      sourceFile,
      imports,
      invalidBindings: invalidatedBindings(sourceFile, imports),
      localWrappers: new Map(),
    };
    context.localWrappers = localAuthWrappers(sourceFile, context);

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

    for (const handler of exportedHandlers(sourceFile)) {
      const handlerMutationEscape = commentEscapeHatchState(sourceFile, handler.body);
      if (handlerMutationEscape.hasInvalid) {
        findings.push({
          file: relativeFile,
          message: `${handler.method} handler hive-mutation-not-required escape hatch must include a non-empty reason after the colon.`,
        });
      }
      const usesAccessOnlyGate = usesHiveAccessAuthorization(handler.body, context);
      const flow = ts.isBlock(handler.body)
        ? analyzeStatements(handler.body.statements, context, initialFlow())
        : (() => {
            const gate = callWithin(handler.body, context);
            return {
              ...initialFlow(),
              terminated: true,
              sawGate: Boolean(gate),
              violation: potentiallySideEffecting(handler.body, context) && !gate,
            };
          })();
      if (
        MUTATION_METHODS.has(handler.method) &&
        usesAccessOnlyGate &&
        (!flow.sawGate || flow.violation) &&
        !handlerMutationEscape.hasValid
      ) {
        findings.push({
          file: relativeFile,
          message:
            `${handler.method} handler uses hive access authorization without a trusted mutation gate dominating side effects; use an approved imported mutation helper in the top-level authorization prefix, or add a handler-local exception comment.`,
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
  const rootDir = await mkdtemp(path.join(process.cwd(), ".check-route-auth-"));

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
      "exported-const-access-only",
      'import { canAccessHive } from "@/auth/users";\nexport const PATCH = async () => canAccessHive;\n',
    );
    await writeRoute(
      rootDir,
      "valid-export-alias",
      'import { canAccessHive, canMutateHive as mayWrite } from "@/auth/users";\nconst handler = async () => { if (!await mayWrite(sql, user.id, hiveId)) return jsonError("denied", 403); return canAccessHive; };\nexport { handler as POST };\n',
    );
    await writeRoute(
      rootDir,
      "unreachable-owner-denial",
      'import { canAccessHive } from "@/auth/users";\nexport async function POST(user: { isSystemOwner: boolean }) { if (false) { if (!user.isSystemOwner) return jsonError("system owner required", 403); } await mutateDatabase(); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "side-effect-before-gate",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nexport async function PATCH(user: { id: string }) { await mutateDatabase(); await canMutateHive(sql, user.id, hiveId); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "shadowed-mutation-helper",
      'import { canAccessHive } from "@/auth/users";\nfunction canMutateHive() { return false; }\nexport async function DELETE() { canMutateHive(); await mutateDatabase(); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "reassigned-mutation-helper",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\ncanMutateHive = async () => true;\nexport async function DELETE() { if (!await canMutateHive(sql, user.id, hiveId)) return jsonError("denied", 403); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "conditional-gate-bypass",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nexport async function POST(flag: boolean) { if (flag) { if (!await canMutateHive(sql, user.id, hiveId)) return jsonError("denied", 403); } await mutateDatabase(); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-aliased-mutation-helper",
      'import { canAccessHive, canMutateHive as mayWrite } from "@/auth/users";\nexport async function POST(user: { id: string }) { if (!await mayWrite(sql, user.id, hiveId)) return jsonError("denied", 403); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-member-mutation-helper",
      'import * as auth from "@/auth/users";\nexport async function POST(user: { id: string }) { if (!await auth.canMutateHive(sql, user.id, hiveId)) return jsonError("denied", 403); return auth.canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-nested-authorization",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nexport async function PUT(flag: boolean) { if (flag) { if (!await canMutateHive(sql, user.id, hiveId)) return jsonError("denied", 403); } else { return jsonError("unsupported", 400); } await mutateDatabase(); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-early-return-before-authorization",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nexport async function PATCH(input: unknown) { if (!input) return jsonError("missing", 400); if (!await canMutateHive(sql, user.id, hiveId)) return jsonError("denied", 403); await mutateDatabase(); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "multi-handler-scope",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nexport async function POST() { if (!await canMutateHive(sql, user.id, hiveId)) return jsonError("denied", 403); return canAccessHive; }\nexport async function DELETE() { const note = "canMutateHive()"; /* canMutateHive() */ return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "exception-literal-does-not-bypass",
      'import { canAccessHive } from "@/auth/users";\nexport async function POST() { const note = "route-auth-exception: this is only a string"; await mutateDatabase(); return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-handler-route-auth-exception",
      'import { canAccessHive } from "@/auth/users";\nexport async function POST() { // route-auth-exception: legacy dispatcher proves mutation authorization before invoking this handler\nawait mutateDatabase(); return canAccessHive; }\nexport async function DELETE() { return canAccessHive; }\n',
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
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nasync function ensureCanMutateHive(user: any, hiveId: string) { if (!await canMutateHive(sql, user.id, hiveId)) throw new Error("denied"); }\nasync function requireHiveMutationAccess(user: any, hiveId: string) { return await canMutateHive(sql, user.id, hiveId) ? null : jsonError("denied", 403); }\nexport async function POST() { await ensureCanMutateHive(user, hiveId); return canAccessHive; }\nexport async function PUT() { const denied = await requireHiveMutationAccess(user, hiveId); if (denied) return denied; return canAccessHive; }\n',
    );
    await writeRoute(
      rootDir,
      "valid-scoped-mutation-mode-helpers",
      'import { canAccessHive, canMutateHive } from "@/auth/users";\nasync function authorizeHive(user: any, hiveId: string, mode: "access" | "mutate") { const ok = mode === "mutate" ? await canMutateHive(sql, user.id, hiveId) : await canAccessHive(sql, user.id, hiveId); return ok ? { ok: true } : { ok: false }; }\nasync function authorizeHiveRequest(request: Request, mode: "access" | "mutate") { const ok = mode === "mutate" ? await canMutateHive(sql, user.id, hiveId) : await canAccessHive(sql, user.id, hiveId); return ok ? { ok: true } : { ok: false }; }\nasync function resolveHiveAccess(params: unknown, mode: "access" | "mutate") { const ok = mode === "mutate" ? await canMutateHive(sql, user.id, hiveId) : await canAccessHive(sql, user.id, hiveId); return ok ? { ok: true } : { ok: false }; }\nexport async function POST() { const auth = await authorizeHive(user, hiveId, "mutate"); if (!auth.ok) return jsonError("denied", 403); return canAccessHive; }\nexport async function PATCH() { const auth = await authorizeHiveRequest(request, "mutate"); if (!auth.ok) return jsonError("denied", 403); return canAccessHive; }\nexport async function DELETE() { const auth = await resolveHiveAccess(params, "mutate"); if (!auth.ok) return jsonError("denied", 403); return canAccessHive; }\n',
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
      "src/app/api/unreachable-owner-denial/route.ts",
      "src/app/api/side-effect-before-gate/route.ts",
      "src/app/api/shadowed-mutation-helper/route.ts",
      "src/app/api/reassigned-mutation-helper/route.ts",
      "src/app/api/conditional-gate-bypass/route.ts",
      "src/app/api/multi-handler-scope/route.ts",
      "src/app/api/exported-const-access-only/route.ts",
      "src/app/api/exception-literal-does-not-bypass/route.ts",
      "src/app/api/valid-handler-route-auth-exception/route.ts",
    ];

    for (const file of expected) {
      if (!files.has(file)) {
        throw new Error(`self-test expected finding for ${file}`);
      }
    }

    const handlerExceptionFindings = findings.filter((finding) => finding.file === "src/app/api/valid-handler-route-auth-exception/route.ts");
    if (handlerExceptionFindings.length !== 1 || !handlerExceptionFindings[0].message.startsWith("DELETE handler")) {
      throw new Error("self-test expected the route-auth exception to cover only its POST handler");
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
      files.has("src/app/api/valid-scoped-mutation-mode-helpers/route.ts") ||
      files.has("src/app/api/valid-aliased-mutation-helper/route.ts") ||
      files.has("src/app/api/valid-member-mutation-helper/route.ts") ||
      files.has("src/app/api/valid-nested-authorization/route.ts") ||
      files.has("src/app/api/valid-early-return-before-authorization/route.ts")
      || files.has("src/app/api/valid-export-alias/route.ts")
    ) {
      throw new Error(`self-test produced a false positive for a valid route: ${Array.from(files).filter((file) => file.includes("/valid-")).join(", ")}`);
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
