#!/usr/bin/env node
/**
 * Super Kanban — zero-dependency repository validator.
 *
 * Checks the npm/DSH package manifest, the Cordis bundle patch, the shipped
 * file list, JavaScript syntax, required public files, and the plugin-market
 * index (`docs/index.json`, DSH plugin market index format 1).
 *
 * Usage:
 *   node scripts/validate.mjs [--root=<repo>]
 *
 * Exit code 0 when everything passes, 1 on validation failures.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MARKET_INDEX_PATH = path.join("docs", "index.json");
export const MAX_INLINE_ICON_BYTES = 32 * 1024;
const MAX_PUBLISH_TIMESTAMP = 1e11;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RANGE_TOKEN = /^(?:[<>]=?|=|\^|~)?v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "internal", "dev", "dist", "data", "out", "tmp", ".tmp", ".cache"]);

/** Required public repository files (relative to the repository root). */
export const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "index.mjs",
  "client.js",
  "cordis.patch.yml",
  "icon.svg",
  "install.sh",
  "uninstall.sh",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "scripts/validate.mjs",
  "scripts/check-privacy.mjs",
  "scripts/check-docs.mjs",
  "scripts/check-version.mjs",
  "scripts/build-market-index.mjs",
  "scripts/release.mjs",
  "tests/store.test.mjs",
  "tests/store-robustness.test.mjs",
  "tests/analyzer.test.mjs",
  "tests/analyzer-llm.test.mjs",
  "tests/sessions.test.mjs",
  "tests/service.test.mjs",
  "tests/http.test.mjs",
  "tests/auth.test.mjs",
  "tests/titles.test.mjs",
  "tests/host-entry.test.mjs",
  "tests/package.test.mjs",
  "tests/market-index.test.mjs",
  "tests/check-privacy.test.mjs",
  "docs/ARCHITECTURE.md",
  "docs/CONTRACT.md",
  "docs/DESIGN.md",
  "docs/DEVELOPMENT.md",
  "docs/INSTALL.md",
  "docs/MARKET.md",
  "docs/TROUBLESHOOTING.md",
  "docs/index.html",
  "docs/.nojekyll",
  "docs/icon.svg",
];

/** Host implementation modules that must ship with the plugin. */
export const REQUIRED_SERVER_FILES = [
  "server/service.mjs",
  "server/sessions.mjs",
  "server/analyzer-rules.mjs",
  "server/analyzer-llm.mjs",
  "server/native-llm.mjs",
  "server/store.mjs",
  "server/auth.mjs",
  "server/http.mjs",
  "server/titles.mjs",
];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A SemVer range such as `>=22.19.0` or `>=0.2.1-rc.5 <0.3.0`. */
export function isSemverRange(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || text.startsWith("workspace:")) return false;
  return text
    .split("||")
    .every((part) => part.trim().split(/\s+/).every((token) => RANGE_TOKEN.test(token)));
}

/** Normalized `https://github.com/<owner>/<repo>` from package.json. */
export function normalizeRepositoryUrl(pkg) {
  const raw = typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url;
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url = raw.trim().replace(/^git\+/, "");
  if (url.startsWith("github:")) url = `https://github.com/${url.slice("github:".length)}`;
  url = url.replace(/\.git$/, "").replace(/\/+$/, "");
  return /^https?:\/\//.test(url) ? url : null;
}

/** GitHub Pages index URL derived from the repository URL. */
export function deriveIndexUrl(pkg) {
  const repo = normalizeRepositoryUrl(pkg);
  const match = repo?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
  if (!match) return "https://example.com/index.json";
  return `https://${match[1]}.github.io/${match[2]}/index.json`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function rel(root, file) {
  return path.relative(root, file) || file;
}

function walkJavaScript(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full);
      } else if (/\.(?:mjs|js|cjs)$/u.test(entry.name)) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files.sort();
}

