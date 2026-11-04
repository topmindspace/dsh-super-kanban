import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

test("package.json has the expected npm and DSH identity", () => {
  assert.equal(pkg.name, "dsh-super-kanban");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.author, "topmindspace");
  assert.ok(pkg.description.length >= 20);
  assert.equal(pkg.publishConfig?.access, "public");
  assert.equal(pkg.repository?.url, "git+https://github.com/topmindspace/dsh-super-kanban.git");
  assert.equal(pkg.homepage, "https://github.com/topmindspace/dsh-super-kanban#readme");
});

test("package.json declares the DSH host and client halves", () => {
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.equal(pkg.dsh?.client?.platform, "web");
  assert.deepEqual(pkg.dsh?.client?.inject, [
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-layout",
    "@deepseek-ai/dsh-client-ui-sidebar",
    "@deepseek-ai/dsh-client-ui-workspace",
  ]);
});

test("package.json engines are valid SemVer ranges", () => {
  assert.match(pkg.engines?.dsh ?? "", /^[<>]=?\d+\.\d+\.\d+/);
  assert.match(pkg.engines?.node ?? "", /^[<>]=?\d+\.\d+\.\d+/);
  assert.equal(pkg.engines?.dsh, ">=0.2.1-rc.5 <0.3.0");
  assert.equal(pkg.engines?.node, ">=22.19.0");
});

test("the package is zero-dependency", () => {
  for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(pkg[group], undefined, `${group} must not be declared`);
  }
});

test("package.json files list ships the plugin halves", () => {
  for (const entry of ["index.mjs", "client.js", "cordis.patch.yml", "server/", "icon.svg", "CHANGELOG.md"]) {
    assert.ok(pkg.files.includes(entry), `files must include ${entry}`);
  }
});

test("package.json scripts run the local quality gates", () => {
  assert.match(pkg.scripts.test, /node --test/);
  assert.match(pkg.scripts.validate, /scripts\/validate\.mjs/);
  assert.match(pkg.scripts["check:privacy"], /scripts\/check-privacy\.mjs/);
  assert.match(pkg.scripts["market:index"], /scripts\/build-market-index\.mjs/);
  assert.match(pkg.scripts.prepublishOnly, /npm test/);
  assert.match(pkg.scripts.prepublishOnly, /validate/);
  assert.match(pkg.scripts.prepublishOnly, /check:privacy/);
});

test("the host, client and bundle files exist", () => {
  for (const file of [
    "index.mjs",
    "client.js",
    "cordis.patch.yml",
    "icon.svg",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "install.sh",
    "uninstall.sh",
    "docs/icon.svg",
    "server/service.mjs",
    "server/sessions.mjs",
    "server/analyzer-rules.mjs",
    "server/analyzer-llm.mjs",
    "server/store.mjs",
    "scripts/validate.mjs",
    "scripts/check-privacy.mjs",
    "scripts/build-market-index.mjs",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]) {
    assert.ok(exists(file), `missing required file: ${file}`);
  }
});

test("LICENSE is MIT with the expected copyright line", () => {
  const license = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 TopMindSpace/);
});

test("CHANGELOG follows Keep a Changelog and documents 0.3.0", () => {
  const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /# Changelog/);
  assert.match(changelog, /Keep a Changelog/);
  assert.match(changelog, /\[0\.3\.0\]/);
  assert.match(changelog, /Automatic task analysis/);
});

test("public collaboration documents exist", () => {
  for (const file of ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", ".editorconfig", ".gitattributes"]) {
    assert.ok(exists(file), `missing collaboration file: ${file}`);
  }
  const security = fs.readFileSync(path.join(ROOT, "SECURITY.md"), "utf8");
  assert.match(security, /security\/advisories\/new/);
  assert.match(security, /storages\/super-kanban/);
});

test("the Cordis patch targets this bundle", () => {
  const patch = fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8");
  assert.match(patch, /insert:/);
  assert.match(patch, /dsh-super-kanban/);
  assert.ok(!patch.includes("\t"), "cordis.patch.yml must use spaces");
});
