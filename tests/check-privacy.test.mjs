import test from "node:test";
import assert from "node:assert/strict";

import { CONTENT_RULES, checkFilePath, scanText } from "../scripts/check-privacy.mjs";

/**
 * The forbidden samples are assembled from fragments exactly like the scanner's
 * own rule patterns, so this test file stays clean under `check-privacy`.
 */
const HOME = "/Use" + "rs/";
const USER = "pa" + "nd";
const NAME = String.fromCharCode(0x6f58, 0x4e01);
const UUID = "00000000-0000-4000-8000-" + "000000000000";
const SESSION = "sess" + "ion-" + "12345678-1234-4321-8765-" + "123456789abc";

const rules = (text) => scanText(text).map((finding) => finding.rule);

test("clean text produces no findings", () => {
  assert.deepEqual(scanText("Super Kanban reads sessions locally and writes no telemetry.", { file: "README.md" }), []);
  assert.deepEqual(rules("Node.js >= 22.19.0, npm package dsh-super-kanban@0.3.0"), []);
  assert.deepEqual(rules("The quick brown fox jumps over the lazy dog."), []);
});

test("absolute home directories are reported", () => {
  const findings = scanText(`cd ${HOME}alice/dev/super-kanban`, { file: "docs/INSTALL.md" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "absolute-home-path");
  assert.equal(findings[0].file, "docs/INSTALL.md");
  assert.equal(findings[0].line, 1);
});

test("personal names and machine account names are reported", () => {
  assert.deepEqual(rules(`作者是${NAME}`), ["personal-name"]);
  assert.deepEqual(rules(`logged in as ${USER} on the workstation`), ["known-username"]);
});

test("real session ids are reported and the syntactic all-zero id is allowed", () => {
  const findings = rules(`session ${SESSION} produced the task`);
  assert.ok(findings.includes("session-id"));
  assert.ok(findings.includes("uuid"));
  assert.deepEqual(rules(`fixture id ${UUID}`), []);
});

test("credential material is reported", () => {
  assert.ok(rules(`token: ${"gh" + "o_"}${"a".repeat(30)}`).includes("github-token"));
  assert.ok(rules(`${"git" + "hub_" + "pat_"}${"b".repeat(30)}`).includes("github-fine-grained-token"));
  assert.ok(rules(`api_key=${"s" + "k-"}${"c".repeat(30)}`).includes("api-key"));
  assert.ok(rules(`${"np" + "m_"}${"d".repeat(36)}`).includes("npm-token"));
  assert.ok(rules(`${"AK" + "IA"}${"E".repeat(16)}`).includes("aws-access-key"));
  assert.ok(rules(`${"xox" + "b-"}${"1".repeat(12)}`).includes("slack-token"));
  assert.ok(rules(`${"-----BEGIN " + "PRIVATE KEY-----"}`).includes("private-key"));
  assert.ok(rules(`token=othervalue`).length === 0);
});

test("email addresses are reported unless on the placeholder allowlist", () => {
  assert.deepEqual(rules("contact security@topmindspace.dev"), []);
  assert.deepEqual(rules("contact dev@example.com"), []);
  assert.deepEqual(rules("contact " + "someone@" + "real-company" + ".example"), ["email-address"]);
});

test("internal QA temp paths are reported but generic temp examples are not", () => {
  assert.deepEqual(rules("screenshot saved to /tm" + "p/qa-board.png"), ["temporary-path"]);
  assert.deepEqual(rules("url file /tm" + "p/dsh-test-url.txt"), ["temporary-path"]);
  assert.deepEqual(rules("screenshot /tm" + "p/ui-shot.png"), ["temporary-path"]);
  assert.deepEqual(rules("DSH_HOME=/tm" + "p/x ./install.sh -y"), []);
  assert.deepEqual(rules("DSH_HOME=/tm" + "p/dsh-dev ./install.sh -y"), []);
  assert.deepEqual(rules("DSH_HOME=$HOME/.dsh-dev npm test"), []);
});

test("line numbers point at the offending line", () => {
  const text = ["line one", "line two", `cd ${HOME}bob/tools`, "line four"].join("\n");
  const [finding] = scanText(text);
  assert.equal(finding.line, 3);
  assert.equal(finding.snippet.includes(HOME), false, "snippets must be redacted");
});

test("snippets never echo the matched secret", () => {
  const secret = `${"gh" + "o_"}${"z".repeat(30)}`;
  const [finding] = scanText(`GITHUB_TOKEN=${secret}`);
  assert.equal(finding.rule, "github-token");
  assert.equal(finding.snippet.includes(secret), false);
  assert.ok(finding.snippet.includes("[redacted]"));
});

test("credential and environment files are rejected by path", () => {
  assert.deepEqual(checkFilePath("docs/.cred" + "entials.yaml").map((finding) => finding.rule), ["credentials-file"]);
  assert.deepEqual(checkFilePath(".e" + "nv").map((finding) => finding.rule), ["env-file"]);
  assert.deepEqual(checkFilePath(".e" + "nv.local").map((finding) => finding.rule), ["env-file"]);
  assert.deepEqual(checkFilePath("docs/INSTALL.md"), []);
});

test("every content rule is reachable and has a unique id", () => {
  const ids = CONTENT_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("absolute-home-path"));
  assert.ok(ids.includes("session-id"));
  assert.ok(ids.includes("github-token"));
});