/* ------------------------------------------------------------------ */
/* Market index format 1 validator (mirrors the DSH reader rules)      */
/* ------------------------------------------------------------------ */

/** A format-1 market index violation; `path` is a JSON path such as `$.plugins[0].versions[0].version`. */
export class MarketIndexError extends Error {
  constructor(jsonPath, reason) {
    super(`${jsonPath} ${reason}`);
    this.name = "MarketIndexError";
    this.path = jsonPath;
    this.reason = reason;
  }
}

function fail(at, reason) {
  throw new MarketIndexError(at, reason);
}

function objectAt(value, at) {
  if (!isPlainObject(value)) fail(at, "must be an object");
  return value;
}

function stringAt(value, at) {
  if (typeof value !== "string" || value.trim() === "") fail(at, "must be a non-empty string");
  return value;
}

function optional(object, key, at, read) {
  return Object.hasOwn(object, key) ? read(object[key], `${at}.${key}`) : undefined;
}

function localizedText(value, at) {
  if (typeof value === "string") return stringAt(value, at);
  const object = objectAt(value, at);
  const text = {};
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${at}.${language}`, "must be keyed by a lowercase language id");
    text[language] = stringAt(member, `${at}.${language}`);
  }
  if (!Object.hasOwn(text, "en")) fail(at, "must contain en");
  return text;
}

function titleDeclarations(value, at) {
  const object = objectAt(value, at);
  const result = {};
  for (const [id, member] of Object.entries(object)) {
    if (id === "") fail(at, "must not declare an empty id");
    result[id] = { title: localizedText(objectAt(member, `${at}.${id}`).title, `${at}.${id}.title`) };
  }
  return result;
}

function sortKeyDeclarations(value, at) {
  const object = objectAt(value, at);
  const result = {};
  for (const [id, member] of Object.entries(object)) {
    if (id === "") fail(at, "must not declare an empty id");
    const entry = objectAt(member, `${at}.${id}`);
    if (entry.order !== "asc" && entry.order !== "desc") fail(`${at}.${id}.order`, 'must be "asc" or "desc"');
    result[id] = { title: localizedText(entry.title, `${at}.${id}.title`), order: entry.order };
  }
  return result;
}

function indexMetadata(value, at) {
  const object = value === undefined ? {} : objectAt(value, at);
  return {
    categories: optional(object, "categories", at, (member, memberAt) => titleDeclarations(member, memberAt)) ?? {},
    labels: optional(object, "labels", at, (member, memberAt) => titleDeclarations(member, memberAt)) ?? {},
    sortKeys: optional(object, "sortKeys", at, (member, memberAt) => sortKeyDeclarations(member, memberAt)) ?? {},
  };
}

function declaredId(value, at, declared) {
  const id = stringAt(value, at);
  if (!Object.hasOwn(declared, id)) fail(at, `references undeclared id ${JSON.stringify(id)}`);
  return id;
}

function pluginMetadata(value, at, index) {
  const object = value === undefined ? {} : objectAt(value, at);
  const category = optional(object, "category", at, (member, memberAt) => declaredId(member, memberAt, index.categories));
  const keywords =
    optional(object, "keywords", at, (member, memberAt) => {
      if (!Array.isArray(member)) fail(memberAt, "must be an array");
      return member.map((keyword, position) => stringAt(keyword, `${memberAt}[${String(position)}]`));
    }) ?? [];
  const labels =
    optional(object, "labels", at, (member, memberAt) => {
      if (!Array.isArray(member)) fail(memberAt, "must be an array");
      const ids = member.map((label, position) => declaredId(label, `${memberAt}[${String(position)}]`, index.labels));
      if (new Set(ids).size !== ids.length) fail(memberAt, "must not repeat a label");
      return ids;
    }) ?? [];
  const sortKeys =
    optional(object, "sortKeys", at, (member, memberAt) => {
      const values = {};
      for (const [id, sortValue] of Object.entries(objectAt(member, memberAt))) {
        declaredId(id, `${memberAt}.${id}`, index.sortKeys);
        if (typeof sortValue !== "number" || !Number.isFinite(sortValue)) fail(`${memberAt}.${id}`, "must be a finite number");
        values[id] = sortValue;
      }
      return values;
    }) ?? {};
  return { ...(category === undefined ? {} : { category }), keywords, labels, sortKeys };
}

function httpUrl(value, at, protocols) {
  const text = stringAt(value, at);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(at, "must be an absolute URL");
  }
  if (!protocols.includes(url.protocol)) fail(at, `must use ${protocols.join(" or ")}`);
  if (url.username !== "" || url.password !== "") fail(at, "must not contain credentials");
  return url;
}

function gitUrl(value, at) {
  const url = httpUrl(value, at, ["https:"]);
  if (url.href !== value) fail(at, "must be a canonical URL");
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(at, "must name a repository with at least two path segments");
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) fail(at, "must name a repository, not a tarball");
  return value;
}

function packagePath(value, at) {
  const text = stringAt(value, at);
  if (text.split("/").some((segment) => segment === "." || segment === ".." || !PATH_SEGMENT.test(segment))) {
    fail(at, "must be a relative directory with safe segments");
  }
  return text;
}

function repositoryValue(value, at) {
  const object = objectAt(value, at);
  const url = httpUrl(object.url, `${at}.url`, ["https:", "http:"]).href;
  const directory = optional(object, "directory", at, (member, memberAt) => packagePath(member, memberAt));
  return { url, ...(directory === undefined ? {} : { directory }) };
}

function sourceValue(value, at) {
  const object = objectAt(value, at);
  if (object.type === "npm") {
    const registry = optional(object, "registry", at, (member, memberAt) => httpUrl(member, memberAt, ["https:", "http:"]).href);
    return { type: "npm", ...(registry === undefined ? {} : { registry }) };
  }
  if (object.type === "git") {
    const commit = stringAt(object.commit, `${at}.commit`);
    if (!COMMIT.test(commit)) fail(`${at}.commit`, "must be a lowercase 40-hex-digit commit SHA");
    const packageDir = optional(object, "path", at, (member, memberAt) => packagePath(member, memberAt));
    return {
      type: "git",
      url: gitUrl(object.url, `${at}.url`),
      commit,
      ...(packageDir === undefined ? {} : { path: packageDir }),
    };
  }
  return fail(`${at}.type`, 'must be "npm" or "git"');
}

function enginesValue(value, at) {
  const object = objectAt(value, at);
  const dsh = optional(object, "dsh", at, (member, memberAt) => {
    const range = stringAt(member, memberAt);
    if (range.startsWith("workspace:")) fail(memberAt, "must not be a workspace: range");
    if (!isSemverRange(range)) fail(memberAt, "must be a SemVer range");
    return range;
  });
  return dsh === undefined ? {} : { dsh };
}

function iconValue(value, at, indexUrl) {
  const text = stringAt(value, at);
  if (text.startsWith("data:")) {
    const payload = DATA_ICON.exec(text)?.[1];
    if (payload === undefined || payload === "" || !BASE64.test(payload)) {
      fail(at, "must be a base64 SVG, PNG, JPEG, or WebP data URL");
    }
    const decoded = (payload.length / 4) * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
    if (decoded > MAX_INLINE_ICON_BYTES) fail(at, `must not exceed ${MAX_INLINE_ICON_BYTES / 1024} KiB of decoded bytes`);
    return text;
  }
  let resolved;
  try {
    resolved = new URL(text, indexUrl);
  } catch {
    fail(at, "must be a URL reference");
  }
  if (resolved.protocol !== "https:" && (resolved.origin === "null" || resolved.origin !== new URL(indexUrl).origin)) {
    fail(at, "must resolve to https or the index origin");
  }
  return resolved.href;
}

function marketVersion(value, at) {
  const object = objectAt(value, at);
  const version = stringAt(object.version, `${at}.version`);
  if (!SEMVER.test(version)) fail(`${at}.version`, "must be an exact SemVer version");
  const publishTimestamp = object.publishTimestamp;
  if (
    typeof publishTimestamp !== "number" ||
    !Number.isInteger(publishTimestamp) ||
    publishTimestamp < 0 ||
    publishTimestamp >= MAX_PUBLISH_TIMESTAMP
  ) {
    fail(`${at}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)');
  }
  return {
    version,
    publishTimestamp,
    source: sourceValue(object.source, `${at}.source`),
    engines: optional(object, "engines", at, (member, memberAt) => enginesValue(member, memberAt)) ?? {},
  };
}

