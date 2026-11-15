import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const TEXT_FIELDS = ["title", "reason", "acceptanceCriteria", "notes"];
const RECORD_FIELDS = ["keyFacts", "issues", "subtasks", "milestones"];

/**
 * Optional, instance-private translations of legacy card descriptions. This is
 * a display projection, never a migration or an edit of the authoritative task.
 * Only exact string matches are replaced. Evidence, source-session titles,
 * paths, IDs, status, locks, provenance and review metadata remain untouched.
 */
export function projectTaskText(task, messages) {
  const translate = (value) => typeof value === "string" && Object.hasOwn(messages, value)
    ? messages[value] : value;
  const result = { ...task };
  for (const field of TEXT_FIELDS) if (typeof task[field] === "string") result[field] = translate(task[field]);
  if (task.goal && typeof task.goal === "object") result.goal = { ...task.goal, text: translate(task.goal.text) };
  for (const field of ["tags", "nextSteps"]) if (Array.isArray(task[field])) result[field] = task[field].map(translate);
  for (const field of RECORD_FIELDS) if (Array.isArray(task[field])) {
    result[field] = task[field].map((item) => item && typeof item === "object" ? { ...item, text: translate(item.text) } : translate(item));
  }
  if (Array.isArray(task.history)) result.history = task.history.map((item) => ({ ...item, note: translate(item.note) }));
  return result;
}

/** Read only this plugin's bounded local catalog; invalid replacements fail closed. */
export function createTextProjection(dshHome, logger) {
  const file = path.join(dshHome, "storages", "super-kanban", "translations.en.json");
  let signature = null;
  let messages = Object.create(null);
  function refresh() {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("invalid translation catalog file");
      const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
      if (key === signature) return;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 20000) throw new Error("invalid translation catalog");
      const next = Object.create(null);
      for (const [source, target] of Object.entries(value)) {
        if (typeof target !== "string" || source.length > 10000 || !target.trim() || target.length > 10000) throw new Error("invalid translation entry");
        next[source] = target;
      }
      messages = next;
      signature = key;
    } catch (error) {
      messages = Object.create(null);
      signature = null;
      if (error.code !== "ENOENT") logger?.warn?.("[super-kanban] ignored invalid local text translations");
    }
  }
  return {
    text(value) { refresh(); return typeof value === "string" && Object.hasOwn(messages, value) ? messages[value] : value; },
    tasks(tasks) { refresh(); return Object.keys(messages).length ? tasks.map((task) => projectTaskText(task, messages)) : tasks; },
    task(task) { refresh(); return Object.keys(messages).length ? projectTaskText(task, messages) : task; },
  };
}
