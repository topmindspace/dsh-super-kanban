/**
 * Unit tests for the LLM analyzer's pure helpers (no network, no credentials
 * beyond a synthetic fixture file): token extraction and JSON repair/extraction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractJsonObject, readAccountToken } from "../server/analyzer-llm.mjs";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-llm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeCredentials(home, text) {
  fs.writeFileSync(path.join(home, ".credentials.yaml"), text);
}

test("readAccountToken reads the deepseek account token without other records", (t) => {
  const home = tempHome(t);
  writeCredentials(
    home,
    [
      "records:",
      "  other-provider/default:",
      "    token: wrong-token",
      "  deepseek-account-platform/default:",
      "    payload:",
      '      token: "synthetic-test-token"',
      "  another-provider/default:",
      "    token: also-wrong",
      "",
    ].join("\n"),
  );
  assert.equal(readAccountToken(home), "synthetic-test-token");
});

test("readAccountToken returns null for missing files, missing markers and missing token", (t) => {
  const home = tempHome(t);
  assert.equal(readAccountToken(home), null);
  writeCredentials(home, "records:\n  unrelated:\n    token: nope\n");
  assert.equal(readAccountToken(home), null);
  writeCredentials(home, "records:\n  deepseek-account-platform/default:\n    payload:\n      other: value\n");
  assert.equal(readAccountToken(home), null);
});

test("extractJsonObject parses plain, fenced and embedded JSON objects", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('here you go:\n{"a":{"b":[1,2]}}\nthanks'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJsonObject('```json\n{"tasks":[]}\n```'), { tasks: [] });
  assert.deepEqual(extractJsonObject('{"a":"contains } brace"}'), { a: "contains } brace" });
});

test("extractJsonObject repairs the common model JSON mistakes", () => {
  assert.deepEqual(extractJsonObject('{"seq=917"}'), { seq: 917 });
  assert.deepEqual(extractJsonObject('{"tasks":[{"seq":917"}]}'), { tasks: [{ seq: 917 }] });
  assert.deepEqual(extractJsonObject('{"a":1,}'), { a: 1 });
});

test("extractJsonObject returns null when no object can be recovered", () => {
  assert.equal(extractJsonObject(null), null);
  assert.equal(extractJsonObject(42), null);
  assert.equal(extractJsonObject(""), null);
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject("{unclosed"), null);
  assert.equal(extractJsonObject('{"a": '), null);
});

test("extractJsonObject finds the first balanced object in noisy output", () => {
  const text = 'Sure. {"tasks":[{"title":"x","nested":{"a":1}}],"ignore":false} trailing } noise';
  const parsed = extractJsonObject(text);
  assert.equal(parsed.ignore, false);
  assert.equal(parsed.tasks[0].nested.a, 1);
});
