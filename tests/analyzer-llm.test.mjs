/**
 * Unit tests for the LLM analyzer over the DSH native llm service.
 *
 * A synthetic `ctx.llm` async generator stands in for the provider adapter, so
 * these tests never touch the network or the real `$DSH_HOME`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createLlmAnalyzer,
  extractJsonObject,
  buildUserText,
} from "../server/analyzer-llm.mjs";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function chunkScript(...chunks) {
  return chunks;
}

const OK_TASK = {
  sessionSummary: "修复登录并补测试",
  ignore: false,
  tasks: [
    {
      title: "修复登录流程",
      goal: "登录可用并通过测试",
      status: "in_progress",
      progress: 50,
      priority: "P1",
      tags: [],
      keyFacts: [],
      issues: [],
      nextSteps: [],
      subtasks: [],
      evidence: [],
      confidence: 0.8,
      reason: "已修复一半",
      mergeWith: null,
    },
  ],
};

function okChunks(payload = OK_TASK, usage = { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }) {
  return chunkScript(
    { type: "text-delta", index: 0, text: JSON.stringify(payload) },
    { type: "usage", usage },
    { type: "finish", reason: { kind: "stop" } },
  );
}

function errorChunks(code, extra = {}) {
  return chunkScript(
    { type: "usage", usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } },
    { type: "finish", reason: { kind: "error", failure: { code, message: `${code} failed`, ...extra } } },
  );
}

function fakeHost({ scripts = [], prepare = null } = {}) {
  const calls = [];
  const llm = {
    stream(options) {
      calls.push(options);
      if (!scripts.length) throw new Error("fake llm script exhausted");
      const script = scripts.shift();
      return (async function* replay() {
        for (const chunk of script) yield chunk;
      })();
    },
    listProviders() {
      return [];
    },
  };
  if (prepare) llm.prepareCall = prepare;
  const ctx = {
    get(name) {
      return name === "llm" ? llm : undefined;
    },
    logger: { info() {}, warn() {} },
  };
  return { ctx, llm, calls };
}

function analyzerFor(host) {
  return createLlmAnalyzer({ ctx: host.ctx });
}

const ROUTE = { provider: "deepseek-account", model: "deepseek-flash" };

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

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
});

test("buildUserText includes the digest and the existing-task hints", () => {
  const text = buildUserText("digest-body", [{ id: "t_1", title: "已有的卡", status: "in_progress" }]);
  assert.match(text, /digest-body/);
  assert.match(text, /t_1/);
  assert.match(text, /已有的卡/);
  assert.match(buildUserText("d", []), /\(无\)/);
});

/* ------------------------------------------------------------------ */
/* Native transport                                                    */
/* ------------------------------------------------------------------ */

test("analyze streams through ctx.llm, maps usage and never sends sessionId", async () => {
  const host = fakeHost({ scripts: [okChunks()] });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(5);
  const result = await analyzer.analyze({ ...ROUTE, digest: "会话内容", existingTasks: [] });
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.model, ROUTE.model);
  assert.equal(result.provider, ROUTE.provider);
  assert.deepEqual(result.usage, { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 });
  assert.equal(host.calls.length, 1);
  const options = host.calls[0];
  assert.equal(options.provider, ROUTE.provider);
  assert.equal(options.model, ROUTE.model);
  assert.equal("sessionId" in options, false);
  assert.equal("response_format" in options, false);
  assert.equal("purpose" in options, false);
  assert.ok(options.system.length > 0);
  assert.deepEqual(options.messages[0].role, "user");
  assert.match(options.messages[0].content[0].text, /会话内容/);
});

test("analyze derives totalTokens from cache-aware usage when total is absent", async () => {
  const host = fakeHost({
    scripts: [
      okChunks(OK_TASK, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 50 }),
      // An explicit total always wins over the derivation.
      okChunks(OK_TASK, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, totalTokens: 999 }),
    ],
  });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(5);
  const derived = await analyzer.analyze({ ...ROUTE, digest: "x", existingTasks: [] });
  assert.equal(derived.ok, true);
  assert.deepEqual(derived.usage, { promptTokens: 1000, completionTokens: 100, totalTokens: 1650 });
  const explicit = await analyzer.analyze({ ...ROUTE, digest: "y", existingTasks: [] });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.usage.totalTokens, 999);
});

