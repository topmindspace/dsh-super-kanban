#!/usr/bin/env node
/**
 * Super Kanban — repository privacy scanner.
 *
 * Scans the files that would be published (git-tracked files when a repository
 * is available, otherwise a walk of the working tree that honours the local
 * ignore directories) for personal data, local machine paths, session ids and
 * credential material. Zero third-party dependencies and safe to run in CI.
 *
 * The patterns are assembled from fragments on purpose: this file must not
 * match its own rules, otherwise the scanner would always report itself.
 *
 * Usage:
 *   node scripts/check-privacy.mjs [--root=<repo>] [--list]
 *
 * Exit code 0 when clean, 1 when findings are reported, 2 on usage errors.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", ".git", "internal", "dev", "dist", "data", "out", "tmp", ".tmp", ".cache"]);
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mjs",
  ".js",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".txt",
  ".svg",
  ".sh",
  ".bash",
  ".html",
  ".css",
  ".ts",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
]);
const TEXT_BASENAMES = new Set(["LICENSE", "NOTICE", ".gitignore", ".gitattributes", ".editorconfig"]);
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/** Join fragments so forbidden literals never appear in this file's source. */
function join(...parts) {
  return parts.join("");
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/** Synthetic ids that are explicitly allowed (used by tests/fixtures). */
const ALLOWED_UUID = join("0000", "0000-0000-4000-8000-", "000000000000");

const ALLOWED_EMAIL_DOMAINS = [join("topmindspace", ".dev"), "example.com", "example.org", "users.noreply.github.com", "noreply.github.com"];

/**
 * Content rules. Each rule reports `file:line` plus a redacted snippet.
 * @type {{id: string, regex: RegExp, allow?: (value: string) => boolean}[]}
 */
export const CONTENT_RULES = [
  {
    // Absolute macOS/Linux/Windows home directories.
    id: "absolute-home-path",
    regex: new RegExp(join("/Use", "rs/", "|/ho", "me/", "|[A-Za-z]:", "\\\\", "Use", "rs", "\\\\"), "g"),
  },
  {
    // Local temporary paths, typically internal QA artifacts.
    id: "temporary-path",
    // Only internal QA artifact prefixes are forbidden; generic temp examples such
    // as `/tmp/x` in an install script are public-safe and must pass.
    regex: new RegExp(join("/tm", "p/(?:qa2?[-./]|ui[-./]|design|probe|verify|shot|dsh-(?:test|ui|demo))"), "g"),
  },
  {
    // Personal name (CJK code points, kept as escapes on purpose).
    id: "personal-name",
    regex: new RegExp(join("\\u6f58", "\\u4e01"), "g"),
  },
  {
    // Local account name of the original development machine.
    id: "known-username",
    regex: new RegExp(join("\\b", "pa", "nd", "\\b"), "gi"),
  },
  {
    // DSH session ids and bare UUIDs (real sessions are UUID-shaped).
    id: "session-id",
    regex: new RegExp(join("sess", "ion-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"), "g"),
    allow: (value) => value.toLowerCase().endsWith(ALLOWED_UUID),
  },
  {
    id: "uuid",
    regex: new RegExp(join("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"), "g"),
    allow: (value) => value.toLowerCase() === ALLOWED_UUID,
  },
  {
    id: "email-address",
    regex: new RegExp(join("[A-Za-z0-9._%+-]+@", "[A-Za-z0-9.-]+", "\\.[A-Za-z]{2,}"), "g"),
    allow: (value) => ALLOWED_EMAIL_DOMAINS.some((domain) => value.toLowerCase().endsWith(join("@", domain))),
  },
  {
    id: "github-token",
    regex: new RegExp(join("gh", "[oprsu]_[A-Za-z0-9]{20,}"), "g"),
  },
  {
    id: "github-fine-grained-token",
    regex: new RegExp(join("git", "hub_", "pat_", "[A-Za-z0-9_]{20,}"), "g"),
  },
  {
    id: "api-key",
    regex: new RegExp(join("(?:^|[^A-Za-z0-9._-])", "s", "k-[A-Za-z0-9_-]{20,}"), "g"),
    // Long kebab-case UI identifiers (`sk-settings-exclude-label`, used as
    // element ids / aria-labelledby values) are not credentials: real API keys
    // do not consist of 3+ all-lowercase word segments.
    allow: (value) => /(?:^|[^A-Za-z0-9._-])sk-(?:[a-z][a-z0-9]*-){2,}[a-z][a-z0-9]*$/u.test(value),
  },
  {
    id: "aws-access-key",
    regex: new RegExp(join("AK", "IA[0-9A-Z]{16}"), "g"),
  },
  {
    id: "slack-token",
    regex: new RegExp(join("xox", "[baprs]-[A-Za-z0-9-]{10,}"), "g"),
  },
  {
    id: "npm-token",
    regex: new RegExp(join("np", "m_[A-Za-z0-9]{36}"), "g"),
  },
  {
    id: "private-key",
    regex: new RegExp(join("-----BEGIN ", "PRIVATE KEY-----"), "g"),
  },
];

/** Path rules: credential material must not be committed at all. */
export function checkFilePath(relativePath) {
  const findings = [];
  const base = path.basename(relativePath).toLowerCase();
  if (base.startsWith(join(".cred", "entials"))) {
    findings.push({ file: relativePath, line: 0, rule: "credentials-file", snippet: "credential material must never be committed" });
  }
  if (base === join(".e", "nv") || base.startsWith(join(".e", "nv."))) {
    findings.push({ file: relativePath, line: 0, rule: "env-file", snippet: "environment files must never be committed" });
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Scanning                                                            */
/* ------------------------------------------------------------------ */

function isTextCandidate(filePath) {
  const base = path.basename(filePath);
  if (TEXT_BASENAMES.has(base)) return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let position = 0; position < index && position < text.length; position += 1) {
    if (text.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

function redactSnippet(lineText, matched) {
  const trimmed = String(lineText || "").trim();
  const safe = matched ? trimmed.split(matched).join("[redacted]") : trimmed;
  return safe.length > 120 ? `${safe.slice(0, 117)}...` : safe;
}

/**
 * Scan one text blob. Exported so tests can exercise the rules without writing
 * forbidden strings to disk.
 * @param {string} text
 * @param {{file?: string}} [options]
 * @returns {{file: string, line: number, rule: string, snippet: string}[]}
 */
export function scanText(text, { file = "<text>" } = {}) {
  const findings = [];
  for (const rule of CONTENT_RULES) {
    rule.regex.lastIndex = 0;
    let match = rule.regex.exec(text);
    while (match !== null) {
      const value = match[0];
      if (!rule.allow || !rule.allow(value)) {
        findings.push({
          file,
          line: lineNumberAt(text, match.index),
          rule: rule.id,
          snippet: redactSnippet(text.slice(text.lastIndexOf("\n", match.index) + 1, text.indexOf("\n", match.index) === -1 ? undefined : text.indexOf("\n", match.index)), value),
        });
        if (findings.length >= 500) return findings;
      }
      if (rule.regex.lastIndex === match.index) rule.regex.lastIndex += 1;
      match = rule.regex.exec(text);
    }
  }
  return findings.sort((left, right) => left.line - right.line);
}

/** Read one candidate file and scan it; binary or oversized files are skipped. */
export function scanFile(filePath, { relativeTo = path.dirname(filePath) } = {}) {
  const relativePath = path.isAbsolute(filePath) ? path.relative(relativeTo, filePath) : filePath;
  const pathFindings = checkFilePath(relativePath);
  let buffer;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return pathFindings;
    buffer = fs.readFileSync(filePath);
  } catch {
    return pathFindings;
  }
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return pathFindings;
  let text;
  try {
    text = buffer.toString("utf8");
  } catch {
    return pathFindings;
  }
  return [...pathFindings, ...scanText(text, { file: relativePath })];
}

function walkTextFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full);
      } else if (entry.isFile() && isTextCandidate(full)) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files.sort();
}

/**
 * Candidate files for a privacy scan: git-tracked files when the checkout has
 * a repository, otherwise a filtered working-tree walk.
 * @param {string} [root]
 * @returns {string[]} absolute file paths
 */
export function listCandidates(root = ROOT) {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tracked = output.split("\0").filter(Boolean);
    if (tracked.length > 0) {
      return tracked.filter((relative) => isTextCandidate(relative)).map((relative) => path.join(root, relative));
    }
  } catch {
    // Not a git checkout (or git unavailable): fall back to the working tree.
  }
  return walkTextFiles(root);
}

