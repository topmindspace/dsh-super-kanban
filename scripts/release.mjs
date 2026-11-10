#!/usr/bin/env node
/**
 * Super Kanban — local release helper.
 *
 * Run from a clean checkout on the release branch. The helper:
 *   1. refuses to run on a dirty worktree,
 *   2. runs the test suite, the repository validator and the privacy scan,
 *   3. regenerates the plugin-market index for the current commit,
 *   4. prints the exact tag/push commands that trigger the release workflow.
 *
 * It never publishes to npm itself: `release.yml` does that from the pushed
 * `v*` tag with provenance. Zero third-party dependencies.
 *
 * Usage:
 *   node scripts/release.mjs [--dry-run] [--root=<repo>]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { root: ROOT, dryRun: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--root=")) options.root = path.resolve(arg.slice("--root=".length));
    else return { unknown: arg };
  }
  return options;
}

function run(command, args, { cwd, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const output = capture ? `${result.stdout || ""}${result.stderr || ""}`.trim() : "";
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}${output ? `\n${output}` : ""}`);
  }
  return result;
}

/** Refuse to release from a dirty working tree. */
export function checkCleanWorktree(root) {
  const status = run("git", ["status", "--porcelain"], { cwd: root, capture: true }).stdout.trim();
  if (status) {
    throw new Error(`working tree is not clean:\n${status}\nCommit or stash your changes first.`);
  }
}

/** The steps that must pass before tagging. */
export function runChecks(root) {
  run("npm", ["test"], { cwd: root });
  run("npm", ["run", "validate"], { cwd: root });
  run("npm", ["run", "check:privacy"], { cwd: root });
  run("npm", ["run", "check:docs"], { cwd: root });
  run("npm", ["run", "check:version"], { cwd: root });
}

function readVersion(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return String(pkg.version);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/release.mjs [--dry-run] [--root=<repo>]");
    return 0;
  }
  if (options.unknown) {
    console.error(`release: unknown argument ${options.unknown}`);
    return 2;
  }
  const root = options.root;
  try {
    const version = readVersion(root);
    console.log(`Super Kanban release helper — v${version}`);
    checkCleanWorktree(root);
    console.log(`✓ working tree is clean`);

    // Regenerate the market index before running the checks: check:version
    // requires the committed index to list the package.json version, and the
    // index can only pin its git source once the version commit exists.
    console.log("\nUpdating the plugin-market index...");
    if (options.dryRun) run(process.execPath, ["scripts/build-market-index.mjs", "--check"], { cwd: root });
    else run(process.execPath, ["scripts/build-market-index.mjs"], { cwd: root });

    console.log("\nRunning checks (this can take a minute)...");
    runChecks(root);
    console.log("✓ tests, validator, privacy, docs and version checks passed");

    const changed = run("git", ["status", "--porcelain", "docs/index.json", "docs/icon.svg"], { cwd: root, capture: true })
      .stdout.trim();
    console.log("\nNext steps:");
    if (changed) {
      console.log(`  git add docs/index.json docs/icon.svg`);
      console.log(`  git commit -m "chore: refresh market index for v${version}"`);
    }
    console.log(`  git tag -a v${version} -m "v${version}"`);
    console.log(`  git push --atomic origin HEAD:refs/heads/main refs/tags/v${version}`);
    console.log("\nPushing the tag runs .github/workflows/release.yml: it re-runs the");
    console.log("checks, publishes to npm with provenance and creates the GitHub Release.");
    console.log("NPM_TOKEN must be configured as a repository secret.");
    return 0;
  } catch (error) {
    console.error(`\n✗ release aborted: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