test("analyze refuses to run without the native llm service", async () => {
  const analyzer = createLlmAnalyzer({ ctx: { logger: { info() {}, warn() {} } } });
  assert.equal(analyzer.hasService(), false);
  const result = await analyzer.analyze({ ...ROUTE, digest: "x", existingTasks: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "llm-unavailable");
});

test("analyze enforces the per-scan call budget", async () => {
  const host = fakeHost({ scripts: [okChunks(), okChunks()] });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(1);
  assert.equal((await analyzer.analyze({ ...ROUTE, digest: "a", existingTasks: [] })).ok, true);
  const second = await analyzer.analyze({ ...ROUTE, digest: "b", existingTasks: [] });
  assert.equal(second.ok, false);
  assert.equal(second.code, "budget");
  assert.equal(host.calls.length, 1);
  assert.equal(analyzer.getBudget().calls, 1);
});

test("analyze repairs malformed JSON by re-asking with a correction message", async () => {
  const host = fakeHost({
    scripts: [chunkScript({ type: "text-delta", index: 0, text: "not json" }, { type: "finish", reason: { kind: "stop" } }), okChunks()],
  });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(5);
  const result = await analyzer.analyze({ ...ROUTE, digest: "x", existingTasks: [] });
  assert.equal(result.ok, true);
  assert.equal(host.calls.length, 2);
  assert.equal(host.calls[1].messages.length, 2);
  assert.match(host.calls[1].messages[1].content[0].text, /合法 JSON/);
  assert.equal(analyzer.getBudget().calls, 1);
  assert.equal(analyzer.getBudget().attempts, 2);
});

test("analyze retries transient provider failures and then succeeds", async () => {
  const host = fakeHost({ scripts: [errorChunks("RATE_LIMIT", { providerRetryAfterMs: 1 }), okChunks()] });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(5);
  const result = await analyzer.analyze({ ...ROUTE, digest: "x", existingTasks: [] });
  assert.equal(result.ok, true);
  assert.equal(host.calls.length, 2);
  assert.equal(analyzer.getBudget().attempts, 2);
  assert.equal(analyzer.getBudget().tokens, 1500);
});

test("analyze does not retry non-retryable auth failures", async () => {
  const host = fakeHost({ scripts: [errorChunks("AUTH")] });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(5);
  const result = await analyzer.analyze({ ...ROUTE, digest: "x", existingTasks: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH");
  assert.equal(host.calls.length, 1);
});

test("analyze treats a stream without terminal finish as a failure and retries", async () => {
  const host = fakeHost({
    scripts: [
      chunkScript({ type: "text-delta", index: 0, text: '{"tasks":[]}' }),
      chunkScript({ type: "text-delta", index: 0, text: '{"tasks":[]}' }),
      chunkScript({ type: "text-delta", index: 0, text: '{"tasks":[]}' }),
    ],
  });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(5);
  const result = await analyzer.analyze({ ...ROUTE, digest: "x", existingTasks: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "stream-closed");
  assert.equal(host.calls.length, 3);
});

test("analyze fails closed on truncated output without retrying", async () => {
  const host = fakeHost({
    scripts: [chunkScript({ type: "text-delta", index: 0, text: "{" }, { type: "finish", reason: { kind: "max-tokens" } })],
  });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(5);
  const result = await analyzer.analyze({ ...ROUTE, digest: "x", existingTasks: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "truncated");
  assert.equal(host.calls.length, 1);
});

test("analyze stops immediately when the scan is aborted", async () => {
  const host = fakeHost({ scripts: [okChunks()] });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(5);
  const controller = new AbortController();
  controller.abort();
  const result = await analyzer.analyze({ ...ROUTE, digest: "x", existingTasks: [], signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.code, "aborted");
});

test("prepareCall path picks the least reasoning effort and a bounded output cap", async () => {
  const seen = [];
  const prepare = async (config, _signal, configure) => {
    const modelInfo = { reasoning: { efforts: [{ id: "low" }, { id: "high" }] }, defaultMaxTokens: 2048 };
    const resolved = configure({ ...config }, modelInfo);
    return {
      config: { ...config, ...resolved },
      retryPolicy: {},
      adapterDefaults: {},
      stream(options) {
        seen.push(options);
        return (async function* replay() {
          yield* okChunks();
        })();
      },
    };
  };
  const host = fakeHost({ scripts: [], prepare });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(5);
  const result = await analyzer.analyze({ ...ROUTE, digest: "x", existingTasks: [] });
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reasoningEffort, "low");
  assert.equal(seen[0].maxTokens, 2048);
});

test("polish returns polished text and counts against the same budget", async () => {
  const host = fakeHost({ scripts: [chunkScript({ type: "text-delta", index: 0, text: "润色后的提示词" }, { type: "finish", reason: { kind: "stop" } })] });
  const analyzer = analyzerFor(host);
  analyzer.resetBudget(1);
  const result = await analyzer.polish({ ...ROUTE, prompt: "继续修复登录" });
  assert.equal(result.ok, true);
  assert.equal(result.prompt, "润色后的提示词");
  const second = await analyzer.polish({ ...ROUTE, prompt: "再润色一次" });
  assert.equal(second.ok, false);
  assert.equal(second.code, "budget");
});
