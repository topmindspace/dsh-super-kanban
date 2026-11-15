import fs from "node:fs";
import path from "node:path";
import { boardLanguage } from "./i18n.mjs";

const MAX_PATCH_BYTES = 512 * 1024;
const PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/u;
const LOCALE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/**
 * Read `preference` from a locale entry in a Cordis patch.
 * Returns the raw id, or null when the entry has no usable preference.
 * `!!js` and nested collections are ignored; nothing in the patch is evaluated.
 */
export function preferenceFromPatch(text) {
  const lines = String(text || "").split(/\r?\n/);
  let entryIndent = null;
  let configIndent = null;
  let preference = null;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const indent = line.match(/^ */u)[0].length;
    const trimmed = line.trim();
    if (entryIndent !== null && indent <= entryIndent) {
      entryIndent = null;
      configIndent = null;
    }
    if (/^(?:-\s+)?id:\s*locale\s*(?:#.*)?$/u.test(trimmed)) {
      entryIndent = indent;
      configIndent = null;
      continue;
    }
    if (entryIndent === null || indent <= entryIndent) continue;
    if (/^config:\s*(?:#.*)?$/u.test(trimmed)) {
      configIndent = indent;
      continue;
    }
    if (configIndent === null || indent <= configIndent) continue;
    const match = trimmed.match(/^preference:\s*(.*?)\s*(?:#.*)?$/u);
    if (!match) continue;
    preference = plainScalar(match[1].trim());
  }
  return preference;
}

function plainScalar(value) {
  if (!value || value.startsWith("!!") || value.startsWith("|") || value.startsWith(">") || value.startsWith("[") || value.startsWith("{") || value.startsWith("&") || value.startsWith("*")) return null;
  let text = value;
  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) || (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
    text = text.slice(1, -1);
  }
  return LOCALE_ID.test(text) ? text : null;
}

function readPreferenceFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PATCH_BYTES) return null;
    return preferenceFromPatch(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Active profile name from the host, when the context exposes one. */
export function profileNameFromContext(ctx) {
  try {
    const name = ctx?.get?.("profileContext")?.name;
    return typeof name === "string" && PROFILE_NAME.test(name) ? name : "desktop";
  } catch {
    return "desktop";
  }
}

/**
 * Durable DSH locale. The home patch is applied after the profile patch and
 * therefore wins when it has its own preference. Absence means "no stored choice".
 */
export function readStoredLocale(dshHome, profileName = "desktop") {
  const profile = PROFILE_NAME.test(profileName)
    ? readPreferenceFile(path.join(dshHome, "profiles", profileName, "cordis.patch.yml"))
    : null;
  const home = readPreferenceFile(path.join(dshHome, "cordis.patch.yml"));
  const chosen = home || profile;
  return chosen ? boardLanguage(chosen) : null;
}

/** Locale snapshot when a caller supplies the same shape the browser uses. */
export function localeFromSnapshot(ctx) {
  try {
    const active = ctx?.get?.("locale")?.getSnapshot?.()?.active;
    return typeof active === "string" && active ? boardLanguage(active) : null;
  } catch {
    return null;
  }
}

/** Locale sent by our browser on an already admitted request. Invalid values are ignored. */
export function localeFromRequest(req, url) {
  const header = req?.headers?.["x-super-kanban-locale"];
  const query = url?.searchParams?.get?.("locale");
  const value = typeof header === "string" && header.trim() ? header : query;
  if (typeof value !== "string" || !value.trim()) return null;
  const language = boardLanguage(value);
  return LOCALE_ID.test(value.trim()) ? language : null;
}
