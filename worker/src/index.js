// Scholarship Hunter — Cloudflare Worker
// POST /api/chat       { messages: [{role, content}], profile }  → { reply, profile, showResults }
// POST /api/check-doc  { image (base64), mimeType, docType, studentName } → { verdict, issues, ... }
// GET  /api/health     → { ok, groq, gemini }
//
// Secrets (worker/.dev.vars locally, `wrangler secret put` in production): GROQ_API_KEY, GEMINI_API_KEY

import schemes from "../../data/scholarships.json";
import { findScholarships, PROFILE_FIELDS } from "../../shared/engine.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_MESSAGES = 16;
const MAX_MSG_CHARS = 2000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const SYSTEM_PROMPT = `You are Scholarship Hunter, an assistant that helps Indian college students (starting with Tamil Nadu)
find scholarships they qualify for.
1. Build the student's profile first: state, course and year, gender, community, family income,
   Class 12 %, government school (Class 6-12), first graduate, quota, college type, hostel, disability,
   hardship. Ask at most 2 questions at a time. If unknown, continue.
   FIRST save EVERY detail the student already gave (in any language) with ONE set_profile call —
   e.g. "முதலாம் ஆண்டு மெக்கானிக்கல் மாணவன், அரசுப் பள்ளி, வருமானம் 2 லட்சம்" →
   {year:1, level:"UG", course:"eng-core", gender:"male", govtSchool:true, income:2}. Never ask again for a saved detail.
2. Eligibility comes ONLY from set_profile / find_scholarships results. Never invent a scholarship, amount, deadline or rule.
3. Show open + eligible first: name, amount, one-line reason, deadline. Use scholarship_details only when the
   student asks for documents or how to apply. For "Maybe" items, ask the details listed in ask_next.
4. If notes say VERIFY or CONFLICT, tell the student to confirm on the official site.
5. Short, friendly, phone-sized replies. Reply in Tamil if the student writes in Tamil.
Plain text only (no markdown tables). Today is ${new Date().toISOString().slice(0, 10)}.`;

// ---------- tools ----------

