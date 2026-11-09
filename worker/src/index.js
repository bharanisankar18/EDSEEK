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
   hardship. Ask at most 2 questions at a time. Save answers with set_profile. If unknown, continue.
2. ALWAYS call find_scholarships to decide eligibility. Never invent a scholarship, amount, deadline or rule.
3. Show open + eligible first. For each: name, amount, one-line reason, deadline status, documents,
   official link. Say "Maybe" items need which detail.
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
      description: "Save or update fields of the student's profile. Only include fields the student actually told you.",
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

function runTool(name, args, state) {
  if (name === "set_profile") {
    state.profile = { ...state.profile, ...cleanProfile(args) };
    return { saved: true, profile: state.profile };
  }
  if (name === "find_scholarships") {
    state.showResults = true;
    const list = findScholarships(schemes, state.profile);
    const pick = (r) => ({
      id: r.id, name: r.scheme.name, result: r.result, reason: r.reason,
      amount: r.scheme.amount, deadline: r.status.label, verify: r.verify || undefined,
      missing: r.missing.length ? r.missing.map((f) => PROFILE_FIELDS[f]) : undefined,
    });
    return {
      eligible: list.filter((r) => r.result === "eligible").map(pick),
      maybe: list.filter((r) => r.result === "maybe").map(pick),
      not_eligible_count: list.filter((r) => r.result === "not_eligible").length,
    };
  }
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

  for (let step = 0; step < 6; step++) {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages, tools: TOOLS, tool_choice: "auto", temperature: 0.3, max_tokens: 900,
      }),
    });
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

  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const prompt = `This is an Indian student's ${docType} uploaded for a scholarship application (Tamil Nadu).
Read it carefully and fill the JSON. List real problems only: expired or old date, missing seal/signature,
blurred or cut-off parts, wrong document type, name unclear. Do not guess values you cannot see.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: image } }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: DOC_SCHEMA, temperature: 0 },
    }),
  });
  if (!res.ok) {
    console.error("gemini_error", res.status, (await res.text()).slice(0, 500));
    return json({ error: res.status === 429 ? "Certificate checker is busy. Try again in a minute." : "Certificate check failed. Try again." }, 502);
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
  if (!doc.has_seal_or_signature) issues.push("No seal or signature visible");
  if (!doc.is_readable) issues.push("Photo is not clear enough to read");
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
