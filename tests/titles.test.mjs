import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTitleKey,
  titleBigramSimilarity,
  titleBigrams,
  titleCharOverlap,
  titleMergeScore,
} from "../server/titles.mjs";

test("normalizeTitleKey strips punctuation, spacing and case", () => {
  assert.equal(normalizeTitleKey("Fix Login!"), "fixlogin");
  assert.equal(normalizeTitleKey("修复 登录-问题（第二轮）"), "修复登录问题第二轮");
  assert.equal(normalizeTitleKey(""), "");
  assert.equal(normalizeTitleKey(null), "");
  assert.equal(normalizeTitleKey(42), "42");
});

test("titleBigrams builds the adjacent-pair set", () => {
  assert.deepEqual([...titleBigrams("abcd")].sort(), ["ab", "bc", "cd"]);
  assert.equal(titleBigrams("a").size, 0);
  assert.equal(titleBigrams("").size, 0);
});

test("titleBigramSimilarity: identical=1, disjoint=0, partial in between", () => {
  assert.equal(titleBigramSimilarity("Fix login", "fix LOGIN"), 1);
  assert.equal(titleBigramSimilarity("完全不同", "implement login flow"), 0);
  assert.equal(titleBigramSimilarity("", ""), 0);
  const partial = titleBigramSimilarity("实现用户登录", "实现用户注册");
  assert.ok(partial > 0.4 && partial < 0.6, `unexpected similarity: ${partial}`);
});

test("titleCharOverlap uses the smaller character set", () => {
  assert.equal(titleCharOverlap("abc", "abcdef"), 1);
  assert.equal(titleCharOverlap("abcd", "wxyz"), 0);
  assert.equal(titleCharOverlap("", "abc"), 0);
  assert.equal(titleCharOverlap("ab", "ab"), 1);
});

test("titleMergeScore takes the discounted character overlap", () => {
  // Combined score is never below the bigram score and never above the
  // (discounted) character overlap when that is higher.
  const pairs = [
    ["实现用户登录", "实现用户注册"],
    ["修复登录问题", "修复登录问题（第二轮）"],
    ["workspace audit", "workspace-audit"],
    ["完全不同的话题", "implement login flow"],
  ];
  for (const [left, right] of pairs) {
    const bigram = titleBigramSimilarity(left, right);
    const chars = titleCharOverlap(left, right) * 0.9;
    assert.equal(titleMergeScore(left, right), Math.max(bigram, chars));
  }
  assert.equal(titleMergeScore("AB", "AB"), 1);
});
