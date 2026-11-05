import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAnalysis, resolveAnalysisSeq, titleSimilarity } from "../server/analyzer-rules.mjs";

/** Synthetic parsed session shape accepted by normalizeAnalysis. */
function parsedSession(overrides = {}) {
  return {
    id: "demo-session",
    title: "Demo session title",
    timeBySeq: new Map([
      [12, 1700000000000],
      [13, 1700000060000],
    ]),
    ...overrides,
  };
}

/** Parsed-session shape with a real event timeline for seq recovery tests. */
function timelineSession(overrides = {}) {
  return {
    id: "demo-session",
    title: "Demo session title",
    timeBySeq: new Map([
      [12, 1700000000000],
      [13, 1700000060000],
    ]),
    users: [{ seq: 12, time: 1700000000000, text: "please fix the login flow" }],
    assistants: [{ seq: 13, time: 1700000060000, text: "fixed the login flow and added tests" }],
    toolResults: [],
    todoSnapshots: [],
    deliverables: [],
    errors: [],
    signals: [],
    systemNotices: [],
    ...overrides,
  };
}

test("titleSimilarity normalizes case and punctuation", () => {
  assert.equal(titleSimilarity("Fix Login!", "fix login"), 1);
  assert.equal(titleSimilarity("", ""), 0);
  assert.equal(titleSimilarity(null, undefined), 0);
  assert.equal(titleSimilarity("只有一边", ""), 0);
});

test("titleSimilarity detects substring containment beyond the short threshold", () => {
  const base = "修复插件登录问题";
  assert.equal(titleSimilarity(base, "修复插件登录问题（第二轮）"), 0.9);
  assert.equal(titleSimilarity("短", "短"), 1);
});

test("titleSimilarity scores overlapping Chinese characters with bigram Jaccard", () => {
  const similarity = titleSimilarity("实现用户登录", "实现用户注册");
  assert.ok(similarity > 0.4 && similarity < 0.6, `unexpected similarity: ${similarity}`);
  const digits = titleSimilarity("task 1", "task 2");
  assert.ok(digits > 0.5 && digits < 0.7, `unexpected similarity: ${digits}`);
  assert.ok(titleSimilarity("完全不同的话题", "implement login flow") === 0);
});

test("normalizeAnalysis returns null for unusable payloads", () => {
  assert.equal(normalizeAnalysis(null, parsedSession()), null);
  assert.equal(normalizeAnalysis(undefined, parsedSession()), null);
  assert.equal(normalizeAnalysis("nope", parsedSession()), null);
  assert.equal(normalizeAnalysis({}, parsedSession({ title: "" })), null);
});

test("normalizeAnalysis fills defaults and falls back to the session title", () => {
  const analysis = normalizeAnalysis({}, parsedSession());
  assert.equal(analysis.title, "Demo session title");
  assert.equal(analysis.status, "in_progress");
  assert.equal(analysis.priority, "P2");
  assert.equal(analysis.progress, null);
  assert.equal(analysis.confidence, 0.6);
  assert.equal(analysis.engine, "llm");
  assert.deepEqual(analysis.issues, []);
  assert.deepEqual(analysis.keyFacts, []);
  assert.deepEqual(analysis.subtasks, []);
  assert.deepEqual(analysis.evidence, []);
});

test("normalizeAnalysis validates status, priority and numeric ranges", () => {
  const analysis = normalizeAnalysis(
    { title: "Improve board", status: "weird", priority: "P9", progress: 150, confidence: 2 },
    parsedSession(),
  );
  assert.equal(analysis.status, "in_progress");
  assert.equal(analysis.priority, "P2");
  assert.equal(analysis.progress, 100);
  assert.equal(analysis.confidence, 1);

  const negative = normalizeAnalysis({ title: "Improve board", progress: -10, confidence: 0.876 }, parsedSession());
  assert.equal(negative.progress, 0);
  assert.equal(negative.confidence, 0.88);

  const explicitNull = normalizeAnalysis({ title: "Improve board", progress: null }, parsedSession());
  assert.equal(explicitNull.progress, null);

  const backlog = normalizeAnalysis({ title: "Later", status: "backlog", priority: "P0" }, parsedSession());
  assert.equal(backlog.status, "backlog");
  assert.equal(backlog.priority, "P0");
});

