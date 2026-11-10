#!/usr/bin/env node
/**
 * Super Kanban — documentation and repository-structure checker.
 *
 * Zero third-party dependencies: this script only uses the Node.js standard
 * library, so it runs in CI and in a bare checkout without `npm install`.
 *
 * It guards the things that silently rot after a refactor or a release:
 *   - required public files exist (docs, workflows, community files);
 *   - every relative link / anchor in the shipped Markdown and in the GitHub
 *     Pages landing page points at a file that exists;
 *   - `raw.githubusercontent.com` and `github.com/.../blob/main/...` links used
 *     by the READMEs resolve to a file in this repository;
 *   - README.md and README.en.md keep the same structure (sections, code
 *     blocks, tables, screenshots) so translations cannot silently drift;
 *   - screenshots under docs/screenshots are all referenced and no referenced
 *     screenshot is missing;
 *   - public docs no longer mention the removed `plugin/` layout or link to
 *     historical internal notes as if they were public docs;
 *   - docs/index.html is a usable landing page for the plugin market index
 *     served by GitHub Pages, and it does not hard-code a stale version;
 *   - maintainer-local trees (dev/, internal/docs-internal/) have a README when
 *     they are present (they are git-ignored, so a clean checkout skips them).
 *
 * Usage:
 *   node scripts/check-docs.mjs [--root=<repo>]
 *
 * Exit code 0 when every check passes, 1 on failures.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REPO = "https://github.com/topmindspace/dsh-super-kanban";
const RAW = "https://raw.githubusercontent.com/topmindspace/dsh-super-kanban/main/";
const BLOB = `${REPO}/blob/main/`;

/** Public Markdown that ships with the repository (relative to the root). */
const PUBLIC_DOCS = [
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "docs/ARCHITECTURE.md",
  "docs/CONTRACT.md",
  "docs/DESIGN.md",
  "docs/DEVELOPMENT.md",
  "docs/INSTALL.md",
  "docs/MARKET.md",
  "docs/ROADMAP.md",
  "docs/TROUBLESHOOTING.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

/** Files that must exist for the public repository to be self-consistent. */
const REQUIRED_FILES = [
  ...PUBLIC_DOCS,
  "LICENSE",
  "package.json",
  "index.mjs",
  "client.js",
  "cordis.patch.yml",
  "icon.svg",
  "install.sh",
  "uninstall.sh",
  "scripts/validate.mjs",
  "scripts/check-privacy.mjs",
  "scripts/check-docs.mjs",
  "scripts/check-version.mjs",
  "scripts/build-market-index.mjs",
  "scripts/release.mjs",
  "docs/index.html",
  "docs/index.json",
  "docs/icon.svg",
  "docs/.nojekyll",
  "docs/screenshots/demo.gif",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
];

/** Directories that are git-ignored maintainer material (checked when present). */
const LOCAL_TREES = [
  { dir: "dev", readme: "dev/README.md" },
  { dir: "internal/docs-internal", readme: "internal/docs-internal/README.md" },
];

/** Markdown syntax that must not reappear in public docs. */
const STALE_PATTERNS = [
  {
    regex: /(?:^|[`"'\s(])plugin\/(?:server\/|client\.js|index\.mjs|package\.json|cordis\.patch\.yml)/m,
    message: "mentions the removed `plugin/` directory layout",
  },
  {
    regex: /docs\/(?:DEV-CONTRACT|DEV-NOTES|DESIGN-V2|DESIGN-V3|QA-REPORT(?:-V2)?)\.md/,
    message: "links to a historical internal note as if it were a public doc",
  },
];

const FENCE = /^\s*(```|~~~)/;
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function fail(failures, message) {
  failures.push(message);
}

function warn(warnings, message) {
  warnings.push(message);
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

/** GitHub-style heading anchors, including the `-1`, `-2` suffix for duplicates. */
export function headingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!match) continue;
    const base = slugify(match[2]);
    if (!base) continue;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${String(seen)}`);
  }
  return anchors;
}

/** Approximate GitHub's heading slugification (Unicode letters are preserved). */
export function slugify(heading) {
  const text = heading
    .replace(/<[^>]*>/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/[*_~]+/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    // GitHub's slugger turns each space into one hyphen; a run of spaces
    // therefore produces "--", not "-". Do not collapse whitespace here, or
    // headings with " / " style separators get a false-positive anchor.
    .replace(/\s/gu, "-");
  return text;
}

/** Iterate over Markdown outside fenced code blocks. */
function* scanLines(markdown) {
  let inFence = false;
  const lines = markdown.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) {
      inFence = !inFence;
      yield { line, lineNumber: index + 1, inFence: true };
      continue;
    }
    yield { line, lineNumber: index + 1, inFence };
  }
}

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target);
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

function checkRequiredFiles(root, failures) {
  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(root, file))) fail(failures, `missing required file: ${file}`);
  }
}

function checkLocalTrees(root, failures, warnings) {
  for (const { dir, readme } of LOCAL_TREES) {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) continue;
    if (!fs.existsSync(path.join(root, readme))) {
      fail(failures, `${dir}/ exists but ${readme} is missing (document the maintainer-local tree or remove it)`);
      continue;
    }
    for (const file of collectMarkdown(absolute)) {
      checkMarkdownFile(root, file, warnings, { optional: true });
    }
  }
}

/** Recursively collect Markdown files below `directory`. */
function collectMarkdown(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(absolute);
      } else if (entry.name.endsWith(".md")) {
        files.push(absolute);
      }
    }
  };
  walk(directory);
  return files;
}

/**
 * Validate relative links, in-repository absolute links and heading anchors.
 * `optional` downgrades problems to warnings (used for git-ignored local notes).
 */
function checkMarkdownFile(root, absolute, sink, { optional = false } = {}) {
  const report = (message) => (optional ? sink.push(message) : fail(sink, message));
  const relative = path.relative(root, absolute) || path.basename(absolute);
  const markdown = readText(absolute);

  for (const { line, lineNumber, inFence } of scanLines(markdown)) {
    if (inFence) continue;
    // Explicit HTML links in Markdown (docs/index.html is handled separately).
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      const target = match[3].trim();
      if (!target || target.startsWith("#") || isExternal(target)) {
        if (isExternal(target)) {
          checkRepositoryUrl(root, target, report, `${relative}:${String(lineNumber)}`);
        }
        continue;
      }
      const [pathPart, fragment] = target.split("#");
      if (!pathPart) continue;
      const decoded = safeDecode(pathPart);
      const resolved = path.resolve(path.dirname(absolute), decoded);
      if (!fs.existsSync(resolved)) {
        report(`${relative}:${String(lineNumber)}: broken relative link "${target}"`);
        continue;
      }
      if (fragment && resolved.endsWith(".md")) {
        checkAnchor(resolved, safeDecode(fragment), report, `${relative}:${String(lineNumber)}`);
      }
    }
  }
}

/** Check links that point at this repository on GitHub / raw.githubusercontent. */
function checkRepositoryUrl(root, url, report, location) {
  for (const [prefix, isBlob] of [
    [RAW, false],
    [BLOB, true],
  ]) {
    if (!url.startsWith(prefix)) continue;
    const rest = url.slice(prefix.length);
    const [pathPart, fragment] = rest.split("#");
    const decoded = safeDecode(pathPart.replace(/[?].*$/u, ""));
    if (!decoded) return;
    // Links to other branches/tags do not describe this working tree.
    const resolved = path.resolve(root, decoded);
    if (!resolved.startsWith(path.resolve(root))) {
      report(`${location}: repository link escapes the repository "${url}"`);
      return;
    }
    if (!fs.existsSync(resolved)) {
      report(`${location}: repository link points at a missing file "${url}"`);
      return;
    }
    if (isBlob && fragment && resolved.endsWith(".md")) {
      checkAnchor(resolved, safeDecode(fragment), report, location);
    }
    return;
  }
}

function checkAnchor(file, fragment, report, location) {
  if (!fragment) return;
  const anchors = headingAnchors(readText(file));
  if (!anchors.has(fragment)) {
    report(`${location}: anchor "#${fragment}" does not exist in ${path.basename(file)}`);
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** README.md and README.en.md must keep the same information architecture. */
function checkReadmeParity(root, failures) {
  const zh = path.join(root, "README.md");
  const en = path.join(root, "README.en.md");
  if (!fs.existsSync(zh) || !fs.existsSync(en)) return;
  const metrics = (markdown) => {
    const outside = [...scanLines(markdown)]
      .filter((entry) => !entry.inFence)
      .map((entry) => entry.line)
      .join("\n");
    const images = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/gu)]
      .map((match) => match[1].split("/").pop())
      .filter(Boolean)
      .sort();
    const lines = outside.split("\n");
    return {
      headings: lines.filter((line) => /^#{2,3}\s+/u.test(line)).length,
      fenced: markdown.split("\n").filter((line) => FENCE.test(line)).length,
      tables: lines.filter((line) => /^\|\s*---/u.test(line)).length,
      tableRows: lines.filter((line) => /^\|.*\|\s*$/u.test(line)).length,
      listItems: lines.filter((line) => /^\s*[-*]\s+/u.test(line)).length,
      numberedItems: lines.filter((line) => /^\s*\d+\.\s+/u.test(line)).length,
      images: images.join(","),
    };
  };
  const zhMetrics = metrics(readText(zh));
  const enMetrics = metrics(readText(en));
  for (const field of Object.keys(zhMetrics)) {
    if (zhMetrics[field] !== enMetrics[field]) {
      fail(
        failures,
        `README parity: ${field} differ (README.md=${String(zhMetrics[field])}, README.en.md=${String(enMetrics[field])}); keep both translations in sync`,
      );
    }
  }
  if (!/\]\([^)]*README\.en\.md\)/u.test(readText(zh))) fail(failures, "README.md does not link to README.en.md");
  if (!/\]\([^)]*README\.md(?:\)|[#?])/u.test(readText(en))) fail(failures, "README.en.md does not link to README.md");
}

/** Every screenshot must be referenced at least once and every reference must exist. */
function checkScreenshots(root, failures, warnings) {
  const dir = path.join(root, "docs/screenshots");
  if (!fs.existsSync(dir)) {
    fail(failures, "docs/screenshots/ is missing");
    return;
  }
  const files = fs.readdirSync(dir).filter((entry) => fs.statSync(path.join(dir, entry)).isFile());
  if (files.length === 0) fail(failures, "docs/screenshots/ is empty");
  const referenced = new Set();
  for (const relative of PUBLIC_DOCS) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const text = readText(absolute);
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/gu)) {
      if (!match[1].includes("docs/screenshots/")) continue;
      const name = match[1].split("/").pop();
      if (name) referenced.add(name);
    }
    for (const match of text.matchAll(/docs\/screenshots\/([A-Za-z0-9._-]+)/gu)) {
      referenced.add(match[1]);
    }
  }
  for (const file of files) {
    if (!referenced.has(file)) warn(warnings, `docs/screenshots/${file} is not referenced by any public doc`);
  }
  for (const name of referenced) {
    if (!files.includes(name)) fail(failures, `referenced screenshot docs/screenshots/${name} does not exist`);
  }
}

/** Public docs must not describe the pre-0.3 `plugin/` layout any more. */
function checkStaleLayout(root, failures) {
  for (const relative of PUBLIC_DOCS) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const markdown = readText(absolute);
    for (const { line, lineNumber, inFence } of scanLines(markdown)) {
      if (inFence) continue;
      for (const { regex, message } of STALE_PATTERNS) {
        if (regex.test(line)) {
          fail(failures, `${relative}:${String(lineNumber)}: ${message}: ${line.trim().slice(0, 120)}`);
        }
      }
    }
  }
}

/** The GitHub Pages landing page must point at the market index and stay version-free. */
function checkLandingPage(root, failures) {
  const file = path.join(root, "docs/index.html");
  if (!fs.existsSync(file)) return;
  const html = readText(file);
  if (!/<html[^>]*\blang=/iu.test(html)) fail(failures, "docs/index.html: <html> must declare a lang attribute");
  if (!/<title>[^<]+<\/title>/iu.test(html)) fail(failures, "docs/index.html: missing a non-empty <title>");
  if (!/(?:href|src)="(?:\.\/)?index\.json"/u.test(html)) {
    fail(failures, "docs/index.html: must link to ./index.json (the market index published by GitHub Pages)");
  }
  if (!fs.existsSync(path.join(root, "docs/.nojekyll"))) {
    fail(failures, "docs/.nojekyll is missing; GitHub Pages would run Jekyll over the docs/ directory");
  }
  // The Pages copy of the icon must stay byte-identical to the package icon.
  const sourceIcon = path.join(root, "icon.svg");
  const publishedIcon = path.join(root, "docs/icon.svg");
  if (fs.existsSync(sourceIcon) && fs.existsSync(publishedIcon)) {
    if (!fs.readFileSync(sourceIcon).equals(fs.readFileSync(publishedIcon))) {
      fail(failures, "docs/icon.svg differs from icon.svg; run \"npm run market:index\" to sync the published copy");
    }
  }
  // The market index icon URL is resolved relative to the index URL.
  try {
    const index = JSON.parse(readText(path.join(root, "docs/index.json")));
    for (const plugin of index.plugins ?? []) {
      if (typeof plugin.icon !== "string" || !plugin.icon.startsWith("./")) continue;
      const resolved = path.resolve(path.dirname(path.join(root, "docs/index.json")), plugin.icon);
      if (!fs.existsSync(resolved)) fail(failures, `docs/index.json: icon "${plugin.icon}" does not exist`);
    }
  } catch (error) {
    fail(failures, `docs/index.json: cannot be parsed: ${String(error?.message || error)}`);
  }
  const staleVersion = /当前版本\s*\d+\.\d+\.\d+/u.exec(html);
  if (staleVersion) {
    fail(failures, `docs/index.html hard-codes a version ("${staleVersion[0]}"); read it from index.json instead`);
  }
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/gu)) {
    const target = match[1];
    if (!target || target.startsWith("#") || isExternal(target) || target.startsWith("data:")) continue;
    const resolved = path.resolve(path.dirname(file), target.split("#")[0].split("?")[0]);
    if (!fs.existsSync(resolved)) fail(failures, `docs/index.html: broken local reference "${target}"`);
  }
}

/** Lightweight sanity checks for the YAML that drives CI (no YAML parser needed). */
function checkWorkflowYaml(root, failures) {
  const workflows = [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/dependabot.yml",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
  ];
  for (const relative of workflows) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const source = readText(absolute);
    if (/\t/u.test(source)) {
      fail(failures, `${relative}: must use spaces, not tabs (invalid/ambiguous YAML indentation)`);
    }
    if (relative.includes("/workflows/")) {
      for (const key of ["name:", "on:", "jobs:"]) {
        if (!new RegExp(`^${key}`, "mu").test(source)) fail(failures, `${relative}: missing top-level \"${key}\" key`);
      }
      if (!/^\s+runs-on:/mu.test(source)) fail(failures, `${relative}: no job declares \"runs-on:\"`);
    }
    if (relative.endsWith(".github/dependabot.yml")) {
      if (!/^version:\s*2\s*$/mu.test(source)) fail(failures, `${relative}: missing "version: 2"`);
      if (!/^updates:/mu.test(source)) fail(failures, `${relative}: missing "updates:" list`);
    }
  }
}