function versionsValue(value, at) {
  if (!Array.isArray(value) || value.length === 0) fail(at, "must be a non-empty array");
  const seen = new Set();
  return value.map((member, position) => {
    const entryAt = `${at}[${String(position)}]`;
    const entry = marketVersion(member, entryAt);
    if (seen.has(entry.version)) fail(`${entryAt}.version`, `duplicates ${entry.version}`);
    seen.add(entry.version);
    return entry;
  });
}

function pluginValue(value, at, index, indexUrl) {
  const object = objectAt(value, at);
  const name = stringAt(object.name, `${at}.name`);
  if (name.length > 214 || !PACKAGE_NAME.test(name)) fail(`${at}.name`, "must be a valid npm package name");
  const title = optional(object, "title", at, (member, memberAt) => localizedText(member, memberAt));
  const description = optional(object, "description", at, (member, memberAt) => localizedText(member, memberAt));
  const icon = optional(object, "icon", at, (member, memberAt) => iconValue(member, memberAt, indexUrl));
  const author = optional(object, "author", at, (member, memberAt) => stringAt(member, memberAt));
  const homepage = optional(object, "homepage", at, (member, memberAt) => {
    const text = stringAt(member, memberAt);
    if (!URL.canParse(text)) fail(memberAt, "must be an absolute URL");
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") fail(memberAt, "must use https: or http:");
    return text;
  });
  const repository = optional(object, "repository", at, (member, memberAt) => repositoryValue(member, memberAt));
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repository === undefined ? {} : { repository }),
    metadata: pluginMetadata(object.metadata, `${at}.metadata`, index),
    versions: versionsValue(object.versions, `${at}.versions`),
  };
}