test("normalizeAnalysis clamps text lengths", () => {
  const analysis = normalizeAnalysis(
    { title: "t".repeat(60), goal: "g".repeat(200), reason: "r".repeat(200) },
    parsedSession(),
  );
  assert.equal(analysis.title.length, 40);
  assert.equal(analysis.goalText.length, 100);
  assert.equal(analysis.reason.length, 120);
});

test("normalizeAnalysis trims lists and derives ids", () => {
  const analysis = normalizeAnalysis(
    {
      title: "Board work",
      issues: Array.from({ length: 5 }, (_value, index) => ({ text: `issue ${index}`, severity: "high", seq: 12 })),
      keyFacts: Array.from({ length: 7 }, (_value, index) => ({ text: `fact ${index}`, kind: "status", seq: 12 })),
      subtasks: Array.from({ length: 8 }, (_value, index) => ({ text: `subtask ${index}`, done: index % 2 === 0, seq: 13 })),
      nextSteps: ["step one", "step two", "step three", "step four"],
      tags: ["dev", "dev", "ui", "ai", "docs"],
      evidence: [
        { kind: "user", text: "please fix the login", seq: 12 },
        { kind: "assistant", text: "done", seq: 13 },
        { kind: "invalid-kind", text: "ignored" },
        { kind: "tool", text: "npm test", seq: 12 },
        { kind: "todo", text: "write tests", seq: 13 },
        { kind: "error", text: "failed", seq: 12 },
        { kind: "artifact", text: "docs/index.json", seq: 13 },
      ],
    },
    parsedSession(),
  );
  assert.equal(analysis.issues.length, 3);
  assert.equal(analysis.keyFacts.length, 5);
  assert.equal(analysis.subtasks.length, 6);
  assert.equal(analysis.nextSteps.length, 3);
  assert.deepEqual(analysis.tags, ["dev", "ui", "ai", "docs"]);
  assert.equal(analysis.evidence.length, 5);
  assert.ok(analysis.evidence.every((item) => item.kind !== "invalid-kind"));
  assert.equal(analysis.issues[0].severity, "high");
  assert.equal(analysis.issues[0].sessionId, "demo-session");
  assert.match(analysis.issues[0].id, /^i_/);
  assert.match(analysis.keyFacts[0].id, /^k_/);
  assert.match(analysis.subtasks[0].id, /^s_/);
  assert.match(analysis.evidence[0].id, /^e_/);
  assert.equal(analysis.subtasks[0].done, true);
  assert.equal(analysis.subtasks[0].source, "ai");
  assert.equal(analysis.evidence[0].time, 1700000000000);
  assert.equal(analysis.evidence[0].quote.length <= 80, true);
  assert.equal(analysis.evidence[0].sessionTitle, "Demo session title");
});

test("normalizeAnalysis drops empty and malformed entries", () => {
  const analysis = normalizeAnalysis(
    {
      title: "Board work",
      issues: [{ text: "   " }, null, { text: "real issue", severity: "weird" }],
      keyFacts: [{ text: "real fact", kind: "unknown-kind" }],
      evidence: [{ kind: "user", text: "" }, { kind: "assistant", quote: "quoted text" }],
    },
    parsedSession(),
  );
  assert.equal(analysis.issues.length, 1);
  assert.equal(analysis.issues[0].severity, "medium");
  assert.equal(analysis.keyFacts.length, 1);
  assert.equal(analysis.keyFacts[0].kind, "status");
  assert.equal(analysis.evidence.length, 1);
  assert.equal(analysis.evidence[0].text, "quoted text");
});

