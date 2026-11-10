import { badRequest, notFound } from "./http.mjs";

export const RELATION_TYPES = ["parent", "depends_on", "related"];
export const RELATION_LIMIT = 32;

export function normalizeRelations(value, taskId) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const link of value) {
    if (!RELATION_TYPES.includes(link?.type) || typeof link.taskId !== "string" || !link.taskId ||
        link.taskId.length > 200 || link.taskId === taskId) continue;
    if (result.some((item) => item.type === link.type && (item.taskId === link.taskId || link.type === "parent"))) continue;
    result.push({ type: link.type, taskId: link.taskId });
    if (result.length === RELATION_LIMIT) break;
  }
  return result;
}

export function editRelation(tasks, task, { type, taskId, remove }) {
  if (!RELATION_TYPES.includes(type) || typeof taskId !== "string" || taskId === task.id) throw badRequest("无效的任务关系");
  const links = normalizeRelations(task.relations, task.id);
  const remaining = links.filter((link) => !(link.type === type && (link.taskId === taskId || (!remove && type === "parent"))));
  if (remove) return remaining;
  const index = new Map(tasks.map((item) => [item.id, item]));
  if (!index.has(taskId)) throw notFound("关联任务不存在");
  if (remaining.length >= RELATION_LIMIT) throw badRequest("任务关系数量已达上限");
  if (type !== "related") {
    const pending = [taskId];
    const seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === task.id) throw badRequest("该关系会形成循环");
      if (seen.has(id)) continue;
      seen.add(id);
      for (const link of index.get(id)?.relations || []) {
        if (link.type === type) pending.push(link.taskId);
      }
    }
  }
  return [...remaining, { type, taskId }];
}

export function issueKey(issue) {
  return String(issue?.text || "").trim().replace(/\s+/g, " ");
}
