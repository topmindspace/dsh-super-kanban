import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS, normalizeSettingsPatch, rolloverUsage, todayKey } from "../server/store.mjs";

test("normalizeSettingsPatch ignores non-object input", () => {
  assert.deepEqual(normalizeSettingsPatch(null), {});
  assert.deepEqual(normalizeSettingsPatch(undefined), {});
  assert.deepEqual(normalizeSettingsPatch("nope"), {});
  assert.deepEqual(normalizeSettingsPatch(42), {});
  assert.deepEqual(normalizeSettingsPatch([]), {});
});

test("normalizeSettingsPatch keeps valid booleans only", () => {
  assert.deepEqual(normalizeSettingsPatch({ autoScan: false, aiEnabled: true }), { autoScan: false, aiEnabled: true });
  assert.deepEqual(normalizeSettingsPatch({ autoScan: "false", aiEnabled: 1 }), {});
});

test("normalizeSettingsPatch clamps scanIntervalSeconds to 30..3600", () => {
  assert.equal(normalizeSettingsPatch({ scanIntervalSeconds: 5 }).scanIntervalSeconds, 30);
  assert.equal(normalizeSettingsPatch({ scanIntervalSeconds: 99999 }).scanIntervalSeconds, 3600);
  assert.equal(normalizeSettingsPatch({ scanIntervalSeconds: 120 }).scanIntervalSeconds, 120);
  assert.equal(normalizeSettingsPatch({ scanIntervalSeconds: "90" }).scanIntervalSeconds, 90);
  assert.equal(normalizeSettingsPatch({ scanIntervalSeconds: 90.4 }).scanIntervalSeconds, 90);
  assert.equal(normalizeSettingsPatch({ scanIntervalSeconds: "nope" }).scanIntervalSeconds, undefined);
});

test("normalizeSettingsPatch clamps initialDays to 1..365", () => {
  assert.equal(normalizeSettingsPatch({ initialDays: 0 }).initialDays, 1);
  assert.equal(normalizeSettingsPatch({ initialDays: 9999 }).initialDays, 365);
  assert.equal(normalizeSettingsPatch({ initialDays: 30 }).initialDays, 30);
});

test("normalizeSettingsPatch clamps maxTasksPerSession to 1..10", () => {
  assert.equal(normalizeSettingsPatch({ maxTasksPerSession: -3 }).maxTasksPerSession, 1);
  assert.equal(normalizeSettingsPatch({ maxTasksPerSession: 99 }).maxTasksPerSession, 10);
  assert.equal(normalizeSettingsPatch({ maxTasksPerSession: 3 }).maxTasksPerSession, 3);
});

test("normalizeSettingsPatch clamps the AI budgets", () => {
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: 1 }).maxAiCallsPerScan, 5);
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: 100 }).maxAiCallsPerScan, 40);
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: 12 }).maxAiCallsPerScan, 12);
  assert.equal(normalizeSettingsPatch({ dailyAiCallLimit: 1 }).dailyAiCallLimit, 10);
  assert.equal(normalizeSettingsPatch({ dailyAiCallLimit: 9999 }).dailyAiCallLimit, 500);
  assert.equal(normalizeSettingsPatch({ dailyAiCallLimit: 150 }).dailyAiCallLimit, 150);
});

test("normalizeSettingsPatch drops non-finite numeric values", () => {
  assert.deepEqual(normalizeSettingsPatch({ scanIntervalSeconds: Infinity, initialDays: NaN }), {});
  assert.deepEqual(normalizeSettingsPatch({ maxAiCallsPerScan: Number.NaN, dailyAiCallLimit: Infinity }), {});
});

test("normalizeSettingsPatch validates model names", () => {
  assert.equal(normalizeSettingsPatch({ model: "deepseek-flash" }).model, "deepseek-flash");
  assert.equal(normalizeSettingsPatch({ model: "  deepseek-flash  " }).model, "deepseek-flash");
  assert.equal(normalizeSettingsPatch({ model: "deepseek flash" }).model, undefined);
  assert.equal(normalizeSettingsPatch({ model: "a".repeat(65) }).model, undefined);
  assert.equal(normalizeSettingsPatch({ model: 42 }).model, undefined);
});

test("normalizeSettingsPatch dedupes and limits excludeWorkspaces", () => {
  const patch = { excludeWorkspaces: ["a", "a", "b", 42, null, "c"] };
  assert.deepEqual(normalizeSettingsPatch(patch).excludeWorkspaces, ["a", "b", "c"]);
  const many = Array.from({ length: 150 }, (_value, index) => `w${index}`);
  assert.equal(normalizeSettingsPatch({ excludeWorkspaces: many }).excludeWorkspaces.length, 100);
});

test("normalizeSettingsPatch ignores unknown keys and does not mutate input", () => {
  const patch = { scanIntervalSeconds: 60, unknownKey: "x", lastScanAt: "ignored" };
  const snapshot = { ...patch };
  const result = normalizeSettingsPatch(patch);
  assert.deepEqual(result, { scanIntervalSeconds: 60 });
  assert.deepEqual(patch, snapshot);
});

test("DEFAULT_SETTINGS matches the documented contract defaults", () => {
  assert.equal(DEFAULT_SETTINGS.autoScan, true);
  assert.equal(DEFAULT_SETTINGS.aiEnabled, true);
  assert.equal(DEFAULT_SETTINGS.model, "deepseek-flash");
  assert.equal(DEFAULT_SETTINGS.maxAiCallsPerScan, 40);
  assert.equal(DEFAULT_SETTINGS.dailyAiCallLimit, 150);
  assert.deepEqual(DEFAULT_SETTINGS.excludeWorkspaces, []);
});

test("todayKey and rolloverUsage reset the daily counters", () => {
  assert.equal(todayKey(0), "1970-01-01");
  const usage = rolloverUsage(
    { date: "1970-01-01", calls: 5, tokens: 900, lastScan: { calls: 2, tokens: 300, durationMs: 500, digestBytesAvg: 1200 } },
    Date.UTC(1970, 0, 2),
  );
  assert.equal(usage.date, "1970-01-02");
  assert.equal(usage.calls, 0);
  assert.equal(usage.tokens, 0);
  assert.equal(usage.lastScan.calls, 0);
  const sameDay = rolloverUsage({ date: "1970-01-02", calls: 3, tokens: 100 }, Date.UTC(1970, 0, 2));
  assert.equal(sameDay.calls, 3);
  assert.equal(sameDay.tokens, 100);
  const negative = rolloverUsage({ date: "1970-01-02", calls: -4, tokens: -1 }, Date.UTC(1970, 0, 2));
  assert.equal(negative.calls, 0);
  assert.equal(negative.tokens, 0);
});
