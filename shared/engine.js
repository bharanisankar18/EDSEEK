// Scholarship Hunter — rule-based eligibility engine.
// Shared by the website (offline mode) and the Cloudflare Worker (agent tool).
// The LLM never decides eligibility: this file does.
//
// Profile fields (any may be missing → "Maybe", never assume):
//   state: "TN" | "other"
//   level: "UG" | "PG" | "Diploma" | "ITI"
//   year: 1..5
//   course: "eng-cse" | "eng-core" | "eng-other" | "medicine" | "law" | "mba" | "arts-science" | "other"
//   gender: "female" | "male" | "other"
//   community: "SC" | "ST" | "SCC" | "BC" | "MBC" | "DNC" | "OC"
//   income: family income in ₹ lakh per year (number)
//   marks12: Class 12 percentage (number)
//   above80: boolean — above 80th percentile of Class 12 board
//   govtSchool: boolean — studied Class 6–12 in a TN Government school
//   firstGrad: boolean — first graduate in the family
//   quota: "govt" | "govt75" | "management"
//   collegeType: "govt" | "aided" | "self"
//   hostel: boolean — staying in the college hostel
//   disability: boolean — disability 40% or more
//   hardship: "none" | "orphan" | "parent-lost" | "parent-ill"
//   tamilMedium: boolean — studying in Tamil-medium classes

export const PROFILE_FIELDS = {
  state: "State",
  level: "Level (UG / PG / Diploma / ITI)",
  year: "Year of study",
  course: "Course",
  gender: "Gender",
  community: "Community",
  income: "Family income",
  marks12: "Class 12 %",
  above80: "Above 80th percentile in Class 12",
  govtSchool: "Class 6–12 in TN Government school",
  firstGrad: "First graduate in family",
  quota: "Admission quota",
  collegeType: "College type",
  hostel: "Staying in college hostel",
  disability: "Disability 40% or more",
  hardship: "Family hardship",
  tamilMedium: "Tamil-medium course",
};

const unknown = (v) => v === undefined || v === null || v === "" || Number.isNaN(v);
const ENG = ["eng-cse", "eng-core", "eng-other"];

// ---- check helpers: each returns { s: "y" | "n" | "?", why, field? } ----

function need(p, field, pred, yes, no) {
  const v = p[field];
  if (unknown(v)) return { s: "?", field, why: `need: ${PROFILE_FIELDS[field]}` };
  return pred(v) ? { s: "y", why: yes } : { s: "n", why: no };
}

const tn = (p) => need(p, "state", (v) => v === "TN", "Tamil Nadu student", "Only for Tamil Nadu students");

const levelIn = (p, levels) =>
  need(p, "level", (v) => levels.includes(v), `${p.level} is covered`, `Not for ${p.level} students (only ${levels.join(" / ")})`);

const female = (p) => need(p, "gender", (v) => v === "female", "Girl students", "Only for girl students");

const firstYear = (p, lateral = false) => {
  if (unknown(p.year)) return { s: "?", field: "year", why: `need: ${PROFILE_FIELDS.year}` };
  if (p.year === 1) return { s: "y", why: "1st-year students apply" };
  if (lateral && p.year === 2) return { s: "?", why: "2nd year allowed only if you joined by lateral entry" };
  return { s: "n", why: "Only for 1st-year students (fresh applications)" };
};

const engineering = (p) =>
  need(p, "course", (v) => ENG.includes(v), "Engineering course", "Only for Engineering students");

// AICTE technical courses: engineering yes; "other" might be Pharmacy/Architecture → maybe
const aicteCourse = (p) => {
  if (unknown(p.course)) return { s: "?", field: "course", why: `need: ${PROFILE_FIELDS.course}` };
  if (ENG.includes(p.course)) return { s: "y", why: "AICTE technical course" };
  if (p.course === "other") return { s: "?", why: "Only AICTE technical courses (Pharmacy, Architecture etc. count) — check yours" };
  return { s: "n", why: "Only for AICTE technical courses (Engineering, Pharmacy, Architecture)" };
};

// Income: <= sure → yes; <= max → maybe (sources conflict); above → no
function income(p, sure, max = sure, maybeWhy = "") {
  const v = p.income;
  if (unknown(v)) return { s: "?", field: "income", why: `need: ${PROFILE_FIELDS.income}` };
  if (v <= sure) return { s: "y", why: `Income ₹${v} L is within ₹${sure} L` };
  if (v <= max) return { s: "?", why: maybeWhy || `Income limit is ₹${sure} L (some sources say ₹${max} L) — verify` };
  return { s: "n", why: `Family income must be ₹${max} L or less` };
}