const yesNo = { type: "boolean" };
const TOOLS = [
  {
    type: "function",
    function: {
      name: "set_profile",
      description: "Save profile fields the student told you. Returns the updated eligibility results — no need to call find_scholarships after it.",
      parameters: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["TN", "other"] },
          level: { type: "string", enum: ["UG", "PG", "Diploma", "ITI"] },
          year: { type: "integer", minimum: 1, maximum: 5 },
          course: { type: "string", enum: ["eng-cse", "eng-core", "eng-other", "medicine", "law", "mba", "arts-science", "other"],
            description: "eng-cse = CSE/IT; eng-core = Civil/Mech/EEE/ECE/Chemical; eng-other = other engineering" },
          gender: { type: "string", enum: ["female", "male", "other"] },
          community: { type: "string", enum: ["SC", "ST", "SCC", "BC", "MBC", "DNC", "OC"], description: "OC = General" },
          income: { type: "number", description: "Family income in rupees LAKH per year, e.g. 1.8" },
          marks12: { type: "number", description: "Class 12 percentage" },
          above80: { ...yesNo, description: "Above 80th percentile of Class 12 board" },
          govtSchool: { ...yesNo, description: "Studied Class 6-12 in a Tamil Nadu Government school" },
          firstGrad: { ...yesNo, description: "First graduate in the family" },
          quota: { type: "string", enum: ["govt", "govt75", "management"], description: "govt = Government counselling, govt75 = 7.5% govt-school quota" },
          collegeType: { type: "string", enum: ["govt", "aided", "self"], description: "self = self-financing" },
          hostel: { ...yesNo, description: "Staying in the college hostel" },
          disability: { ...yesNo, description: "Disability 40% or more" },
          hardship: { type: "string", enum: ["none", "orphan", "parent-lost", "parent-ill"] },
          tamilMedium: { ...yesNo, description: "Studying in Tamil-medium classes" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_scholarships",
      description: "Run the rule engine on the saved profile. Returns eligible and maybe schemes with reasons. Always use this to decide eligibility.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "scholarship_details",
      description: "Full details of one scheme: documents, how to apply, official link, notes.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
];

const ALLOWED_FIELDS = new Set(Object.keys(PROFILE_FIELDS));

function cleanProfile(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (ALLOWED_FIELDS.has(k) && v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

// Compact on purpose: Groq free tier allows ~8k tokens/minute.
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);
function results(state) {
  state.showResults = true;
  const list = findScholarships(schemes, state.profile);
  const pick = (r) => ({
    id: r.id, name: cut(r.scheme.name, 60), reason: cut(r.reason, 120),
    amount: cut(r.scheme.amount, 70), deadline: r.status.label, verify: r.verify || undefined,
  });
  const eligible = list.filter((r) => r.result === "eligible");
  const maybe = list.filter((r) => r.result === "maybe");
  const missing = [...new Set(maybe.flatMap((r) => r.missing))].map((f) => PROFILE_FIELDS[f]);
  return {
    eligible: eligible.map(pick),
    maybe: maybe.slice(0, 6).map(pick),
    more_maybe: Math.max(0, maybe.length - 6),
    ask_next: missing.slice(0, 4),
    not_eligible_count: list.length - eligible.length - maybe.length,
  };
}

function runTool(name, args, state) {
  if (name === "set_profile") {
    state.profile = { ...state.profile, ...cleanProfile(args) };
    return { saved: true, ...results(state) };
  }
  if (name === "find_scholarships") return results(state);
  if (name === "scholarship_details") {
    const s = schemes.find((x) => x.id === args.id);
    if (!s) return { error: `No scheme with id ${args.id}` };
    const { agent_summary, source_link, tags, ...rest } = s;
    return rest;
  }
  return { error: `Unknown tool ${name}` };
}

async function chat(body, env) {
  if (!env.GROQ_API_KEY) return json({ error: "GROQ_API_KEY not set — running in offline mode" }, 503);

  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  if (!history.length || history.at(-1).role !== "user") return json({ error: "Last message must be from the user" }, 400);

  const state = { profile: cleanProfile(body.profile), showResults: false };
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT}\nCurrent saved profile: ${JSON.stringify(state.profile)}` },
    ...history,
  ];

  const model = env.GROQ_MODEL || "openai/gpt-oss-120b";
  const callGroq = () => fetch(GROQ_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.3, max_tokens: 1500,
      ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: env.GROQ_REASONING || "medium" } : {}),
    }),
  });

  for (let step = 0; step < 4; step++) {
    let res = await callGroq();
    // Free-tier limit: if Groq says "try again in ≤ 20 s", wait once and retry.
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after"));
      if (wait > 0 && wait <= 20) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        res = await callGroq();
      }
    }
    // Model produced a malformed tool call (Groq "tool_use_failed") → try once more.
    if (res.status === 400) {
      const detail = await res.clone().text();
      if (detail.includes("tool_use_failed")) {
        console.warn("groq_tool_use_failed_retry", detail.slice(0, 200));
        res = await callGroq();
      }
    }
    if (!res.ok) {
      const detail = await res.text();
      console.error("groq_error", res.status, detail.slice(0, 500));
      const msg = res.status === 429 ? "The AI is busy (free-tier limit). Try again in a minute." : "The AI service failed. Try again.";
      return json({ error: msg, profile: state.profile }, 502);
    }
    const msg = (await res.json()).choices?.[0]?.message;
    if (!msg) return json({ error: "Empty reply from AI", profile: state.profile }, 502);

    if (!msg.tool_calls?.length) {
      return json({ reply: msg.content || "", profile: state.profile, showResults: state.showResults });
    }
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}") || {}; } catch { /* bad JSON from model → empty args */ }
      const result = runTool(call.function.name, args, state);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return json({ reply: "Sorry, I got stuck. Please rephrase your question.", profile: state.profile, showResults: state.showResults });
}

// ---------- certificate check (Gemini vision) ----------

const DOC_SCHEMA = {
  type: "object",
  properties: {
    doc_type_detected: { type: "string", description: "e.g. Income certificate, Community certificate, First Graduate certificate, Marksheet, Other" },
    name_on_doc: { type: "string" },
    issue_date: { type: "string", description: "YYYY-MM-DD or empty if not visible" },
    valid_until: { type: "string", description: "YYYY-MM-DD or empty if not stated" },
    issuing_authority: { type: "string" },
    annual_income_inr: { type: "number", description: "0 if not an income certificate" },
    has_seal_or_signature: { type: "boolean" },
    is_readable: { type: "boolean" },
    issues: { type: "array", items: { type: "string" }, description: "Problems a scholarship officer would reject it for" },
  },
  required: ["doc_type_detected", "name_on_doc", "issue_date", "has_seal_or_signature", "is_readable", "issues"],
};

const normName = (s) => (s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1).sort().join(" ");

async function checkDoc(body, env) {
  if (!env.GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not set — certificate check unavailable" }, 503);
  const { image, mimeType, docType = "certificate", studentName = "" } = body;
  if (typeof image !== "string" || !/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(mimeType || ""))
    return json({ error: "Send a JPG, PNG, WEBP or PDF" }, 400);
  if (image.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: "File too large (max 4 MB)" }, 413);

  const model = env.GEMINI_MODEL || "gemini-flash-lite-latest";
  const prompt = `This is an Indian student's ${docType} uploaded for a scholarship application (Tamil Nadu).
Read it carefully and fill the JSON. List real problems only: expired or old date, missing seal/signature,
blurred or cut-off parts, wrong document type, name unclear. Do not guess values you cannot see.`;

  // 25 s timeout: the bigger Gemini models sometimes hang for minutes on the free tier.
  const callGemini = (m) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(25000),
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: image } }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: DOC_SCHEMA, temperature: 0 },
    }),
  }).catch((err) => {
    console.warn("gemini_timeout", m, err?.name);
    return new Response("timeout", { status: 504 });
  });

  let res = await callGemini(model);
  // Busy (503), free-tier limit (429) or timeout (504) → try the fallback model once.
  const fallback = env.GEMINI_FALLBACK_MODEL || "gemini-flash-latest";
  if ([429, 503, 504].includes(res.status) && fallback !== model) {
    console.warn("gemini_fallback", model, res.status);
    res = await callGemini(fallback);
  }
  if (!res.ok) {
    console.error("gemini_error", res.status, (await res.text()).slice(0, 500));
    const busy = [429, 503, 504].includes(res.status);
    return json({ error: busy ? "Certificate checker is busy. Try again in a minute." : "Certificate check failed. Try again." }, 502);
  }
  let doc;
  try {
    doc = JSON.parse((await res.json()).candidates[0].content.parts[0].text);
  } catch {
    return json({ error: "Could not read the certificate. Try a clearer photo." }, 502);
  }

  // Rule checks on top of what the model saw
  const issues = [...(doc.issues || [])];
  const today = new Date();
  if (doc.valid_until && new Date(doc.valid_until) < today) issues.push(`Expired on ${doc.valid_until}`);
  else if (doc.issue_date && /income/i.test(`${docType} ${doc.doc_type_detected}`)) {
    const ageDays = (today - new Date(doc.issue_date)) / 86400000;
    if (ageDays > 365) issues.push(`Income certificate issued ${doc.issue_date} — most schemes need one from the last 12 months`);
  }
  const mentioned = (re) => issues.some((i) => re.test(i));
  if (!doc.has_seal_or_signature && !mentioned(/seal|signature/i)) issues.push("No seal or signature visible");
  if (!doc.is_readable && !mentioned(/blur|clear|read/i)) issues.push("Photo is not clear enough to read");
  if (studentName && doc.name_on_doc && normName(studentName) !== normName(doc.name_on_doc))
    issues.push(`Name on certificate "${doc.name_on_doc}" does not match "${studentName}" — check spelling / initials`);

  const unique = [...new Set(issues)];
  return json({ ...doc, issues: unique, verdict: unique.length ? "problem" : "ok" });
}

// ---------- http ----------

let corsOrigin = "*";
const corsHeaders = () => ({
  "access-control-allow-origin": corsOrigin,
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
});
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

export default {
  async fetch(request, env) {
    corsOrigin = env.ALLOWED_ORIGIN || "*";
    const { pathname } = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      if (pathname === "/api/health") return json({ ok: true, groq: !!env.GROQ_API_KEY, gemini: !!env.GEMINI_API_KEY, schemes: schemes.length });
      if (request.method !== "POST") return json({ error: "Not found" }, 404);

      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (pathname === "/api/chat") return await chat(body, env);
      if (pathname === "/api/check-doc") return await checkDoc(body, env);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error("unhandled", pathname, err?.stack || err);
      return json({ error: "Server error" }, 500);
    }
  },
};
