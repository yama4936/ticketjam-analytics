import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAdmission,
  classifyTicketType,
} from "../packages/normalization/admission.js";

test("number, prefixes, bands and ranges keep the original value", () => {
  for (const [raw, prefix, lower, upper] of [
    ["A12", "A", 12, 12],
    ["Ｂ１００番台", "B", 100, 199],
    ["1〜50番", null, 1, 50],
    ["1部 A80-85", "A", 80, 85],
    ["整理番号120番台", null, 120, 129],
    ["S1-S30", "S", 1, 30],
    ["S535~545", "S", 535, 545],
    ["S800番代", "S", 800, 899],
  ] as const) {
    const actual = normalizeAdmission(raw);
    assert.deepEqual(
      [actual.raw, actual.prefix, actual.lower, actual.upper],
      [raw, prefix, lower, upper],
    );
  }
});
test("do not interpret quantities, dates, seats or uncertain bounds as admission numbers", () => {
  for (const raw of [
    "コンビニ支払い用紙 A2連番",
    "2枚",
    "2026/10/02",
    "A50-B80",
    "50-1番",
    "100番以内",
    "A12番以内",
    "優先券",
  ]) {
    assert.equal(normalizeAdmission(raw).kind, "unknown", raw);
  }
  assert.equal(normalizeAdmission("1階 12列 3番").kind, "reserved_seat");
  assert.equal(normalizeAdmission("発券前 整理番号未定").kind, "unassigned");
  assert.equal(classifyTicketType("A12"), null);
  assert.equal(classifyTicketType("一般券 A12"), "一般券");
});