/**
 * Validate a parsed DSH plugin market index (format 1).
 *
 * @param {unknown} value parsed JSON document.
 * @param {string} indexUrl absolute URL the document was read from; relative
 *   icon references resolve against it.
 * @returns normalized index (relative icons resolved to absolute URLs).
 * @throws {MarketIndexError} for the first violated rule.
 */
export function validateMarketIndex(value, indexUrl) {
  if (typeof indexUrl !== "string" || !URL.canParse(indexUrl)) {
    fail("$", `index URL ${JSON.stringify(indexUrl)} must be an absolute URL`);
  }
  const base = new URL(indexUrl);
  const object = objectAt(value, "$");
  if (object.format !== 1) fail("$.format", "must be 1");
  const metadata = indexMetadata(object.metadata, "$.metadata");
  if (!Array.isArray(object.plugins)) fail("$.plugins", "must be an array");
  const names = new Set();
  const plugins = object.plugins.map((entry, position) => {
    const parsed = pluginValue(entry, `$.plugins[${String(position)}]`, metadata, base);
    if (names.has(parsed.name)) fail(`$.plugins[${String(position)}].name`, `duplicates ${parsed.name}`);
    names.add(parsed.name);
    return parsed;
  });
  const title = localizedText(object.title, "$.title");
  const description = optional(object, "description", "$", (member, memberAt) => localizedText(member, memberAt));
  return { format: 1, title, ...(description === undefined ? {} : { description }), metadata, plugins };
}

