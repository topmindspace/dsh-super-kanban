import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  AI_CALLS_PER_SCAN_MAX,
  AI_CALLS_PER_SCAN_MIN,
  DEFAULT_SETTINGS,
  emptyScanState,
  normalizeAiRoutePair,
  normalizeReviewDeferred,
  normalizeReviewSeen,
  normalizeSettingsPatch,
  normalizeTaskReview,
  REVIEW_SEEN_LIMIT,
  rolloverUsage,
  todayKey,
  truncateTask,
} from "../server/store.mjs";

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
  // v3: the fixed per-scan cap widened from 5..40 to 5..150.
  assert.equal(AI_CALLS_PER_SCAN_MIN, 5);
  assert.equal(AI_CALLS_PER_SCAN_MAX, 150);
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: 1 }).maxAiCallsPerScan, 5);
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: 0 }).maxAiCallsPerScan, 5);
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: -3 }).maxAiCallsPerScan, 5);
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: 100 }).maxAiCallsPerScan, 100);
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: 12 }).maxAiCallsPerScan, 12);
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: 9999 }).maxAiCallsPerScan, 150);
  assert.equal(normalizeSettingsPatch({ maxAiCallsPerScan: 150 }).maxAiCallsPerScan, 150);
  // dailyAiCallLimit is unchanged (10..500, default 150).
  assert.equal(normalizeSettingsPatch({ dailyAiCallLimit: 1 }).dailyAiCallLimit, 10);
  assert.equal(normalizeSettingsPatch({ dailyAiCallLimit: 9999 }).dailyAiCallLimit, 500);
  assert.equal(normalizeSettingsPatch({ dailyAiCallLimit: 150 }).dailyAiCallLimit, 150);
});

test("normalizeSettingsPatch drops non-finite numeric values", () => {
  assert.deepEqual(normalizeSettingsPatch({ scanIntervalSeconds: Infinity, initialDays: NaN }), {});
  assert.deepEqual(normalizeSettingsPatch({ maxAiCallsPerScan: Number.NaN, dailyAiCallLimit: Infinity }), {});
});

test("normalizeSettingsPatch validates the AI model route fields", () => {
  const provider = normalizeSettingsPatch({ aiProvider: "  deepseek-account  ", aiModel: " deepseek-flash " });
  assert.deepEqual(provider, { aiProvider: "deepseek-account", aiModel: "deepseek-flash" });
  // Third-party ids use wide charsets: slash/colon/dot/@ are all legal.
  assert.equal(normalizeSettingsPatch({ aiModel: "alibaba/qwen-3-14b" }).aiModel, "alibaba/qwen-3-14b");
  assert.equal(normalizeSettingsPatch({ aiModel: "amazon.nova-2-lite-v1:0" }).aiModel, "amazon.nova-2-lite-v1:0");
  assert.equal(normalizeSettingsPatch({ aiModel: "vendor/model@2026-11" }).aiModel, "vendor/model@2026-11");
  // Empty strings are legal (follow the DSH default).
  assert.deepEqual(normalizeSettingsPatch({ aiProvider: "  ", aiModel: "" }), { aiProvider: "", aiModel: "" });
  // Illegal charsets / non-strings are dropped (never coerced).
  assert.equal(normalizeSettingsPatch({ aiProvider: "bad provider!" }).aiProvider, undefined);
  assert.equal(normalizeSettingsPatch({ aiModel: "bad model with spaces" }).aiModel, undefined);
  assert.equal(normalizeSettingsPatch({ aiProvider: 42 }).aiProvider, undefined);
  assert.equal(normalizeSettingsPatch({ aiProvider: "p".repeat(101) }).aiProvider, undefined);
  assert.equal(normalizeSettingsPatch({ aiModel: "m".repeat(201) }).aiModel, undefined);
});

test("normalizeSettingsPatch keeps only a valid aiBudgetMode", () => {
  assert.equal(normalizeSettingsPatch({ aiBudgetMode: "auto" }).aiBudgetMode, "auto");
  assert.equal(normalizeSettingsPatch({ aiBudgetMode: "fixed" }).aiBudgetMode, "fixed");
  assert.equal(normalizeSettingsPatch({ aiBudgetMode: "bogus" }).aiBudgetMode, undefined);
  assert.equal(normalizeSettingsPatch({ aiBudgetMode: 0 }).aiBudgetMode, undefined);
  assert.equal(normalizeSettingsPatch({ aiBudgetMode: null }).aiBudgetMode, undefined);
});

