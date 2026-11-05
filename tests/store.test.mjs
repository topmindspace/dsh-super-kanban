import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

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

test("todayKey uses the local calendar day", () => {
  // Constructed from local components, so it is timezone-independent.
  assert.equal(todayKey(new Date(2026, 0, 2, 12, 30, 0).getTime()), "2026-01-02");
  assert.equal(todayKey(new Date(2026, 11, 31, 23, 59, 0).getTime()), "2026-12-31");
  assert.notEqual(
    todayKey(new Date(2026, 0, 2, 12, 0, 0).getTime()),
    todayKey(new Date(2026, 0, 1, 12, 0, 0).getTime()),
  );
});

test("todayKey follows the local timezone across midnight (subprocess TZ)", () => {
  // 2026-01-01T16:30Z is 2026-01-02 00:30 in Asia/Shanghai. The old UTC-based
  // implementation returned "2026-01-01" here; the local day must be Jan 2.
  const storeUrl = new URL("../server/store.mjs", import.meta.url).href;
  const script = [
    `import(${JSON.stringify(storeUrl)}).then(({ todayKey, rolloverUsage }) => {`,
    `  const now = Date.parse("2026-01-01T16:30:00.000Z");`,
    `  const oldUtcKey = new Date(now).toISOString().slice(0, 10);`,
    `  const rolled = rolloverUsage({ date: oldUtcKey, calls: 3, tokens: 7 }, now);`,
    `  process.stdout.write(JSON.stringify({ today: todayKey(now), oldUtcKey, rolled }));`,
    `}).catch((error) => { console.error(error); process.exit(1); });`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: "Asia/Shanghai" },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.oldUtcKey, "2026-01-01");
  assert.equal(payload.today, "2026-01-02");
  // Old UTC-keyed usage rolls over cleanly to the new local day.
  assert.equal(payload.rolled.date, "2026-01-02");
  assert.equal(payload.rolled.calls, 0);
  assert.equal(payload.rolled.tokens, 0);
});

test("rolloverUsage keeps counters within the same local day and resets otherwise", () => {
  const now = new Date(2026, 0, 2, 12, 0, 0).getTime();
  const today = todayKey(now);
  const yesterday = todayKey(now - 86_400_000);
  const usage = rolloverUsage(
    { date: yesterday, calls: 5, tokens: 900, lastScan: { calls: 2, tokens: 300, durationMs: 500, digestBytesAvg: 1200 } },
    now,
  );
  assert.equal(usage.date, today);
  assert.equal(usage.calls, 0);
  assert.equal(usage.tokens, 0);
  assert.equal(usage.lastScan.calls, 0);
  const sameDay = rolloverUsage({ date: today, calls: 3, tokens: 100 }, now);
  assert.equal(sameDay.calls, 3);
  assert.equal(sameDay.tokens, 100);
  const negative = rolloverUsage({ date: today, calls: -4, tokens: -1 }, now);
  assert.equal(negative.calls, 0);
  assert.equal(negative.tokens, 0);
});