function checkWorkflowReferences(root, failures) {
  const readme = readText(path.join(root, "README.md"));
  for (const match of readme.matchAll(/actions\/workflows\/([A-Za-z0-9._-]+)/gu)) {
    const file = `.github/workflows/${match[1]}`;
    if (!fs.existsSync(path.join(root, file))) fail(failures, `README.md references missing workflow: ${file}`);
  }
  const pkg = JSON.parse(readText(path.join(root, "package.json")));
  const npmBadge = /img\.shields\.io\/npm\/v\/([^)\s]+)\.svg/u.exec(readme);
  if (npmBadge && npmBadge[1] !== pkg.name) {
    fail(failures, `README.md npm badge points at "${npmBadge[1]}" instead of "${pkg.name}"`);
  }
  if (/badge\/License-MIT-blue/u.test(readme) && pkg.license !== "MIT") {
    fail(failures, `README.md license badge says MIT but package.json says ${String(pkg.license)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/**
 * Run every documentation check.
 * @param {{root?: string}} [options]
 * @returns {{ok: boolean, checks: string[], warnings: string[], failures: string[]}}
 */
export function runCheckDocs({ root = ROOT } = {}) {
  const checks = [];
  const warnings = [];
  const failures = [];
  const note = (name) => checks.push(name);
  const before = failures.length;

  checkRequiredFiles(root, failures);
  if (failures.length === before) note(`required files (${String(REQUIRED_FILES.length)})`);

  const markdownFailures = [];
  for (const relative of PUBLIC_DOCS) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    checkMarkdownFile(root, absolute, markdownFailures);
  }
  failures.push(...markdownFailures);
  if (markdownFailures.length === 0) note(`markdown links and anchors (${String(PUBLIC_DOCS.length)} files)`);

  checkReadmeParity(root, failures);
  checkScreenshots(root, failures, warnings);
  checkStaleLayout(root, failures);
  checkLandingPage(root, failures);
  checkWorkflowYaml(root, failures);
  checkWorkflowReferences(root, failures);
  checkLocalTrees(root, failures, warnings);
  note("landing page, screenshots, README parity and repository links");

  return { ok: failures.length === 0, checks, warnings, failures };
}

function printResult(result) {
  for (const check of result.checks) console.log(`✓ ${check}`);
  for (const warning of result.warnings) console.warn(`⚠ ${warning}`);
  for (const failure of result.failures) console.error(`✗ ${failure}`);
  if (result.ok) {
    console.log(`\ncheck-docs passed (${String(result.checks.length)} checks, ${String(result.warnings.length)} warnings)`);
  } else {
    console.error(`\ncheck-docs failed (${String(result.failures.length)} problems, ${String(result.warnings.length)} warnings)`);
  }
}

function parseArgs(argv) {
  const options = { root: ROOT, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--root=")) options.root = path.resolve(arg.slice("--root=".length));
    else return { unknown: arg };
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/check-docs.mjs [--root=<repo>]");
    return 0;
  }
  if (options.unknown) {
    console.error(`check-docs: unknown argument ${options.unknown}`);
    return 2;
  }
  const result = runCheckDocs({ root: options.root });
  printResult(result);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
