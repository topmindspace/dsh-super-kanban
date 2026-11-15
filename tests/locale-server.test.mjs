import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSessionRules } from "../server/analyzer-rules.mjs";
import { preferenceFromPatch } from "../server/locale.mjs";
import { runWithLanguage } from "../server/i18n.mjs";
import { createKanbanService } from "../server/service.mjs";

function parsedSession() {
  return {
    id: "sess-locale",
    title: "修复登录",
    users: [{ text: "请修复代码 /work/原文.js", seq: 1 }],
    assistants: [],
    errors: [],
    deliverables: [],
    todoSnapshots: [],
    turnStarts: [],
    lastActivityAt: Date.now(),
    lastTurnEnd: null,
    isLive: true,
    evidence: [{
      id: "e1",
      kind: "user",
      text: "请修复代码 /work/原文.js",
      quote: "请修复代码 /work/原文.js",
      seq: 1,
      time: 1,
      sessionId: "sess-locale",
      sessionTitle: "修复登录",
    }],
    session: { cwd: "/work" },
  };
}

test("patch preference is a plain scalar and ignores expressions", () => {
  assert.equal(preferenceFromPatch("- id: locale\n  config:\n    preference: zh-CN\n"), "zh-CN");
  assert.equal(preferenceFromPatch("- id: locale\n  config:\n    preference: \"en\"\n"), "en");
  assert.equal(preferenceFromPatch("- id: other\n  config:\n    preference: en\n- id: locale\n  config:\n    preference: zh\n"), "zh");
  assert.equal(preferenceFromPatch("- id: locale\n  config:\n    preference: !!js process.env.LANG\n"), null);
  assert.equal(preferenceFromPatch("- id: locale\n  name: something\n"), null);
});

test("rules analysis follows both board languages without rewriting evidence", () => {
  const parsed = parsedSession();
  const chinese = runWithLanguage("zh-CN", () => analyzeSessionRules(parsed));
  const english = runWithLanguage("en", () => analyzeSessionRules(parsed));
  assert.match(chinese.tasks[0].reason, /会话仍在进行中/);
  assert.match(english.tasks[0].reason, /Session is still active/);
  assert.ok(chinese.tasks[0].tags.includes("开发"));
  assert.ok(english.tasks[0].tags.includes("Development"));
  assert.equal(chinese.tasks[0].evidence[0].quote, "请修复代码 /work/原文.js");
  assert.equal(english.tasks[0].evidence[0].quote, chinese.tasks[0].evidence[0].quote);
  assert.equal(english.tasks[0].evidence[0].text, parsed.evidence[0].text);
  assert.equal(parsed.evidence[0].quote, "请修复代码 /work/原文.js");
});

function mockReq() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.headers = {};
  req.destroy = () => { req.destroyed = true; };
  return req;
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.body = "";
    this.headersSent = false;
    this.writableEnded = false;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  write(chunk) {
    this.body += String(chunk);
    return true;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== "") this.body += String(chunk);
    this.writableEnded = true;
  }

  flushHeaders() {}
}

async function call(service, { method = "GET", route = "/state", headers = {}, search = "", body } = {}) {
  const req = mockReq();
  req.headers = headers;
  const res = new MockResponse();
  const url = new URL(`http://plugin.local${route}${search}`);
  const pending = service.handle(req, res, { route, url, method });
  if (body !== undefined) {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  }
  await pending;
  return { status: res.status, json: JSON.parse(res.body) };
}

async function waitForScan(service) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const state = await call(service);
    if (state.json.scan.state !== "running") return state.json.scan;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("scan did not finish");
}

test("server generation stays Chinese by default and follows the stored or requested locale", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-locale-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  const logger = { info() {}, warn() {} };
  const initial = createKanbanService({ ctx: { logger } });
  t.after(() => initial.stop());
  const idle = await call(initial);
  assert.match(idle.json.scan.message, /等待首次扫描/);
  assert.equal((await call(initial, { method: "POST", route: "/command", body: { op: "scan.start", payload: {} } })).status, 200);
  const chinese = await waitForScan(initial);
  assert.match(chinese.message, /扫描完成/);
  assert.doesNotMatch(chinese.message, /Scan finished/);

  fs.rmSync(path.join(home, "storages", "super-kanban"), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, "profiles", "desktop"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "desktop", "cordis.patch.yml"), "- id: locale\n  config:\n    preference: en\n");
  const linked = path.join(home, "secret.txt");
  fs.writeFileSync(linked, "preference: zh\n");
  fs.symlinkSync(linked, path.join(home, "cordis.patch.yml"));
  const fromProfile = createKanbanService({ ctx: { logger, get: (name) => (name === "profileContext" ? { name: "desktop" } : undefined) } });
  t.after(() => fromProfile.stop());
  assert.match((await call(fromProfile)).json.scan.message, /Waiting for first scan/);
  fs.unlinkSync(path.join(home, "cordis.patch.yml"));
  fs.writeFileSync(path.join(home, "cordis.patch.yml"), "- id: locale\n  config:\n    preference: zh-CN\n");
  fs.rmSync(path.join(home, "storages", "super-kanban"), { recursive: true, force: true });
  const homeWins = createKanbanService({ ctx: { logger, get: (name) => (name === "profileContext" ? { name: "desktop" } : undefined) } });
  t.after(() => homeWins.stop());
  assert.match((await call(homeWins)).json.scan.message, /等待首次扫描/);

  const switched = await call(fromProfile, {
    headers: { "x-super-kanban-locale": "zh-CN" },
    method: "POST",
    route: "/command",
    body: { op: "scan.start", payload: {} },
  });
  assert.equal(switched.status, 200);
  const afterHeader = await waitForScan(fromProfile);
  assert.match(afterHeader.message, /扫描完成/);
  const englishAgain = await call(fromProfile, {
    search: "?locale=en",
    method: "POST",
    route: "/command",
    body: { op: "scan.start", payload: {} },
  });
  assert.equal(englishAgain.status, 200);
  assert.match((await waitForScan(fromProfile)).message, /Scan finished/);
});