const marks = (p, min) =>
  need(p, "marks12", (v) => v >= min, `Class 12 marks ${p.marks12}% (needs ${min}%)`, `Needs at least ${min}% in Class 12`);

// For schemes that check "previous year" marks: Class 12 marks only count in 1st year.
function prevYearMarks(p, min) {
  if (!unknown(p.year) && p.year > 1) return { s: "?", why: `Needs ${min}% in your previous year's exam` };
  return marks(p, min);
}

const yesField = (p, field, yes, no) => need(p, field, (v) => v === true, yes, no);
const maybe = (why) => ({ s: "?", why });

// ---- one rule per scheme id ----

const RULES = {
  "tn-first-graduate": (p) => [
    tn(p), levelIn(p, ["UG"]), engineering(p), firstYear(p, true),
    need(p, "quota", (v) => v !== "management", "Admitted through TNEA counselling", "Only for TNEA counselling admissions (not management quota)"),
    yesField(p, "firstGrad", "First graduate in family", "Only if no parent or sibling is a graduate"),
  ],

  "tn-75-govt-school-quota": (p) => [
    tn(p), levelIn(p, ["UG"]),
    yesField(p, "govtSchool", "Studied Class 6–12 in a TN Govt school", "Only for students who studied Class 6–12 in a TN Government school"),
    need(p, "quota", (v) => v === "govt75", "Admitted under the 7.5% quota", "Only for students admitted under the 7.5% Govt-school quota"),
    unknown(p.course) ? { s: "?", field: "course", why: `need: ${PROFILE_FIELDS.course}` }
      : [...ENG, "medicine", "law"].includes(p.course) ? { s: "y", why: "Course is covered" }
      : p.course === "other" ? maybe("Covers Engineering, Medical, Agriculture, Veterinary, Law, Fisheries — check your course")
      : { s: "n", why: "Course not covered (Engineering, Medical, Agriculture, Veterinary, Law, Fisheries only)" },
  ],

  "tn-cm-prf-be": (p) => [
    tn(p), levelIn(p, ["UG"]), engineering(p),
    maybe("For economically weaker students — income limit not published, ask your college / DoTE"),
  ],

  "tn-pg-assistantship": (p) => [
    tn(p), levelIn(p, ["PG"]), engineering(p),
    need(p, "collegeType", (v) => v === "govt", "Government Engineering College", "Only in Government Engineering Colleges"),
    need(p, "quota", (v) => v !== "management", "Admitted through counselling", "Only for counselling admissions"),
    maybe("Only for non-GATE M.E/M.Tech students — confirm you were admitted without GATE"),
  ],

  "tn-postmatric-scst": (p) => [
    tn(p),
    need(p, "community", (v) => ["SC", "ST", "SCC"].includes(v), `${p.community} community`, "Only for SC / ST / SC(A) / SCC students"),
    income(p, 2.5),
  ],

  "tn-postmatric-bc-mbc-dnc": (p) => [
    tn(p), levelIn(p, ["UG", "PG", "Diploma"]),
    need(p, "community", (v) => ["BC", "MBC", "DNC"].includes(v), `${p.community} community`, "Only for BC / MBC / DNC students"),
    income(p, 2, 2.5, "Limit is ₹2 L (some sources say ₹2.5 L) — verify with your college"),
    need(p, "quota", (v) => v !== "management", "Government quota admission", "Management quota is generally not eligible"),
  ],

  "tn-pudhumai-penn": (p) => [
    tn(p), female(p), levelIn(p, ["UG", "Diploma", "ITI"]),
    yesField(p, "govtSchool", "Studied Class 6–12 in a TN Govt school", "Only for girls who studied Class 6–12 in a TN Government school"),
  ],

  "tn-tamil-pudhalvan": (p) => [
    tn(p),
    need(p, "gender", (v) => v === "male", "Boy students", "Only for boy students"),
    levelIn(p, ["UG", "Diploma", "ITI"]),
    unknown(p.govtSchool) ? { s: "?", field: "govtSchool", why: `need: ${PROFILE_FIELDS.govtSchool}` }
      : p.govtSchool ? { s: "y", why: "Studied Class 6–12 in a TN Govt school (must be Tamil medium)" }
      : maybe("Also open to Govt-aided Tamil-medium school students — check if your school was one"),
  ],

  "tn-hes-scst-hostellers": (p) => [
    tn(p), levelIn(p, ["UG", "PG", "Diploma"]),
    need(p, "community", (v) => ["SC", "ST", "SCC"].includes(v), `${p.community} community`, "Only for SC / ST / SCC students"),
    income(p, 2.5),
    yesField(p, "hostel", "Staying in the college hostel", "Only for students staying in the college hostel"),
  ],

  "tn-differently-abled": (p) => [
    tn(p), levelIn(p, ["UG", "PG", "Diploma"]),
    yesField(p, "disability", "Disability 40% or more", "Only for students with 40% or more disability"),
  ],

  "tn-evr-nagammai": (p) => [
    tn(p), female(p), levelIn(p, ["UG"]),
    need(p, "course", (v) => v === "arts-science", "Arts & Science course", "Only for Arts & Science (non-professional) courses"),
    need(p, "collegeType", (v) => v === "govt" || v === "aided", "Govt / Aided college", "Only in Government or Government-aided colleges"),
    income(p, 0.24, 0.5, "Official limit ₹24,000/yr, one source says ₹50,000 — verify"),
  ],

  "tn-tamil-medium-stipend": (p) => [
    tn(p), levelIn(p, ["UG", "PG"]),
    need(p, "course", (v) => v === "arts-science", "Arts & Science course", "Only for Arts & Science courses"),
    yesField(p, "tamilMedium", "Studying in Tamil-medium classes", "Only for students in Tamil-medium classes"),
  ],

  "in-csss": (p) => [
    levelIn(p, ["UG", "PG"]),
    yesField(p, "above80", "Above 80th percentile in Class 12", "Needs above 80th percentile of your Class 12 board"),
    income(p, 4.5),
    unknown(p.year) ? { s: "?", field: "year", why: `need: ${PROFILE_FIELDS.year}` }
      : p.year === 1 ? { s: "y", why: "Fresh application in 1st year" }
      : maybe("After 1st year only renewals are allowed — only if you got it in 1st year"),
  ],

  "in-aicte-pragati": (p) => [
    female(p), levelIn(p, ["UG", "Diploma"]), aicteCourse(p), firstYear(p, true), income(p, 8),
  ],

  "in-aicte-saksham": (p) => [
    yesField(p, "disability", "Disability 40% or more", "Only for students with 40% or more disability"),
    levelIn(p, ["UG", "Diploma"]), aicteCourse(p), firstYear(p, true), income(p, 8),
  ],

  "in-aicte-swanath": (p) => [
    unknown(p.hardship) ? { s: "?", field: "hardship", why: `need: ${PROFILE_FIELDS.hardship}` }
      : p.hardship === "orphan" || p.hardship === "parent-ill" ? { s: "y", why: "Family hardship category covered" }
      : p.hardship === "parent-lost" ? maybe("Covered if a parent died of COVID-19 or was a martyred Armed / Police personnel")
      : { s: "n", why: "Only for orphans, COVID-19 / martyr's wards, or parent critically ill" },
    levelIn(p, ["UG", "Diploma"]), aicteCourse(p), income(p, 8),
  ],

  "in-aicte-yashasvi": (p) => [
    levelIn(p, ["UG", "Diploma"]),
    unknown(p.course) ? { s: "?", field: "course", why: `need: ${PROFILE_FIELDS.course}` }
      : p.course === "eng-core" ? { s: "y", why: "Core engineering branch" }
      : p.course === "eng-other" ? maybe("Only core branches: Civil, Chemical, Electrical, ECE, Mechanical, Agri, Textile")
      : { s: "n", why: "Only for core engineering branches (not CSE / IT)" },
    firstYear(p, true),
    income(p, 8),
  ],

  "pvt-ongc-merit": (p) => [
    levelIn(p, ["UG", "PG"]),
    unknown(p.course) ? { s: "?", field: "course", why: `need: ${PROFILE_FIELDS.course}` }
      : [...ENG, "medicine", "mba"].includes(p.course) ? { s: "y", why: "Course is covered" }
      : p.course === "other" ? maybe("Covers Engineering, MBBS, MBA, M.Sc Geology/Geophysics — check your course")
      : { s: "n", why: "Only Engineering, MBBS, MBA, M.Sc Geology/Geophysics" },
    firstYear(p),
    marks(p, 60),
    unknown(p.community) ? { s: "?", field: "community", why: `need: ${PROFILE_FIELDS.community}` }
      : ["SC", "ST", "SCC"].includes(p.community) ? income(p, 4.5)
      : income(p, 2), // OBC and General-EWS: below ₹2 L
    // Age ≤ 30 is not asked — nearly every 1st-year student meets it; shown in the scheme details.
  ],

  "pvt-ffe": (p) => [
    levelIn(p, ["UG"]), firstYear(p),
    need(p, "course", (v) => [...ENG, "medicine", "law"].includes(v), "Course is covered", "Only B.E/B.Tech, MBBS, Integrated LLB"),
    marks(p, 70),
    income(p, 3, 4, "Limit ₹3 L (one listing says ₹4 L) — verify"),
  ],

  "pvt-sitaram-jindal": (p) => [
    income(p, 2.5, 4, "Up to ₹4 L only for salaried families (₹2.5 L for others)"),
  ],

  "pvt-reliance-ug": (p) => [
    levelIn(p, ["UG"]), firstYear(p), marks(p, 60),
    income(p, 15),
  ],

  "pvt-kotak-kanya": (p) => [
    female(p), levelIn(p, ["UG"]), firstYear(p),
    unknown(p.course) ? { s: "?", field: "course", why: `need: ${PROFILE_FIELDS.course}` }
      : [...ENG, "medicine", "law"].includes(p.course) ? { s: "y", why: "Professional UG course" }
      : p.course === "other" ? maybe("Only professional UG (Engineering, MBBS, LLB, Architecture, Design)")
      : { s: "n", why: "Only for professional UG courses" },
    marks(p, 75),
    income(p, 6),
  ],

  "pvt-lic-gjf": (p) => [
    levelIn(p, ["UG", "Diploma", "ITI"]), firstYear(p), marks(p, 60),
    income(p, 2.5, 4.5, "Limit ₹4.5 L (one source says ₹2.5 L) — verify"),
  ],

  "pvt-tata-pankh": (p) => [
    levelIn(p, ["UG", "Diploma", "ITI"]), prevYearMarks(p, 60),
    income(p, 2.5, 4, "Limit ₹4 L (some sources say ₹2.5 L) — verify"),
  ],

  "pvt-hdfc-ecss": (p) => [
    levelIn(p, ["UG"]),
    !unknown(p.hardship) && p.hardship !== "none"
      ? maybe("Need-based: your family situation may qualify — check criteria")
      : maybe("Need-based: only for families facing a personal / financial crisis"),
  ],
};