test("normalizeAiRoutePair enforces all-or-nothing model routes", () => {
  const both = normalizeAiRoutePair({ aiProvider: "p", aiModel: "m" });
  assert.deepEqual(both, { aiProvider: "p", aiModel: "m" });
  const neither = normalizeAiRoutePair({ aiProvider: "", aiModel: "" });
  assert.deepEqual(neither, { aiProvider: "", aiModel: "" });
  assert.deepEqual(normalizeAiRoutePair({ aiProvider: "p", aiModel: "" }), { aiProvider: "", aiModel: "" });
  assert.deepEqual(normalizeAiRoutePair({ aiProvider: "", aiModel: "m" }), { aiProvider: "", aiModel: "" });
  // Trims whitespace-only halves and returns the same object.
  const half = { aiProvider: "  ", aiModel: "m" };
  assert.equal(normalizeAiRoutePair(half), half);
  assert.deepEqual(half, { aiProvider: "", aiModel: "" });
});

test("emptyScanState exposes the additive AI budget observability fields", () => {
  const scan = emptyScanState();
  assert.equal(scan.aiDue, 0);
  assert.equal(scan.aiBudget, 0);
  assert.equal(scan.aiAttempts, 0);
  assert.equal(scan.aiPending, 0);
  assert.equal(scan.aiDeferredReason, null);
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
  // v3 model route: deprecated `model` survives for read compatibility only.
  assert.equal(DEFAULT_SETTINGS.model, "deepseek-flash");
  assert.equal(DEFAULT_SETTINGS.aiProvider, "");
  assert.equal(DEFAULT_SETTINGS.aiModel, "");
  assert.equal(DEFAULT_SETTINGS.aiBudgetMode, "auto");
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

test("a queued review notice keeps only a usable shape", () => {
  assert.equal(normalizeTaskReview(null), null);
  assert.equal(normalizeTaskReview([]), null);
  assert.equal(normalizeTaskReview({ at: 1 }), null);
  assert.equal(normalizeTaskReview({ sessionId: "s" }), null);
  assert.equal(normalizeTaskReview({ sessionId: "s", at: 0 }), null);
  assert.deepEqual(
    { ...normalizeTaskReview({ sessionId: "  sess-1  ", at: 1793694767953.9, seq: "12", kind: "error" }) },
    { at: 1793694767953, sessionId: "sess-1", seq: 12, kind: "error" });
  assert.deepEqual(
    { ...normalizeTaskReview({ sessionId: "sess-1", at: 5, seq: -2, kind: "weird" }) },
    { at: 5, sessionId: "sess-1", seq: 0, kind: "completed" });
  const task = truncateTask({ id: "t", title: "任务", review: { sessionId: "s", at: 1e12, seq: 3, kind: "completed" } });
  assert.deepEqual({ ...task.review }, { at: 1e12, sessionId: "s", seq: 3, kind: "completed" });
  assert.equal(truncateTask({ id: "t", title: "任务", review: { sessionId: "", at: 1 } }).review, null);
});

test("the review ledger drops junk and stays bounded", () => {
  assert.deepEqual({ ...normalizeReviewSeen(null) }, {});
  assert.deepEqual({ ...normalizeReviewSeen({ a: 4, b: 0, c: "x", d: 2.9, "": 9, e: -1 }) }, { a: 4, d: 2 });
  const raw = {};
  for (let index = 0; index < REVIEW_SEEN_LIMIT + 20; index += 1) raw[`session-${index}`] = index + 1;
  const seen = normalizeReviewSeen(raw);
  assert.equal(Object.keys(seen).length, REVIEW_SEEN_LIMIT);
  assert.equal(seen["session-0"], undefined);
  assert.equal(seen[`session-${REVIEW_SEEN_LIMIT + 19}`], REVIEW_SEEN_LIMIT + 20);
});

test("the deferred-dismissal ledger drops junk and stays bounded", () => {
  assert.deepEqual({ ...normalizeReviewDeferred(null) }, {});
  assert.deepEqual({ ...normalizeReviewDeferred({ a: 1, b: 0, c: "yes", "": 1, d: true, e: 1_700_000_000_000 }) }, { a: 1, d: 1, e: 1_700_000_000_000 });
  const raw = {};
  for (let index = 0; index < REVIEW_SEEN_LIMIT + 20; index += 1) raw[`session-${index}`] = 1;
  const deferred = normalizeReviewDeferred(raw);
  assert.equal(Object.keys(deferred).length, REVIEW_SEEN_LIMIT);
  assert.equal(deferred["session-0"], undefined);
  assert.equal(deferred[`session-${REVIEW_SEEN_LIMIT + 19}`], 1);
});
