import { clipText } from "./http.mjs";

export const PROJECT_NAME_LIMIT = 60;
export const NOTES_LIMIT = 4000;

export function dateOnly(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

export function notesText(value) {
  return typeof value === "string" ? clipText(value.trim(), NOTES_LIMIT) : "";
}

export function normalizeProjects(value) {
  if (!Array.isArray(value)) return [];
  const projects = new Map();
  const activeWorkspaces = new Set();
  for (const project of value) {
    const name = typeof project?.name === "string" ? clipText(project.name.trim(), PROJECT_NAME_LIMIT) : "";
    if (!name || typeof project.id !== "string" || !/^p_[a-f0-9-]{36}$/.test(project.id) || projects.has(project.id)) continue;
    const workspaceId = typeof project.workspaceId === "string" && project.workspaceId ? project.workspaceId : null;
    const archived = project.archived === true;
    const duplicateBinding = !archived && activeWorkspaces.has(workspaceId);
    projects.set(project.id, {
      id: project.id,
      name,
      notes: notesText(project.notes),
      dueDate: dateOnly(project.dueDate),
      workspaceId: duplicateBinding ? null : workspaceId,
      archived,
      updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : "",
    });
    if (!archived && workspaceId) activeWorkspaces.add(workspaceId);
  }
  return [...projects.values()];
}

export function normalizeTaskPlanning(task, projectIds) {
  task.projectId = typeof task.projectId === "string" && (!projectIds || projectIds.has(task.projectId)) ? task.projectId : null;
  task.notes = notesText(task.notes);
  task.dueDate = dateOnly(task.dueDate);
}