/* ------------------------------------------------------------------ */
/* Repository checks                                                   */
/* ------------------------------------------------------------------ */

function checkPackageManifest(root, pkg, problem, note, failures) {
  const before = failures.length;
  const requiredStrings = ["name", "version", "description", "license", "author", "main"];
  for (const field of requiredStrings) {
    if (typeof pkg[field] !== "string" || !pkg[field].trim()) problem(`package.json: "${field}" must be a non-empty string`);
  }
  if (typeof pkg.name === "string" && !PACKAGE_NAME.test(pkg.name)) problem(`package.json: invalid npm name "${pkg.name}"`);
  if (typeof pkg.version === "string" && !SEMVER.test(pkg.version)) problem(`package.json: version "${pkg.version}" is not exact SemVer`);
  if (pkg.license !== "MIT") problem('package.json: license must be "MIT"');
  if (typeof pkg.description === "string" && pkg.description.trim().length < 20) {
    problem("package.json: description is too short for the market index");
  }

  const patch = pkg.dsh?.bundle?.patch;
  if (typeof patch !== "string" || !patch.trim()) problem("package.json: dsh.bundle.patch must be set");
  else if (!fs.existsSync(path.join(root, patch))) problem(`package.json: dsh.bundle.patch does not exist: ${patch}`);
  const platform = pkg.dsh?.client?.platform;
  if (platform !== "web") problem('package.json: dsh.client.platform must be "web"');
  const inject = pkg.dsh?.client?.inject;
  if (!Array.isArray(inject) || inject.length === 0 || inject.some((item) => typeof item !== "string")) {
    problem("package.json: dsh.client.inject must be a non-empty string array");
  }

  if (!isSemverRange(pkg.engines?.node)) problem(`package.json: engines.node is not a SemVer range: ${String(pkg.engines?.node)}`);
  if (!isSemverRange(pkg.engines?.dsh)) problem(`package.json: engines.dsh is not a SemVer range: ${String(pkg.engines?.dsh)}`);

  for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = pkg[group];
    if (deps && typeof deps === "object" && Object.keys(deps).length > 0) {
      problem(`package.json: ${group} must stay empty (zero third-party dependencies)`);
    }
  }
  if (typeof pkg.main === "string" && !fs.existsSync(path.join(root, pkg.main))) {
    problem(`package.json: main does not exist: ${pkg.main}`);
  }
  const rootExport = pkg.exports?.["."];
  const rootExportFile = typeof rootExport === "string" ? rootExport : rootExport?.default;
  if (typeof rootExportFile === "string" && !fs.existsSync(path.join(root, rootExportFile))) {
    problem(`package.json: exports["."] does not exist: ${rootExportFile}`);
  }
  if (pkg.icon && !fs.existsSync(path.join(root, pkg.icon))) problem(`package.json: icon does not exist: ${pkg.icon}`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) problem("package.json: files must be a non-empty array");

  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  if (typeof scripts.test !== "string" || !scripts.test.includes("node --test")) problem('package.json: scripts.test must run "node --test"');
  if (typeof scripts.validate !== "string" || !scripts.validate.includes("scripts/validate.mjs")) {
    problem("package.json: scripts.validate must run scripts/validate.mjs");
  }
  if (typeof scripts["check:privacy"] !== "string" || !scripts["check:privacy"].includes("scripts/check-privacy.mjs")) {
    problem('package.json: scripts["check:privacy"] must run scripts/check-privacy.mjs');
  }
  if (typeof scripts["check:docs"] !== "string" || !scripts["check:docs"].includes("scripts/check-docs.mjs")) {
    problem('package.json: scripts["check:docs"] must run scripts/check-docs.mjs');
  }
  if (typeof scripts["check:version"] !== "string" || !scripts["check:version"].includes("scripts/check-version.mjs")) {
    problem('package.json: scripts["check:version"] must run scripts/check-version.mjs');
  }
  if (typeof scripts.check !== "string" || !scripts.check.includes("check:docs") || !scripts.check.includes("check:version")) {
    problem('package.json: scripts.check must run the docs, version and existing checks');
  }

  if (failures.length === before) note("package.json manifest");
}

