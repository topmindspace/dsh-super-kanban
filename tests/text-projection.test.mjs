import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectTaskText, createTextProjection } from "../server/text-projection.mjs";

test("legacy text projection changes descriptions without changing task authority or evidence", () => {
  const task = {
    id: "t_opaque", title: "旧标题", origin: "auto", status: "done", progress: 100,
    goal: { text: "旧目标", source: "session", status: "done" },
    ai: { reason: "旧标题", engine: "ai", confidence: 0.9, analyzedAt: "2028-01-01" },
    lockedFields: ["status"], review: { seq: 4 }, completionBasis: "session_goal",
    sessions: [{ id: "s1", title: "旧标题" }], parentId: "t_parent", projectId: "p1",
    artifacts: [{ path: "旧标题", description: "旧标题" }],
    evidence: [{ seq: 1, quote: "旧标题" }], keyFacts: [{ text: "旧标题", seq: 1 }],
    subtasks: [{ id: "st1", text: "旧标题", done: true, source: "ai" }],
    history: [{ note: "旧标题", kind: "status", from: "in_progress", to: "done" }],
  };
  const before = structuredClone(task);
  const result = projectTaskText(task, { "旧标题": "Legacy title", "旧目标": "Legacy goal" });
  assert.equal(result.title, "Legacy title");
  assert.equal(result.goal.text, "Legacy goal");
  assert.equal(result.ai.reason, "Legacy title");
  assert.equal(result.ai.engine, "ai");
  assert.equal(result.ai.confidence, 0.9);
  assert.equal(result.ai.analyzedAt, "2028-01-01");
  assert.equal(result.subtasks[0].text, "Legacy title");
  assert.equal(result.history[0].note, "Legacy title");
  for (const key of ["id", "origin", "status", "progress", "lockedFields", "review", "completionBasis", "sessions", "parentId", "projectId", "artifacts", "evidence"]) assert.deepEqual(result[key], before[key], key);
  assert.deepEqual(task, before, "projection must never mutate authoritative state");
  assert.equal(result.goal.source, "session");
  assert.equal(result.subtasks[0].source, "ai");
  assert.equal(result.subtasks[0].done, true);
});

test("local catalog is optional, reloadable, bounded and rejects symlinks or invalid values", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-text-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "storages/super-kanban/translations.en.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const logs = [];
  const projection = createTextProjection(home, { warn: (...args) => logs.push(args.join(" ")) });
  const task = { title: "旧标题", id: "t1" };
  assert.equal(projection.task(task), task);
  fs.writeFileSync(file, JSON.stringify({ "旧标题": "Legacy title" }));
  assert.equal(projection.tasks([task])[0].title, "Legacy title");
  fs.writeFileSync(file, JSON.stringify({ "旧标题": "New translation" }));
  assert.equal(projection.task(task).title, "New translation");
  fs.writeFileSync(file, '{"旧标题":false}');
  assert.equal(projection.task(task), task);
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(projection.task(task), task);
  fs.unlinkSync(file);
  const target = path.join(home, "other.json");
  fs.writeFileSync(target, '{"旧标题":"unexpected"}');
  fs.symlinkSync(target, file);
  assert.equal(projection.task(task), task);
  assert.ok(logs.length);
  assert.ok(logs.every((line) => !line.includes("旧标题") && !line.includes(home)));
});

test("text catalog cannot replace inherited keys or execute HTML-looking values", () => {
  const messages = Object.create({ inherited: "unexpected" });
  messages.source = "<script>$&</script>";
  const projected = projectTaskText({ title: "inherited", notes: "source" }, messages);
  assert.equal(projected.title, "inherited");
  assert.equal(projected.notes, "<script>$&</script>");
});
