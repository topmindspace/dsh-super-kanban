import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMarketIndex, compareSemver, readPackage, syncIcon } from "../scripts/build-market-index.mjs";
import { MarketIndexError, deriveIndexUrl, normalizeRepositoryUrl, validateMarketIndex } from "../scripts/validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_URL = "https://topmindspace.github.io/dsh-super-kanban/index.json";
const COMMIT_A = "0123456789abcdef0123456789abcdef01234567";
const COMMIT_B = "fedcba9876543210fedcba9876543210fedcba98";

const pkg = readPackage(ROOT);

function clone(value) {
  return structuredClone(value);
}

test("repository metadata normalizes to a canonical URL", () => {
  assert.equal(normalizeRepositoryUrl(pkg), "https://github.com/topmindspace/dsh-super-kanban");
  assert.equal(deriveIndexUrl(pkg), INDEX_URL);
});

test("buildMarketIndex produces a valid git-source format-1 index", () => {
  const index = buildMarketIndex({ pkg, source: "git", commit: COMMIT_A, publishTimestamp: 1_700_000_000 });
  const validated = validateMarketIndex(index, INDEX_URL);
  assert.equal(validated.format, 1);
  assert.equal(validated.title.en, "TopMindSpace DSH plugins");
  assert.equal(validated.title.zh, "TopMindSpace DSH 插件索引");
  const plugin = validated.plugins[0];
  assert.equal(plugin.name, "dsh-super-kanban");
  assert.equal(plugin.title.en, "Super Kanban");
  assert.equal(plugin.title.zh, "Super Kanban 任务看板");
  assert.equal(plugin.description.en, pkg.description);
  assert.ok(plugin.description.zh.length > 20);
  assert.equal(plugin.icon, "https://topmindspace.github.io/dsh-super-kanban/icon.svg");
  assert.equal(plugin.metadata.category, "productivity");
  assert.deepEqual(plugin.metadata.labels, ["kanban", "ai"]);
  assert.equal(plugin.repository.url, "https://github.com/topmindspace/dsh-super-kanban");
  assert.equal(plugin.versions.length, 1);
  assert.deepEqual(plugin.versions[0].source, {
    type: "git",
    url: "https://github.com/topmindspace/dsh-super-kanban",
    commit: COMMIT_A,
  });
  assert.equal(plugin.versions[0].publishTimestamp, 1_700_000_000);
  assert.equal(plugin.versions[0].engines.dsh, pkg.engines.dsh);
});

test("buildMarketIndex supports the npm source without a commit", () => {
  const index = buildMarketIndex({ pkg, source: "npm", publishTimestamp: 1_700_000_001 });
  const validated = validateMarketIndex(index, INDEX_URL);
  assert.deepEqual(validated.plugins[0].versions[0].source, { type: "npm" });
  assert.deepEqual(validated.plugins[0].versions[0].engines, { dsh: pkg.engines.dsh });
});

test("buildMarketIndex keeps older versions from a previous index", () => {
  const oldPkg = { ...pkg, version: "0.2.0" };
  const previous = buildMarketIndex({ pkg: oldPkg, source: "git", commit: COMMIT_B, publishTimestamp: 1_690_000_000 });
  const index = buildMarketIndex({ pkg, source: "git", commit: COMMIT_A, publishTimestamp: 1_700_000_000, previous });
  const validated = validateMarketIndex(index, INDEX_URL);
  // Derive the expected order from the current package version so a version
  // bump never leaves a stale expectation behind.
  assert.deepEqual(
    validated.plugins[0].versions.map((entry) => entry.version),
    [pkg.version, oldPkg.version],
  );
});

test("buildMarketIndex reuses the previous timestamp when nothing changed", () => {
  const first = buildMarketIndex({ pkg, source: "git", commit: COMMIT_A, publishTimestamp: 1_700_000_000 });
  const second = buildMarketIndex({ pkg, source: "git", commit: COMMIT_A, previous: first });
  assert.equal(second.plugins[0].versions[0].publishTimestamp, 1_700_000_000);
  const movedCommit = buildMarketIndex({ pkg, source: "git", commit: COMMIT_B, previous: first });
  assert.notEqual(movedCommit.plugins[0].versions[0].publishTimestamp, 1_700_000_000);
});

test("buildMarketIndex replaces the same version instead of duplicating it", () => {
  const previous = buildMarketIndex({ pkg, source: "git", commit: COMMIT_B, publishTimestamp: 1_690_000_000 });
  const index = buildMarketIndex({ pkg, source: "git", commit: COMMIT_A, publishTimestamp: 1_700_000_000, previous });
  const validated = validateMarketIndex(index, INDEX_URL);
  assert.equal(validated.plugins[0].versions.length, 1);
  assert.equal(validated.plugins[0].versions[0].source.commit, COMMIT_A);
});

