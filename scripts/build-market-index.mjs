#!/usr/bin/env node
/**
 * Super Kanban — DSH plugin market index generator (format 1).
 *
 * Reads the npm/DSH package metadata from `package.json`, resolves the release
 * source (a pinned git commit or the npm registry) and writes the format-1
 * index consumed by DSH's plugin market to `docs/index.json`. The generated
 * document is validated with the same rules as the DSH reader before it is
 * written, and the plugin icon is kept next to the index for GitHub Pages.
 *
 * Usage:
 *   node scripts/build-market-index.mjs [--source=git|npm] [--commit=<sha>]
 *       [--timestamp=<unix>] [--out=<file>] [--index-url=<url>] [--print] [--check]
 *
 * Zero third-party dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MARKET_INDEX_PATH, deriveIndexUrl, normalizeRepositoryUrl, validateMarketIndex } from "./validate.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_TITLE = { en: "Super Kanban", zh: "Super Kanban 任务看板" };
export const PLUGIN_DESCRIPTION_ZH =
  "面向 DeepSeek Harness 的 AI 项目看板。自动更新会话任务，集中处理审批、阻塞和验收，支持项目归属、任务日程、备注与快聊。可在全页或会话右侧栏打开。";
export const INDEX_TITLE = { en: "TopMindSpace DSH plugins", zh: "TopMindSpace DSH 插件索引" };
export const INDEX_DESCRIPTION = {
  en: "Installable plugins for DeepSeek Harness maintained by TopMindSpace.",
  zh: "TopMindSpace 维护的 DeepSeek Harness 可安装插件。",
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Read the repository package.json. */
export function readPackage(root = ROOT) {
  return readJson(path.join(root, "package.json"));
}

/** Resolve the git commit that the git-source version should pin. */
export function gitHead(root = ROOT) {
  const output = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!COMMIT.test(output)) throw new Error(`git rev-parse returned an unexpected value: ${output}`);
  return output;
}

/** Compare two exact SemVer versions; positive when `left` is newer. */
export function compareSemver(left, right) {
  const a = SEMVER.exec(String(left || ""));
  const b = SEMVER.exec(String(right || ""));
  if (!a || !b) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  const prereleaseA = a[4];
  const prereleaseB = b[4];
  if (!prereleaseA && prereleaseB) return 1;
  if (prereleaseA && !prereleaseB) return -1;
  if (!prereleaseA && !prereleaseB) return 0;
  return String(prereleaseA).localeCompare(String(prereleaseB), "en");
}

/** Existing versions of this plugin from a previously generated index. */
function previousVersions(previous, name) {
  try {
    const entry = (previous?.plugins ?? []).find((plugin) => plugin?.name === name);
    return Array.isArray(entry?.versions) ? entry.versions.filter((version) => version && typeof version === "object") : [];
  } catch {
    return [];
  }
}

/**
 * Build the market index document (format 1).
 *
 * @param {object} options
 * @param {object} options.pkg package.json content.
 * @param {"git"|"npm"} [options.source]
 * @param {string|null} [options.commit] 40-hex commit for the git source.
 * @param {number|null} [options.publishTimestamp] Unix seconds; when omitted the
 *   previous timestamp is reused for an unchanged version/source, otherwise the
 *   current time is used.
 * @param {object|null} [options.previous] previously generated index (versions are preserved).
 * @param {string} [options.repositoryUrl] canonical repository URL.
 * @returns {object} format-1 market index
 */
export function buildMarketIndex({
  pkg,
  source = "git",
  commit = null,
  publishTimestamp = null,
  previous = null,
  repositoryUrl = normalizeRepositoryUrl(pkg),
}) {
  if (!pkg || typeof pkg !== "object") throw new Error("buildMarketIndex requires a package.json object");
  if (!repositoryUrl) throw new Error("package.json repository URL is missing or not an https URL");
  if (publishTimestamp !== null && (!Number.isInteger(publishTimestamp) || publishTimestamp < 0)) {
    throw new Error(`publishTimestamp must be a non-negative integer number of Unix seconds, got ${String(publishTimestamp)}`);
  }
  if (source === "git" && !COMMIT.test(String(commit || ""))) {
    throw new Error(`git source requires a lowercase 40-hex commit SHA, got ${JSON.stringify(commit)}`);
  }
  if (source !== "git" && source !== "npm") throw new Error(`unknown source "${source}" (expected "git" or "npm")`);

  // Reuse the previous timestamp when version and source are unchanged so a
  // repeated generation does not produce a spurious diff.
  const previousSameVersion = previousVersions(previous, pkg.name).find((version) => version.version === pkg.version);
  const sameSource =
    previousSameVersion &&
    (source === "git"
      ? previousSameVersion.source?.type === "git" && previousSameVersion.source.commit === commit
      : previousSameVersion.source?.type === "npm");
  const timestamp =
    publishTimestamp ??
    (sameSource && Number.isInteger(previousSameVersion.publishTimestamp)
      ? previousSameVersion.publishTimestamp
      : Math.floor(Date.now() / 1000));

  const currentVersion = {
    version: pkg.version,
    publishTimestamp: timestamp,
    source: source === "git" ? { type: "git", url: repositoryUrl, commit } : { type: "npm" },
    engines: pkg.engines?.dsh ? { dsh: pkg.engines.dsh } : {},
  };

  const versions = previousVersions(previous, pkg.name).filter((version) => version.version !== pkg.version);
  versions.push(currentVersion);
  versions.sort((left, right) => compareSemver(right.version, left.version));

  const plugin = {
    name: pkg.name,
    title: PLUGIN_TITLE,
    description: { en: pkg.description, zh: PLUGIN_DESCRIPTION_ZH },
    icon: "./icon.svg",
    ...(typeof pkg.author === "string" ? { author: pkg.author } : {}),
    ...(typeof pkg.homepage === "string" ? { homepage: pkg.homepage } : {}),
    repository: { url: repositoryUrl },
    metadata: {
      category: "productivity",
      keywords: Array.isArray(pkg.keywords) ? [...pkg.keywords] : [],
      labels: ["kanban", "ai"],
      sortKeys: {},
    },
    versions,
  };

  return {
    format: 1,
    title: INDEX_TITLE,
    description: INDEX_DESCRIPTION,
    metadata: {
      categories: { productivity: { title: { en: "Productivity", zh: "效率" } } },
      labels: {
        kanban: { title: { en: "Kanban", zh: "看板" } },
        ai: { title: { en: "AI", zh: "AI" } },
      },
      sortKeys: {},
    },
    plugins: [plugin],
  };

}

