import messages from "../locales/en.mjs";

/** Unsupported languages deliberately use English, not Chinese. */
export function normalizeLanguage(value) {
  return /^zh(?:-|$)/i.test(String(value || "")) ? "zh" : "en";
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

// Server-authored labels and analysis instructions default to English. Raw
// session evidence, user-entered text, paths and identifiers are never translated.
export const t = createTranslator(messages);