test("buildMarketIndex rejects invalid inputs", () => {
  assert.throws(() => buildMarketIndex({ pkg, source: "git", commit: "abc", publishTimestamp: 1 }), /40-hex/);
  assert.throws(() => buildMarketIndex({ pkg, source: "ftp", commit: COMMIT_A, publishTimestamp: 1 }), /unknown source/);
  assert.throws(() => buildMarketIndex({ pkg, source: "git", commit: COMMIT_A, publishTimestamp: -1 }), /publishTimestamp/);
  assert.throws(() => buildMarketIndex({ pkg: null }), /package\.json/);
  assert.throws(
    () => buildMarketIndex({ pkg: { ...pkg, repository: undefined }, source: "git", commit: COMMIT_A, publishTimestamp: 1 }),
    /repository URL/,
  );
});

test("compareSemver orders versions for the index", () => {
  assert.ok(compareSemver("0.3.0", "0.2.0") > 0);
  assert.ok(compareSemver("0.2.0", "0.3.0") < 0);
  assert.ok(compareSemver("0.3.0", "0.3.0-rc.1") > 0);
  assert.ok(compareSemver("0.2.1-rc.5", "0.2.1-rc.4") > 0);
  assert.equal(compareSemver("0.3.0", "0.3.0"), 0);
});

test("validateMarketIndex rejects malformed documents", () => {
  const valid = buildMarketIndex({ pkg, source: "git", commit: COMMIT_A, publishTimestamp: 1 });
  const expectInvalid = (mutate, pattern) => {
    const broken = clone(valid);
    mutate(broken);
    assert.throws(() => validateMarketIndex(broken, INDEX_URL), pattern);
  };
  expectInvalid((index) => (index.format = 2), /must be 1/);
  expectInvalid((index) => delete index.title.en, /must contain en/);
  expectInvalid((index) => (index.plugins[0].versions[0].version = "latest"), /exact SemVer/);
  expectInvalid((index) => (index.plugins[0].versions[0].publishTimestamp = -5), /publishTimestamp/);
  expectInvalid((index) => (index.plugins[0].versions[0].source.commit = "ABC"), /40-hex/);
  expectInvalid((index) => (index.plugins[0].metadata.category = "unknown"), /undeclared id/);
  expectInvalid((index) => (index.plugins[0].metadata.labels = ["kanban", "kanban"]), /repeat a label/);
  expectInvalid((index) => index.plugins[0].versions.push(clone(index.plugins[0].versions[0])), /duplicates/);
  expectInvalid((index) => (index.plugins[0].versions[0].engines.dsh = "workspace:*"), /workspace/);
  expectInvalid((index) => (index.plugins[0].icon = "javascript:alert(1)"), /URL reference|https/);
  expectInvalid((index) => (index.plugins[0].name = "Bad Name"), /valid npm package name/);
  expectInvalid((index) => (index.plugins[0].versions = []), /non-empty/);
});

test("validateMarketIndex rejects duplicate plugin names and non-object documents", () => {
  const valid = buildMarketIndex({ pkg, source: "git", commit: COMMIT_A, publishTimestamp: 1 });
  const duplicated = clone(valid);
  duplicated.plugins.push(clone(duplicated.plugins[0]));
  assert.throws(() => validateMarketIndex(duplicated, INDEX_URL), /duplicates/);
  assert.throws(() => validateMarketIndex(null, INDEX_URL), /must be an object/);
  assert.throws(() => validateMarketIndex(valid, "not a url"), /absolute URL/);
  assert.ok(new MarketIndexError("$.format", "must be 1") instanceof Error);
});

test("the committed docs/index.json is valid format 1 when present", (context) => {
  const file = path.join(ROOT, "docs", "index.json");
  if (!fs.existsSync(file)) {
    context.skip("docs/index.json has not been generated yet (run npm run market:index)");
    return;
  }
  const index = JSON.parse(fs.readFileSync(file, "utf8"));
  const validated = validateMarketIndex(index, deriveIndexUrl(pkg));
  const plugin = validated.plugins.find((entry) => entry.name === pkg.name);
  assert.ok(plugin, "index must list this plugin");
  assert.ok(
    plugin.versions.some((entry) => entry.version === pkg.version),
    `index must include the current version ${pkg.version}`,
  );
  assert.equal(plugin.repository.url, "https://github.com/topmindspace/dsh-super-kanban");
  assert.ok(fs.existsSync(path.join(ROOT, "docs", "icon.svg")), "docs/icon.svg must accompany the index");
});

test("syncIcon keeps docs/icon.svg identical to the root icon", () => {
  const changed = syncIcon(ROOT);
  assert.equal(typeof changed, "boolean");
  assert.equal(
    fs.readFileSync(path.join(ROOT, "docs", "icon.svg"), "utf8"),
    fs.readFileSync(path.join(ROOT, "icon.svg"), "utf8"),
  );
});
