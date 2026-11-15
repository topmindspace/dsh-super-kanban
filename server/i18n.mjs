import { AsyncLocalStorage } from "node:async_hooks";
import messages from "../locales/en.mjs";

const languageStorage = new AsyncLocalStorage();

/**
 * Explicit catalog selection. An empty value is not a language: callers that
 * need the install default use {@link boardLanguage}. Any explicit non-Chinese
 * tag, including unsupported ones, uses English.
 */
export function normalizeLanguage(value) {
  return /^zh(?:-|$)/i.test(String(value || "")) ? "zh" : "en";
}

/**
 * Board language for generated text. Missing or malformed input stays Chinese
 * so an existing install keeps its current behavior. Explicit Chinese stays
 * Chinese; English and every other explicit tag use English.
 */
export function boardLanguage(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(text)) return "zh";
  return /^zh(?:-|$)/i.test(text) ? "zh" : "en";
}

/** Language for the current request or scan. Unset work stays Chinese. */
export function currentLanguage() {
  return languageStorage.getStore() || "zh";
}

/** Run `fn` in a board language. A language already on the stack is kept. */
export function runWithLanguage(language, fn) {
  if (languageStorage.getStore()) return fn();
  return languageStorage.run(boardLanguage(language), fn);
}

/**
 * Source-keyed messages keep Chinese lossless without a second drifting catalog.
 * Interpolation is positional and literal: values are never treated as code,
 * HTML, catalog keys or replacement-string syntax. Missing values remain visible.
 */
export function createTranslator(catalog, language = "en") {
  return function translate(source, values = []) {
    const active = typeof language === "function" ? language() : language;
    const chinese = /^zh(?:-|$)/i.test(String(active || ""));
    const message = !chinese && Object.hasOwn(catalog, source) ? catalog[source] : source;
    return message.replace(/\{(\d+)\}/g, (token, index) =>
      Object.hasOwn(values, index) ? String(values[index]) : token);
  };
}

// Generated labels follow the active board language. The Chinese source stays
// the fallback, so evidence, paths and identifiers passed as values are copied
// literally and are never looked up in the catalog.
export const t = createTranslator(messages, currentLanguage);