/** Copy the repository icon next to the generated index (GitHub Pages). */
export function syncIcon(root = ROOT, indexFile = path.join(root, MARKET_INDEX_PATH)) {
  const source = path.join(root, "icon.svg");
  const target = path.join(path.dirname(indexFile), "icon.svg");
  if (!fs.existsSync(source)) throw new Error(`plugin icon is missing: ${path.relative(root, source)}`);
  if (path.resolve(target) === path.resolve(source)) return false;
  const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const wanted = fs.readFileSync(source);
  if (current && current.equals(wanted)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, wanted);
  return true;
}

function parseArgs(argv) {
  const options = { root: ROOT, source: "git", commit: null, timestamp: null, out: null, indexUrl: null, print: false, check: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--print") options.print = true;
    else if (arg === "--check") options.check = true;
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length);
    else if (arg.startsWith("--commit=")) options.commit = arg.slice("--commit=".length);
    else if (arg.startsWith("--timestamp=")) options.timestamp = Number(arg.slice("--timestamp=".length));
    else if (arg.startsWith("--out=")) options.out = path.resolve(arg.slice("--out=".length));
    else if (arg.startsWith("--index-url=")) options.indexUrl = arg.slice("--index-url=".length);
    else if (arg.startsWith("--root=")) options.root = path.resolve(arg.slice("--root=".length));
    else return { unknown: arg };
  }
  return options;
}

/** Explicit timestamp from CLI/env, or null to let the builder decide. */
function resolveTimestamp(options) {
  if (options.timestamp !== null) {
    if (!Number.isInteger(options.timestamp) || options.timestamp < 0) {
      throw new Error("--timestamp must be non-negative integer Unix seconds");
    }
    return options.timestamp;
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && epoch !== "") {
    const value = Number(epoch);
    if (!Number.isInteger(value) || value < 0) throw new Error("SOURCE_DATE_EPOCH must be non-negative integer Unix seconds");
    return value;
  }
  return null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/build-market-index.mjs [--source=git|npm] [--commit=<sha>] [--timestamp=<unix>] [--out=<file>] [--index-url=<url>] [--print] [--check] [--root=<repo>]");
    return 0;
  }
  if (options.unknown) {
    console.error(`market:index: unknown argument ${options.unknown}`);
    return 2;
  }
  const root = options.root;
  const outputFile = options.out ?? path.join(root, MARKET_INDEX_PATH);
  let pkg;
  try {
    pkg = readPackage(root);
  } catch (error) {
    console.error(`market:index: cannot read package.json: ${error.message}`);
    return 1;
  }

  let commit = options.commit;
  if (options.source === "git" && !commit) {
    try {
      commit = gitHead(root);
    } catch (error) {
      console.error("market:index: no git commit available for the git source.");
      console.error(`  ${error.message}`);
      console.error("  Create the repository commit first (git init && git add -A && git commit),");
      console.error("  or pass --commit=<40-hex-sha>. Use --source=npm for an npm-registry source.");
      return 1;
    }
  }

  let previous = null;
  try {
    if (fs.existsSync(outputFile)) previous = readJson(outputFile);
  } catch {
    previous = null;
  }

  let index;
  try {
    index = buildMarketIndex({
      pkg,
      source: options.source,
      commit,
      publishTimestamp: resolveTimestamp(options),
      previous,
    });
    validateMarketIndex(index, options.indexUrl ?? deriveIndexUrl(pkg));
  } catch (error) {
    console.error(`market:index: generated index is invalid: ${error.message}`);
    return 1;
  }

  const json = `${JSON.stringify(index, null, 2)}\n`;
  const version = index.plugins[0].versions[0];
  const summary = [
    `  plugin          : ${pkg.name}@${pkg.version}`,
    `  source          : ${version.source.type}${version.source.commit ? ` ${version.source.url}@${version.source.commit}` : " (npm registry)"}`,
    `  publishTimestamp: ${version.publishTimestamp} (${new Date(version.publishTimestamp * 1000).toISOString()})`,
    `  versions        : ${index.plugins[0].versions.map((entry) => entry.version).join(", ")}`,
  ];
  if (options.check) {
    console.log(`✓ market index is valid for ${pkg.name}@${pkg.version} (${options.source} source)`);
    return 0;
  }
  if (options.print) {
    process.stdout.write(json);
    console.error(`✓ market index printed to stdout (not written)`);
    for (const line of summary) console.error(line);
    return 0;
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, json);
  let iconCopied = false;
  if (path.basename(outputFile) === "index.json" && path.basename(path.dirname(outputFile)) === "docs") {
    iconCopied = syncIcon(root, outputFile);
  }
  console.log(`✓ wrote ${path.relative(root, outputFile) || outputFile}`);
  for (const line of summary) console.log(line);
  console.log(`  icon            : ${iconCopied ? "synced docs/icon.svg" : "docs/icon.svg already up to date"}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`market:index: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