test("resolveAnalysisSeq accepts only real timeline seqs", () => {
  const parsed = timelineSession();
  assert.equal(resolveAnalysisSeq(12, "", parsed), 12);
  assert.equal(resolveAnalysisSeq("13", "", parsed), 13);
  assert.equal(resolveAnalysisSeq(0, "", parsed), null, "0 is never a valid citation");
  assert.equal(resolveAnalysisSeq(-3, "", parsed), null);
  assert.equal(resolveAnalysisSeq(Number.NaN, "", parsed), null);
  assert.equal(resolveAnalysisSeq(999, "totally unrelated quote", parsed), null);
  // Without a timeline map a positive seq cannot be verified but is still accepted.
  assert.equal(resolveAnalysisSeq(5, "", {}), 5);
});

test("resolveAnalysisSeq recovers a missing seq from exact/contained quotes", () => {
  const parsed = timelineSession();
  assert.equal(resolveAnalysisSeq(999, "please fix the login flow", parsed), 12, "exact quote match");
  assert.equal(resolveAnalysisSeq(undefined, "added tests", parsed), 13, "quote contained in a message");
  assert.equal(resolveAnalysisSeq(0, "the login flow", parsed), 12, "invalid seq recovered by quote");
  assert.equal(resolveAnalysisSeq(999, "   ", parsed), null);
});

test("normalizeAnalysis: evidence keeps real seqs, drops fake #0 citations", () => {
  const parsed = timelineSession();
  const analysis = normalizeAnalysis(
    {
      title: "Board work",
      evidence: [
        { kind: "user", seq: 12, quote: "please fix the login flow" },
        { kind: "assistant", seq: 0, quote: "please fix the login flow" },
        { kind: "assistant", seq: 0, quote: "totally unrelated" },
        { kind: "tool", seq: 999, quote: "fixed the login flow and added tests" },
      ],
    },
    parsed,
  );
  assert.equal(analysis.evidence[0].seq, 12);
  assert.equal(analysis.evidence[0].time, 1700000000000);
  assert.equal(analysis.evidence[1].seq, 12, "seq 0 is recovered from the quote");
  assert.equal(analysis.evidence[2].seq, null, "unresolvable seq must be null, never 0");
  assert.equal(analysis.evidence[2].time, 0);
  assert.equal(analysis.evidence[3].seq, 13, "out-of-map seq recovered from the quote");
  assert.ok(analysis.evidence.every((item) => item.seq !== 0));
  assert.ok(analysis.evidence.every((item) => /^e_/.test(item.id)));
  assert.equal(analysis.evidence[2].id.includes("_na_"), true, "ids mark unresolved citations");
});

test("normalizeAnalysis: issues, keyFacts, subtasks and milestones share seq resolution", () => {
  const parsed = timelineSession();
  const analysis = normalizeAnalysis(
    {
      title: "Board work",
      issues: [
        { text: "please fix the login flow", seq: 0 },
        { text: "unrelated problem", seq: 0 },
      ],
      keyFacts: [
        { text: "added tests", seq: 999 },
        { text: "no citation possible", seq: -1 },
      ],
      subtasks: [
        { text: "please fix the login flow", seq: 0 },
        { text: "no citation possible", seq: 0 },
      ],
      milestones: [{ text: "added tests", done: true, seq: 0 }],
    },
    parsed,
  );
  assert.deepEqual(
    analysis.issues.map((issue) => issue.seq),
    [12, null],
  );
  assert.deepEqual(
    analysis.keyFacts.map((fact) => fact.seq),
    [13, null],
  );
  assert.deepEqual(
    analysis.subtasks.map((subtask) => subtask.seq),
    [12, null],
  );
  assert.equal(analysis.milestones[0].seq, 13);

  // Deterministic: running the same normalization twice yields identical output.
  const again = normalizeAnalysis(
    {
      title: "Board work",
      issues: [{ text: "please fix the login flow", seq: 0 }],
    },
    parsed,
  );
  assert.deepEqual(again.issues, normalizeAnalysis({ title: "Board work", issues: [{ text: "please fix the login flow", seq: 0 }] }, parsed).issues);
});
