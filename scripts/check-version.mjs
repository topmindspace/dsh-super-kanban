#!/usr/bin/env node
/**
 * Super Kanban — version and changelog consistency checker.
 *
 * Zero third-party dependencies. Used by CI, by the release workflow (before a
 * tag is published) and by `scripts/release.mjs`.
 *
 * It fails when the version a user sees in one place disagrees with another:
 *   - `package.json` version is exact SemVer;
 *   - `CHANGELOG.md` has an `## [Unreleased]` section and a release entry that
 *     matches `package.json` exactly, with a valid ISO date;
 *   - release entries descend by SemVer and by date, without duplicates;
 *   - every release heading has a matching link definition at the bottom and
 *     the link points at the tag (or compare range) for that version;
 *   - the Unreleased compare link starts at the current release;
 *   - `docs/index.json` (the plugin-market index) already lists this version;
 *   - `SECURITY.md` lists the current `MAJOR.MINOR.x` line as supported;
 *   - the DSH / Node compatibility ranges claimed in the user docs match
 *     `package.json` `engines`.
 *
 * Usage:
 *   node scripts/check-version.mjs [--root=<repo>]
 *
 * Exit code 0 when everything is consistent, 1 on problems.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/u;

/** Docs that state the DSH / Node compatibility ranges to users. */
const COMPATIBILITY_DOCS = ["README.md", "README.en.md", "docs/INSTALL.md"];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  return JSON.parse(readText(file));
}

/** Compare two exact SemVer strings; positive when `left` is newer. */
export function compareSemver(left, right) {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) throw new Error(`not exact SemVer: ${String(!a ? left : right)}`);
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta !== 0) return delta;
  }
  const preA = a[4] ? a[4].split(".") : [];
  const preB = b[4] ? b[4].split(".") : [];
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;
  for (let index = 0; index < Math.max(preA.length, preB.length); index += 1) {
    if (preA[index] === undefined) return -1;
    if (preB[index] === undefined) return 1;
    const numericA = /^\d+$/u.test(preA[index]);
    const numericB = /^\d+$/u.test(preB[index]);
    if (numericA && numericB) {
      const delta = Number(preA[index]) - Number(preB[index]);
      if (delta !== 0) return delta;
    } else if (numericA !== numericB) {
      return numericA ? -1 : 1;
    } else if (preA[index] !== preB[index]) {
      return preA[index] < preB[index] ? -1 : 1;
    }
  }
  return 0;
}

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Remove all whitespace so `>= 22.19.0` and `>=22.19.0` compare equal. */
function compact(value) {
  return String(value ?? "").replace(/\s+/gu, "");
}

/**
 * Check one file for a compatibility range.
 * @returns {string|null} a failure message, or null when it is present.
 */
function checkRangeClaim(file, absolute, range, label) {
  if (!fs.existsSync(absolute)) return `${file}: missing`;
  const source = compact(readText(absolute));
  if (!source.includes(compact(range))) {
    return `${file}: does not state the ${label} range from package.json (${String(range)})`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* CHANGELOG                                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse CHANGELOG.md into release entries and link definitions.
 * @returns {{releases: {version: string, date: string|null, line: number}[], links: Map<string, string>}}
 */
export function parseChangelog(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const releases = [];
  const links = new Map();
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = RELEASE_HEADING.exec(line);
    if (heading) releases.push({ version: heading[1], date: heading[2] ?? null, line: index + 1 });
    const link = /^\[([^\]]+)\]:\s*(\S+)\s*$/u.exec(line);
    if (link) links.set(link[1], link[2]);
  }
  return { releases, links };
}

function checkChangelog(root, pkg, failures) {
  const file = "CHANGELOG.md";
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    failures.push(`${file}: missing`);
    return;
  }
  const markdown = readText(absolute);
  if (!/^## \[Unreleased\]\s*$/mu.test(markdown)) failures.push(`${file}: missing "## [Unreleased]" section`);
  const { releases, links } = parseChangelog(markdown);
  if (releases.length === 0) {
    failures.push(`${file}: no release entries found (expected "## [x.y.z] - YYYY-MM-DD")`);
    return;
  }
  const latest = releases[0];
  if (latest.version !== pkg.version) {
    failures.push(
      `${file}: latest release entry is ${latest.version} but package.json is ${pkg.version}; add the changelog entry and move the previous one below it`,
    );
  }
  if (!latest.date) failures.push(`${file}:${String(latest.line)}: release entry for ${latest.version} needs an ISO date (YYYY-MM-DD)`);
  else if (!ISO_DATE.test(latest.date)) failures.push(`${file}:${String(latest.line)}: invalid date "${latest.date}"`);
  const seen = new Set();
  let previous = null;
  for (const release of releases) {
    if (seen.has(release.version)) failures.push(`${file}: duplicate release entry ${release.version}`);
    seen.add(release.version);
    if (!SEMVER.test(release.version)) failures.push(`${file}:${String(release.line)}: "${release.version}" is not exact SemVer`);
    if (!release.date) {
      failures.push(`${file}:${String(release.line)}: release entry for ${release.version} needs an ISO date`);
    } else if (!ISO_DATE.test(release.date)) {
      failures.push(`${file}:${String(release.line)}: invalid date "${release.date}" for ${release.version}`);
    }
    if (previous) {
      if (compareSemver(previous.version, release.version) < 0) {
        failures.push(`${file}:${String(release.line)}: ${release.version} is listed after newer ${previous.version}`);
      }
      if (previous.date && release.date && previous.date < release.date) {
        failures.push(`${file}:${String(release.line)}: ${release.version} (${release.date}) is newer than the entry above it (${previous.date})`);
      }
    }
    previous = release;
    const link = links.get(release.version);
    if (!link) {
      failures.push(`${file}: missing link definition "[${release.version}]: ..." at the bottom of the file`);
    } else if (!link.includes(`v${release.version}`)) {
      failures.push(`${file}: link for ${release.version} does not point at tag v${release.version}`);
    }
  }
  const unreleased = links.get("Unreleased");
  if (!unreleased) failures.push(`${file}: missing "[Unreleased]: ..." link definition`);
  else if (!unreleased.includes(`v${pkg.version}`)) {
    failures.push(`${file}: "[Unreleased]" compare link must start at v${pkg.version} (found ${unreleased})`);
  }
}

