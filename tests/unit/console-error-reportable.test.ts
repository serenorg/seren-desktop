// ABOUTME: AST invariant for #2864 — every reportable-looking console.error in
// ABOUTME: src/ must pass an Error-like arg or route through an explicit reporter.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve("src");

// Property names that are provably string/number-valued in this codebase, so a
// console.error whose only non-literal arg is `x.<member>` can never carry an
// Error instance to the capture gate.
const STRING_MEMBERS = new Set([
  "message",
  "status",
  "statusText",
  "code",
  "body",
  "reason",
  "detail",
  "text",
  "type",
  "name",
  "url",
  "path",
  "id",
]);
// Identifier names that are conventionally string-valued here. A `catch (error)`
// binding is NOT in this list, so `console.error("x", error)` stays reportable.
const STRING_IDENTS = new Set([
  "message",
  "msg",
  "reason",
  "text",
  "errorText",
  "body",
  "status",
  "statusText",
  "detail",
  "prefix",
  "errorPrefix",
  "label",
  "url",
  "path",
  "id",
  "name",
  "type",
  "code",
  "content",
  "line",
  "info",
]);

// Map a file's simple `const <name> = <init>` bindings so identifier args like
// `const event = {...}` / `const errorMessage = String(...)` are classified by
// their initializer rather than treated as opaque.
function collectConstBindings(sf: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name) &&
      !bindings.has(node.name.text)
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bindings;
}

// Could this argument expression be an Error instance at runtime? The gate in
// src/lib/support/hook.ts captures a console.error only when an arg is an Error
// (or stack-bearing object), so an all-provably-not-Error call is dropped.
function possiblyError(
  node: ts.Expression,
  bindings: Map<string, ts.Expression>,
): boolean {
  if (ts.isNewExpression(node)) {
    const name = node.expression.getText();
    return /Error$/.test(name) || name.length === 0;
  }
  if (ts.isIdentifier(node)) {
    if (STRING_IDENTS.has(node.text)) return false;
    const binding = bindings.get(node.text);
    if (binding && binding !== node) return possiblyError(binding, bindings);
    return true;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return !STRING_MEMBERS.has(node.name.text);
  }
  if (ts.isElementAccessExpression(node)) return true;
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    ts.isNumericLiteral(node)
  ) {
    return false;
  }
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return false;
  }
  if (ts.isArrayLiteralExpression(node)) return false;
  if (ts.isObjectLiteralExpression(node)) {
    // An object literal only reaches the gate if it carries a `stack`.
    return node.properties.some(
      (p) => p.name && ts.isIdentifier(p.name) && p.name.text === "stack",
    );
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText();
    if (callee === "JSON.stringify" || callee === "String") return false;
    return true;
  }
  if (ts.isParenthesizedExpression(node)) {
    return possiblyError(node.expression, bindings);
  }
  if (ts.isBinaryExpression(node)) {
    if (
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      return (
        possiblyError(node.left, bindings) ||
        possiblyError(node.right, bindings)
      );
    }
    return false; // `+` concatenation and comparisons are string/boolean
  }
  if (ts.isConditionalExpression(node)) {
    return (
      possiblyError(node.whenTrue, bindings) ||
      possiblyError(node.whenFalse, bindings)
    );
  }
  if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return possiblyError(node.expression, bindings);
  }
  if (ts.isSpreadElement(node)) return true; // ...args may contain an Error
  return true; // unknown shape: stay conservative (do not flag)
}

interface Offender {
  line: number;
  text: string;
}

function findConsoleErrorOffenders(
  source: string,
  fileName: string,
): Offender[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = collectConstBindings(sf);
  const offenders: Offender[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === "console" &&
      node.expression.name.text === "error" &&
      node.arguments.length > 0 &&
      !node.arguments.some((arg) => possiblyError(arg, bindings))
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      offenders.push({
        line: line + 1,
        text: node.getText().replace(/\s+/g, " "),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offenders;
}

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      // src/api/generated/ is regenerated from openapi/ — out of scope.
      if (entry === "generated") continue;
      yield* walkSourceFiles(full);
      continue;
    }
    if (/\.tsx?$/.test(entry)) yield full;
  }
}

describe("#2864 — console.error reportability invariant (AST)", () => {
  it("no reportable-looking console.error in src/ bypasses the support pipeline", () => {
    const supportDir = join("lib", "support");
    const offenders: string[] = [];
    for (const file of walkSourceFiles(SRC)) {
      // The support module owns the gate and the reporting helpers.
      if (file.includes(supportDir)) continue;
      for (const o of findConsoleErrorOffenders(
        readFileSync(file, "utf-8"),
        file,
      )) {
        offenders.push(`${file}:${o.line}: ${o.text}`);
      }
    }
    // Every offender is a console.error whose args are ALL provably-not-Error
    // (string/template/`.message`/plain object/JSON.stringify/String()). Route
    // reportable ones through `reportError(...)`; make benign ones `console.warn`
    // or `benignConsoleError(...)`. See src/lib/support/hook.ts.
    expect(offenders).toEqual([]);
  });

  const NON_REPORTABLE: Array<[string, string]> = [
    ["string literal", 'console.error("provider unavailable");'],
    ["template literal", "console.error(`start crashed: ${x}`);"],
    ["err.message member", 'console.error("check failed:", err.message);'],
    [
      "status + body strings",
      'console.error("http:", response.status, errorText);',
    ],
    ["plain object payload", 'console.error("stream:", { status: s, body: b });'],
    ["JSON.stringify", 'console.error("no text:", JSON.stringify(result));'],
    ["String() call", 'console.error("t:", String(e));'],
    [
      "string const via ternary",
      'const m = e instanceof Error ? e.message : String(e); console.error("t", m);',
    ],
    [
      "object const binding",
      'const event = { balance, error }; console.error("[AutoTopUp]", type, event);',
    ],
  ];

  it.each(NON_REPORTABLE)("flags a non-reportable %s", (_label, snippet) => {
    expect(findConsoleErrorOffenders(snippet, "fixture.ts")).toHaveLength(1);
  });

  const REPORTABLE: Array<[string, string]> = [
    ["new Error()", 'console.error(new Error("boom"));'],
    ["caught error identifier", 'console.error("failed:", error);'],
    ["caught err identifier", 'console.error("failed:", err);'],
    ["non-string member access", 'console.error("x", event.data.error);'],
    ["?? fallback to new Error", 'console.error("x", cause ?? new Error("z"));'],
    ["Error const binding", 'const e2 = new Error("y"); console.error("t", e2);'],
  ];

  it.each(REPORTABLE)("does not flag a reportable %s", (_label, snippet) => {
    expect(findConsoleErrorOffenders(snippet, "fixture.ts")).toHaveLength(0);
  });

  const IGNORED: Array<[string, string]> = [
    ["reportError helper", 'reportError("kind", "message");'],
    ["benignConsoleError helper", 'benignConsoleError("reason", "message", err);'],
    ["console.warn", 'console.warn("benign");'],
    // A Tauri LogLevel.Error replayed by attachConsole() arrives as a runtime
    // console.error(string) — NOT a source call, so it is neither scanned nor a
    // report source. The native runtime bridge owns those; see support.rs.
    ["console.info", 'console.info("note");'],
  ];

  it.each(IGNORED)("ignores %s (not a source console.error)", (_label, snippet) => {
    expect(findConsoleErrorOffenders(snippet, "fixture.ts")).toHaveLength(0);
  });
});
