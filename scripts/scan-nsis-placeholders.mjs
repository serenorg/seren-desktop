// ABOUTME: CI guard that scans generated NSIS template output for unresolved ${...} placeholders.
// ABOUTME: Catches regressions like #2230 where "${product_name} is running" rendered literally to users.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// Names that legitimately appear unresolved in template SOURCE files (.nsi
// shipped by tauri-bundler that uses ${VAR} as substitution placeholders).
// These are only allowed when the file is a pristine source template; if
// they appear in the OUTPUT, that's the bug. We scan the build output
// directory, not the source template, so this allowlist stays empty.
const ALLOWED_UNRESOLVED = new Set([]);

// NSIS itself uses ${SYMBOL} for !define expansion. The TEMPLATE has many of
// these intentionally — `${BUILD_DIR}`, `${ARCH}`, `${INSTALLERICON}`, etc.
// We're hunting for ones that should have been substituted by the BUNDLER
// before emitting the NSI to disk: things named like {{handlebars}} or
// snake_case_token. Tauri's substitution uses both `{{}}` and `${}` syntaxes
// historically. The screenshot in #2230 showed literal `${product_name}` —
// lowercase with underscores. That's the shape we treat as suspicious.
const SUSPECT_PATTERN = /\$\{[a-z][a-z0-9_]*\}/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && /\.(nsi|nsh)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function scan(file) {
  const text = readFileSync(file, "utf8");
  const findings = [];
  const lines = text.split(/\r?\n/);
  // Inside `!macro name param1 param2` ... `!macroend`, NSIS references the
  // declared parameters as ${param1} — lowercase tokens that are correct NSIS,
  // not missed bundler substitutions. tauri-bundler ships utils.nsh verbatim
  // with such macros (SetShortcutTarget shortcut target, ...), so declared
  // parameters must not be flagged within their macro body (#2310).
  let macroParams = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith(";")) continue;
    const macroStart = trimmed.match(/^!macro\s+\S+\s*(.*)$/i);
    if (macroStart) {
      macroParams = new Set(macroStart[1].split(/\s+/).filter(Boolean));
    } else if (/^!macroend\b/i.test(trimmed)) {
      macroParams = null;
    }
    for (const match of line.matchAll(SUSPECT_PATTERN)) {
      const token = match[0];
      if (ALLOWED_UNRESOLVED.has(token)) continue;
      if (macroParams?.has(token.slice(2, -1))) continue;
      findings.push({ line: i + 1, token, context: line.trim() });
    }
  }
  return findings;
}

const rootArg = process.argv[2];
if (!rootArg) {
  console.error("Usage: scan-nsis-placeholders.mjs <generated-nsis-dir>");
  process.exit(2);
}

try {
  statSync(rootArg);
} catch {
  console.error(`Path not found: ${rootArg}`);
  process.exit(2);
}

const files = walk(rootArg);
if (files.length === 0) {
  console.log(`No .nsi/.nsh files under ${rootArg}; nothing to scan.`);
  process.exit(0);
}

let totalFindings = 0;
for (const file of files) {
  const findings = scan(file);
  if (findings.length === 0) continue;
  totalFindings += findings.length;
  console.log(`\nUnresolved placeholders in ${file}:`);
  for (const f of findings) {
    console.log(`  line ${f.line}: ${f.token}`);
    console.log(`    ${f.context}`);
  }
}

if (totalFindings > 0) {
  console.error(
    `\nFAIL: ${totalFindings} unresolved \${lowercase_token} placeholder(s) in generated NSIS output.`,
  );
  console.error(
    "This is the regression from #2230 — Tauri's NSI template variable did not substitute, so users see the literal placeholder text in the installer UI.",
  );
  process.exit(1);
}

console.log(`OK: scanned ${files.length} NSIS file(s), no unresolved placeholders.`);
