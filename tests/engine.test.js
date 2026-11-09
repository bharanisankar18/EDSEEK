import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, findScholarships, deadlineStatus } from "../shared/engine.js";

const schemes = JSON.parse(readFileSync(new URL("../data/scholarships.json", import.meta.url)));
const byId = Object.fromEntries(schemes.map((s) => [s.id, s]));
const TODAY = new Date("2026-11-09");
const r = (id, p) => evaluate(byId[id], p, TODAY);

// A typical PSG iTech-style 1st-year: TN, BC, CSE, govt counselling, ₹1.8 L income.
const priya = {
  state: "TN", level: "UG", year: 1, course: "eng-cse", gender: "female", community: "BC",
  income: 1.8, marks12: 82, above80: false, govtSchool: true, firstGrad: true, quota: "govt75",
  collegeType: "self", hostel: false, disability: false, hardship: "none", tamilMedium: false,
};

test("every scheme in the dataset has a rule", () => {
  for (const s of schemes) assert.doesNotMatch(evaluate(s, priya, TODAY).reason, /No rule written/, s.id);
});

test("empty profile → nothing is eligible, nothing assumed", () => {
  for (const s of schemes) assert.notEqual(evaluate(s, {}, TODAY).result, "eligible", s.id);
});

test("typical TN girl from govt school", () => {
  assert.equal(r("tn-pudhumai-penn", priya).result, "eligible");
  assert.equal(r("tn-first-graduate", priya).result, "eligible");
  assert.equal(r("tn-75-govt-school-quota", priya).result, "eligible");
  assert.equal(r("tn-postmatric-bc-mbc-dnc", priya).result, "eligible");
  assert.equal(r("in-aicte-pragati", priya).result, "eligible");
  assert.equal(r("tn-tamil-pudhalvan", priya).result, "not_eligible"); // boys only
  assert.equal(r("in-aicte-yashasvi", priya).result, "not_eligible"); // CSE not covered
  assert.equal(r("tn-postmatric-scst", priya).result, "not_eligible");
  assert.equal(r("in-csss", priya).result, "not_eligible");
});

test("CM PRF and HDFC ECSS are always Maybe", () => {
  assert.equal(r("tn-cm-prf-be", priya).result, "maybe");
  assert.equal(r("pvt-hdfc-ecss", priya).result, "maybe");
});

test("BC/MBC income between ₹2 L and ₹2.5 L → Maybe", () => {
  assert.equal(r("tn-postmatric-bc-mbc-dnc", { ...priya, income: 2.2 }).result, "maybe");
  assert.equal(r("tn-postmatric-bc-mbc-dnc", { ...priya, income: 3 }).result, "not_eligible");
});

test("non-TN student is never eligible for TN schemes", () => {
  for (const s of schemes.filter((s) => s.id.startsWith("tn-")))
    assert.equal(evaluate(s, { ...priya, state: "other" }, TODAY).result, "not_eligible", s.id);
});

test("unknown field → Maybe and is listed as missing", () => {
  const { income, ...noIncome } = priya;
  const res = r("in-aicte-pragati", noIncome);
  assert.equal(res.result, "maybe");
  assert.deepEqual(res.missing, ["income"]);
});

test("SC hosteller gets HES scheme only when in hostel", () => {
  const sc = { ...priya, community: "SC", income: 2 };
  assert.equal(r("tn-hes-scst-hostellers", { ...sc, hostel: true }).result, "eligible");
  assert.equal(r("tn-hes-scst-hostellers", sc).result, "not_eligible");
});

test("core engineering boy → Yashasvi + Tamil Pudhalvan", () => {
  const boy = { ...priya, gender: "male", course: "eng-core" };
  assert.equal(r("in-aicte-yashasvi", boy).result, "eligible");
  assert.equal(r("tn-tamil-pudhalvan", boy).result, "eligible");
});

test("deadline status", () => {
  assert.equal(deadlineStatus(byId["tn-postmatric-scst"], TODAY).code, "open");
  assert.equal(deadlineStatus(byId["in-csss"], TODAY).code, "closed");
  assert.equal(deadlineStatus(byId["tn-pudhumai-penn"], TODAY).code, "rolling");
  assert.equal(deadlineStatus(byId["tn-first-graduate"], TODAY).code, "admission");
});

test("sorting: eligible + open first", () => {
  const list = findScholarships(schemes, priya, TODAY);
  assert.equal(list[0].result, "eligible");
  assert.equal(list[0].status.code, "open");
  assert.equal(list.at(-1).result, "not_eligible");
});