function checkFileList(root, pkg, problem, note, failures) {
  const before = failures.length;
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  for (const entry of files) {
    const target = path.join(root, String(entry).replace(/\/+$/, ""));
    if (!fs.existsSync(target)) problem(`package.json files: missing "${entry}"`);
  }
  for (const required of ["index.mjs", "client.js", "cordis.patch.yml", "server/", "icon.svg", "CHANGELOG.md"]) {
    if (!files.includes(required)) problem(`package.json files: "${required}" must be listed so it ships on npm`);
  }
  if (failures.length === before) note(`package files (${files.length} entries)`);
}

function checkRequiredFiles(root, problem, note, failures) {
  const before = failures.length;
  for (const file of [...REQUIRED_FILES, ...REQUIRED_SERVER_FILES]) {
    if (!fs.existsSync(path.join(root, file))) problem(`missing required repository file: ${file}`);
  }
  if (failures.length === before) note(`repository files (${REQUIRED_FILES.length + REQUIRED_SERVER_FILES.length})`);
}

function checkCordisPatch(root, pkg, problem, note, failures) {
  const before = failures.length;
  const patchPath = pkg.dsh?.bundle?.patch;
  if (typeof patchPath !== "string" || !fs.existsSync(path.join(root, patchPath))) {
    problem(`cordis patch is missing or not declared: ${String(patchPath)}`);
    return;
  }
  const source = fs.readFileSync(path.join(root, patchPath), "utf8");
  if (source.includes("\t")) problem(`${patchPath}: must use spaces, not tabs`);
  if (!/^\s*-\s+insert:\s*$/mu.test(source)) problem(`${patchPath}: missing "- insert:" mapping`);
  if (!/^\s+-\s+id:\s*\S+/mu.test(source)) problem(`${patchPath}: missing "- id:" entry`);
  if (!/^\s+name:\s*["']?dsh-super-kanban["']?\s*$/mu.test(source)) {
    problem(`${patchPath}: must reference bundle name "dsh-super-kanban"`);
  }
  // `config:` is optional by design: the plugin reads its settings from the board
  // state, not from Cordis config, so a patch-level config would be dead config.
  // When present it must still be a YAML mapping (not a scalar/list) so a future
  // deliberate config block cannot silently degrade.
  const configMatch = /^\s*config:\s*$/mu.exec(source);
  if (configMatch) {
    const configLine = source.slice(0, configMatch.index).split("\n").length;
    const nextLine = source.split("\n").slice(configLine).find((line) => line.trim() !== "");
    if (nextLine === undefined || !/^\s+\S/.test(nextLine) || /^\s+-\s/.test(nextLine)) {
      problem(`${patchPath}: "config:" must be a YAML mapping when present`);
    }
  }
  if (failures.length === before) note(`cordis patch structure (${patchPath})`);
}

function checkSyntax(root, problem, note, failures) {
  const before = failures.length;
  const files = walkJavaScript(root);
  if (files.length === 0) problem("no JavaScript files found to syntax-check");
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 30_000 });
    if (result.error) problem(`node --check failed for ${rel(root, file)}: ${result.error.message}`);
    else if (result.status !== 0) {
      const message = String(result.stderr || result.stdout || "syntax error").trim().split("\n").slice(-1)[0];
      problem(`node --check failed for ${rel(root, file)}: ${message}`);
    }
  }
  if (failures.length === before) note(`JavaScript syntax (${files.length} files)`);
}

