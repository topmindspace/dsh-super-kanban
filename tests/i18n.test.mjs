import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import messages from "../locales/en.mjs";
import { createTranslator, normalizeLanguage, t } from "../server/i18n.mjs";

const placeholders = (value) => [...value.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort();

test("English catalog is complete, readable and preserves every interpolation", () => {
  assert.ok(Object.keys(messages).length > 1000);
  for (const [source, english] of Object.entries(messages)) {
    assert.equal(typeof english, "string", source);
    assert.ok(english.length, source);
    assert.doesNotMatch(english, /\p{Script=Han}/u, source);
    assert.deepEqual(placeholders(english), placeholders(source), source);
  }
  for (const file of ["client.js", ...fs.readdirSync(new URL("../server/", import.meta.url)).filter((n) => n.endsWith(".mjs")).map((n) => `server/${n}`)]) {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const match of text.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
      assert.ok(Object.hasOwn(messages, JSON.parse(match[1])), `${file}: ${match[1]}`);
    }
  }
});

test("English is the fallback; Chinese remains lossless when explicitly selected", () => {
  assert.equal(normalizeLanguage("ru-RU"), "en");
  assert.equal(normalizeLanguage("zh-CN"), "zh");
  assert.equal(t("任务看板"), "Task board");
  assert.equal(createTranslator(messages, "zh-CN")("任务看板"), "任务看板");
  assert.equal(t("unknown source"), "unknown source");
  const inherited = Object.create({ injected: "bad" });
  assert.equal(createTranslator(inherited)("injected"), "injected");
});

test("interpolation is literal, preserves identifiers and never evaluates source data", () => {
  const translate = createTranslator({ "x{0}/{1}": "{1}: {0}" });
  assert.equal(translate("x{0}/{1}", ["$& ${alert(1)} <script>", "C:\\路径\\a.js"]), "C:\\路径\\a.js: $& ${alert(1)} <script>");
  assert.equal(translate("x{0}/{1}", ["a"]), "{1}: a");
  assert.equal(translate("x{0}/{1}", [null, 0]), "0: null");
});

test("the checked-in browser catalog and shared translator are reproducible", () => {
  execFileSync(process.execPath, ["scripts/build-i18n.mjs", "--check"], { cwd: new URL("..", import.meta.url) });
});

test("generated descriptions explicitly request English while evidence stays verbatim", () => {
  assert.match(t("你是任务看板研判引擎。输入是一段 DSH（AI 编程助手）会话的紧凑摘要，输出任务卡 JSON。"), /English.*verbatim evidence quotes/);
  const data = "用户文件 /work/原文.js";
  assert.equal(t("用户最新要求：{0}", [data]), `Latest user request: ${data}`);
});