/**
 * Scan the repository.
 * @param {{root?: string, files?: string[]}} [options]
 * @returns {{scanned: number, findings: {file: string, line: number, rule: string, snippet: string}[]}}
 */
export function runPrivacyScan({ root = ROOT, files = null } = {}) {
  const candidates = files ?? listCandidates(root);
  const findings = [];
  for (const file of candidates) {
    findings.push(...scanFile(file, { relativeTo: root }));
  }
  return { scanned: candidates.length, findings };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = { root: ROOT, list: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--list") options.list = true;
    else if (arg.startsWith("--root=")) options.root = path.resolve(arg.slice("--root=".length));
    else return { unknown: arg };
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/check-privacy.mjs [--root=<repo>] [--list]");
    return 0;
  }
  if (options.unknown) {
    console.error(`check-privacy: unknown argument ${options.unknown}`);
    return 2;
  }
  if (!fs.existsSync(options.root) || !fs.statSync(options.root).isDirectory()) {
    console.error(`check-privacy: root is not a directory: ${options.root}`);
    return 2;
  }
  const files = listCandidates(options.root);
  if (options.list) {
    for (const file of files) console.log(path.relative(options.root, file));
    console.log(`\n${files.length} text files would be scanned`);
  }
  const result = runPrivacyScan({ root: options.root, files });
  if (result.findings.length === 0) {
    console.log(`✓ privacy scan passed (${result.scanned} text files)`);
    return 0;
  }
  console.error(`✗ privacy scan found ${result.findings.length} problem${result.findings.length === 1 ? "" : "s"} in ${result.scanned} scanned files:`);
  for (const finding of result.findings) {
    const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  ${location} [${finding.rule}] ${finding.snippet}`);
  }
  console.error("\nRemove personal data, machine paths, session ids or credentials before publishing.");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
