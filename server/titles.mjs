/**
 * Super Kanban — title similarity for duplicate-card detection.

 * Boundary: pure string scoring used by the merge policy in service.mjs. No
 * state, IO or LLM tokens; deterministic so cross-scan merges stay stable.
 * (analyzer-rules.mjs has its own `titleSimilarity` for rule-based clustering;
 * keep the two separate — this one is tuned for the conservative merge gate.)
 */

/** Lowercase alphanumerics only; punctuation and whitespace are ignored. */
export function normalizeTitleKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

/** Set of character bigrams (CJK-friendly similarity unit). */
export function titleBigrams(value) {
  const text = normalizeTitleKey(value);
  const set = new Set();
  for (let index = 0; index < text.length - 1; index++) set.add(text.slice(index, index + 2));
  return set;
}

/** Bigram Jaccard similarity in [0, 1]. */
export function titleBigramSimilarity(left, right) {
  const a = titleBigrams(left);
  const b = titleBigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

/** Character-set overlap divided by the smaller title length. */
export function titleCharOverlap(left, right) {
  const a = new Set(normalizeTitleKey(left));
  const b = new Set(normalizeTitleKey(right));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const char of a) if (b.has(char)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

/** Conservative duplicate score: bigram Jaccard, char overlap discounted. */
export function titleMergeScore(left, right) {
  return Math.max(titleBigramSimilarity(left, right), titleCharOverlap(left, right) * 0.9);
}