/* ------------------------------------------------------------------ */
/* Market index                                                        */
/* ------------------------------------------------------------------ */

function checkMarketIndexVersion(root, pkg, failures) {
  const file = path.join(root, "docs", "index.json");
  if (!fs.existsSync(file)) {
    failures.push("docs/index.json: missing; run \"npm run market:index\"");
    return;
  }
  let index;
  try {
    index = readJson(file);
  } catch (error) {
    failures.push(`docs/index.json: invalid JSON: ${error.message}`);
    return;
  }
  const entry = index.plugins?.find((plugin) => plugin.name === pkg.name);
  if (!entry) {
    failures.push(`docs/index.json: does not list plugin "${pkg.name}"`);
    return;
  }
  const latest = entry.versions?.[0]?.version;
  if (latest !== pkg.version) {
    failures.push(`docs/index.json: latest indexed version is ${String(latest)}, package.json is ${pkg.version}; run "npm run market:index" and commit the result`);
  }
}

/* ------------------------------------------------------------------ */
/* Security policy                                                     */
/* ------------------------------------------------------------------ */

function checkSecurityPolicy(root, pkg, failures) {
  const file = "SECURITY.md";
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    failures.push(`${file}: missing`);
    return;
  }
  const match = SEMVER.exec(pkg.version);
  const minor = match ? `${match[1]}.${match[2]}.x` : "";
  const markdown = readText(absolute);
  const row = new RegExp(`\\|\\s*${escapeRegExp(minor)}\\s*\\|\\s*✅`, "u");
  if (!row.test(markdown)) {
    failures.push(`${file}: supported-versions table does not list the current line ${minor} as supported`);
  }
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/**
 * Run every version-consistency check.
 * @param {{root?: string}} [options]
 * @returns {{ok: boolean, checks: string[], failures: string[]}}
 */
export function runCheckVersion({ root = ROOT } = {}) {
  const checks = [];
  const failures = [];
  const pkgFile = path.join(root, "package.json");
  if (!fs.existsSync(pkgFile)) {
    return { ok: false, checks, failures: ["package.json: missing"] };
  }
  let pkg;
  try {
    pkg = readJson(pkgFile);
  } catch (error) {
    return { ok: false, checks, failures: [`package.json: invalid JSON: ${error.message}`] };
  }
  if (typeof pkg.version !== "string" || !SEMVER.test(pkg.version)) {
    return { ok: false, checks, failures: [`package.json: "${String(pkg.version)}" is not exact SemVer`] };
  }

  checkChangelog(root, pkg, failures);
  if (failures.length === 0) checks.push(`CHANGELOG.md matches package.json ${pkg.version}`);
  checkMarketIndexVersion(root, pkg, failures);
  checkSecurityPolicy(root, pkg, failures);
  for (const [label, range] of [
    ["DSH", pkg.engines?.dsh],
    ["Node.js", pkg.engines?.node],
  ]) {
    if (typeof range !== "string" || !range.trim()) {
      failures.push(`package.json: engines.${label === "DSH" ? "dsh" : "node"} is missing`);
      continue;
    }
    for (const relative of COMPATIBILITY_DOCS) {
      const problem = checkRangeClaim(relative, path.join(root, relative), range, label);
      if (problem) failures.push(problem);
    }
  }
  if (failures.length === 0) checks.push("docs/index.json, SECURITY.md and compatibility ranges are in sync");
  return { ok: failures.length === 0, checks, failures };
}

function printResult(result) {
  for (const check of result.checks) console.log(`✓ ${check}`);
  for (const failure of result.failures) console.error(`✗ ${failure}`);
  if (result.ok) console.log("\ncheck-version passed");
  else console.error(`\ncheck-version failed (${String(result.failures.length)} problems)`);
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
    console.log("Usage: node scripts/check-version.mjs [--root=<repo>]");
    return 0;
  }
  if (options.unknown) {
    console.error(`check-version: unknown argument ${options.unknown}`);
    return 2;
  }
  const result = runCheckVersion({ root: options.root });
  printResult(result);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
