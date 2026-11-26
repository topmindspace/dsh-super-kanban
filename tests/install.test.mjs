import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const posix = { skip: process.platform === "win32" };

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, "profiles", "test");
  fs.mkdirSync(profile, { recursive: true });
  return {
    pkg: path.join(profile, "package.json"),
    backup: path.join(profile, "super-kanban-profile-backup.json"),
    module: path.join(profile, "node_modules", "dsh-super-kanban"),
    run(script) {
      return spawnSync("bash", [path.join(root, script), "-y"], {
        encoding: "utf8", env: { ...process.env, DSH_HOME: home, DSH_PROFILE: "test" },
      });
    },
  };
}

test("install and uninstall are idempotent and preserve other profile entries", posix, (t) => {
  const { pkg, backup, module, run } = fixture(t);
  const original = { dependencies: { other: "1.0.0" }, dsh: { profile: { bundles: ["other"] } } };
  const originalText = JSON.stringify(original);
  const realManifest = path.join(path.dirname(pkg), "manifest.json");
  fs.writeFileSync(realManifest, originalText);
  fs.symlinkSync(path.basename(realManifest), pkg);
  for (let i = 0; i < 2; i++) {
    const result = run("install.sh");
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fs.realpathSync(module), fs.realpathSync(root));
  assert.equal(fs.readFileSync(backup, "utf8"), originalText);
  const installed = JSON.parse(fs.readFileSync(pkg, "utf8"));
  assert.deepEqual(installed.dsh.profile.bundles, ["other", "dsh-super-kanban"]);
  installed.dsh.profile.bundles.push("dsh-super-kanban", "later");
  installed.dependencies.later = "2.0.0";
  fs.writeFileSync(pkg, JSON.stringify(installed));
  for (let i = 0; i < 2; i++) {
    const result = run("uninstall.sh");
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(pkg, "utf8")), {
    dependencies: { other: "1.0.0", later: "2.0.0" }, dsh: { profile: { bundles: ["other", "later"] } },
  });
  assert.equal(fs.existsSync(module), false);
  assert.equal(fs.readlinkSync(pkg), path.basename(realManifest));
  assert.equal(fs.readFileSync(backup, "utf8"), originalText);
});

test("failed install leaves a malformed profile untouched and creates no plugin link", posix, (t) => {
  const { pkg, module, backup, run } = fixture(t);
  const original = '{"dsh":{"profile":{"bundles":{}}}}';
  fs.writeFileSync(pkg, original);
  assert.notEqual(run("install.sh").status, 0);
  assert.equal(fs.readFileSync(pkg, "utf8"), original);
  assert.equal(fs.existsSync(module), false);
  assert.equal(fs.existsSync(backup), false);
});