function checkMarketIndex(root, pkg, problem, warn, note, failures) {
  const before = failures.length;
  const file = path.join(root, MARKET_INDEX_PATH);
  if (!fs.existsSync(file)) {
    warn(`${MARKET_INDEX_PATH} is not generated yet; run "npm run market:index" before releasing`);
    return;
  }
  let index;
  try {
    index = readJson(file);
  } catch (error) {
    problem(`${MARKET_INDEX_PATH}: invalid JSON: ${error.message}`);
    return;
  }
  const indexUrl = deriveIndexUrl(pkg);
  try {
    validateMarketIndex(index, indexUrl);
  } catch (error) {
    if (error instanceof MarketIndexError) problem(`${MARKET_INDEX_PATH}: ${error.message}`);
    else problem(`${MARKET_INDEX_PATH}: ${error?.message || error}`);
    return;
  }
  const entry = index.plugins?.find((plugin) => plugin.name === pkg.name);
  if (!entry) {
    problem(`${MARKET_INDEX_PATH}: does not list plugin "${pkg.name}"`);
  } else {
    const version = entry.versions?.[0]?.version ?? entry.versions?.[entry.versions.length - 1]?.version;
    if (version !== pkg.version) {
      problem(`${MARKET_INDEX_PATH}: latest version ${String(version)} does not match package.json ${pkg.version}; run "npm run market:index"`);
    }
    const dshRange = entry.versions?.[0]?.engines?.dsh;
    if (dshRange !== pkg.engines?.dsh) {
      problem(`${MARKET_INDEX_PATH}: engines.dsh ${String(dshRange)} does not match package.json ${String(pkg.engines?.dsh)}`);
    }
    const iconFile = path.join(root, "docs", "icon.svg");
    if (!fs.existsSync(iconFile)) problem(`${MARKET_INDEX_PATH}: docs/icon.svg is missing (needed to resolve the icon URL)`);
  }
  if (failures.length === before) note(`${MARKET_INDEX_PATH} format 1`);
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/**
 * Run every repository check.
 * @param {{root?: string}} [options]
 * @returns {{ok: boolean, checks: string[], warnings: string[], failures: string[]}}
 */
export function runValidate({ root = ROOT } = {}) {
  const checks = [];
  const warnings = [];
  const failures = [];
  const problem = (message) => failures.push(message);
  const warn = (message) => warnings.push(message);
  const note = (name) => checks.push(name);
  let pkg = null;
  try {
    pkg = readJson(path.join(root, "package.json"));
  } catch (error) {
    problem(`package.json: cannot be read: ${error.message}`);
  }
  checkRequiredFiles(root, problem, note, failures);
  if (pkg) {
    checkPackageManifest(root, pkg, problem, note, failures);
    checkFileList(root, pkg, problem, note, failures);
    checkCordisPatch(root, pkg, problem, note, failures);
    checkSyntax(root, problem, note, failures);
    checkMarketIndex(root, pkg, problem, warn, note, failures);
  }
  return { ok: failures.length === 0, checks, warnings, failures };
}

function printResult(result) {
  for (const check of result.checks) console.log(`✓ ${check}`);
  for (const warning of result.warnings) console.warn(`⚠ ${warning}`);
  if (!result.ok) {
    console.error("");
    for (const failure of result.failures) console.error(`✗ ${failure}`);
    console.error(`\nvalidate failed (${result.failures.length} problem${result.failures.length === 1 ? "" : "s"})`);
    return 1;
  }
  console.log(`\nvalidate passed (${result.checks.length} checks, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})`);
  return 0;
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg.startsWith("--root=")) options.root = path.resolve(arg.slice("--root=".length));
    else return { unknown: arg };
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/validate.mjs [--root=<repo>]");
    return 0;
  }
  if (options.unknown) {
    console.error(`validate: unknown argument ${options.unknown}`);
    return 2;
  }
  return printResult(runValidate({ root: options.root ?? ROOT }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