// ---- deadline status ----

export function deadlineStatus(s, today = new Date()) {
  const t = new Date(today.toISOString().slice(0, 10));
  if (s.deadline_iso) {
    const d = new Date(s.deadline_iso);
    const days = Math.round((d - t) / 86400000);
    if (days >= 0) return { code: "open", label: days === 0 ? "Open — last day today" : `Open — ${days} day${days === 1 ? "" : "s"} left`, days };
    return { code: "closed", label: "Closed for this cycle", days };
  }
  const st = (s.status_2026_27 || "").toLowerCase();
  if (st.includes("rolling")) return { code: "rolling", label: "Rolling — apply anytime" };
  if (st.includes("admission")) return { code: "admission", label: "At admission" };
  return { code: "check", label: "Check with college" };
}

export const needsVerify = (s) => /VERIFY|CONFLICT/i.test(`${s.notes} ${s.income_rule} ${s.deadline_note}`);

// ---- main entry ----

const RANK = { eligible: 0, maybe: 1, not_eligible: 2 };
const STATUS_RANK = { open: 0, rolling: 1, admission: 2, check: 3, closed: 4 };

export function evaluate(scheme, profile = {}, today = new Date()) {
  const rule = RULES[scheme.id];
  const checks = rule ? rule(profile) : [maybe("No rule written for this scheme yet — check the official site")];
  const fails = checks.filter((c) => c.s === "n");
  const unsure = checks.filter((c) => c.s === "?");
  const result = fails.length ? "not_eligible" : unsure.length ? "maybe" : "eligible";
  const reason = fails.length ? fails[0].why
    : unsure.length ? unsure.map((c) => c.why).join("; ")
    : checks.map((c) => c.why).join(" · ");
  return {
    id: scheme.id,
    result,
    reason,
    missing: [...new Set(unsure.filter((c) => c.field).map((c) => c.field))],
    status: deadlineStatus(scheme, today),
    verify: needsVerify(scheme),
  };
}

export function findScholarships(schemes, profile = {}, today = new Date()) {
  return schemes
    .map((s) => ({ scheme: s, ...evaluate(s, profile, today) }))
    .sort((a, b) =>
      RANK[a.result] - RANK[b.result] ||
      STATUS_RANK[a.status.code] - STATUS_RANK[b.status.code] ||
      (a.status.days ?? 9999) - (b.status.days ?? 9999) ||
      (b.scheme.amount_yearly_inr || 0) - (a.scheme.amount_yearly_inr || 0));
}
