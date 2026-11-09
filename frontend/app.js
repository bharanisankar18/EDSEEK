import { findScholarships, PROFILE_FIELDS } from "../shared/engine.js";

const API = window.API_BASE;
const $ = (s) => document.querySelector(s);
const form = $("#profile-form");
let schemes = [];
let online = { groq: false, gemini: false };
const chatHistory = [];

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- profile <-> form ----------

function readProfile() {
  const p = {};
  for (const field of form.elements) {
    if (!field.name || field.value === "") continue;
    const t = field.dataset.type;
    p[field.name] = t === "number" ? Number(field.value) : t === "bool" ? field.value === "yes" : field.value;
  }
  return p;
}

function writeProfile(p) {
  for (const field of form.elements) {
    if (!field.name) continue;
    const v = p[field.name];
    field.value = v === undefined || v === null ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
  }
}

// ---------- calendar ----------

const ymd = (d) => d.toISOString().slice(0, 10).replaceAll("-", "");
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function reminderDate(s, status) {
  if (status.code === "open") return { date: new Date(s.deadline_iso), title: `Deadline: ${s.name}` };
  if (status.code === "closed") {
    const d = new Date(s.deadline_iso);
    // NSP / AICTE reopen around June; others: ~6 weeks before last year's deadline
    const next = /NSP/i.test(s.deadline_note) ? new Date(Date.UTC(d.getUTCFullYear() + 1, 5, 1))
      : addDays(new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate())), -45);
    return { date: next, title: `Check if open: ${s.name}`, next: true };
  }
  return null;
}

function googleCalLink(s, r) {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: r.title,
    dates: `${ymd(r.date)}/${ymd(addDays(r.date, 1))}`,
    details: `${s.amount}\nDocuments: ${s.documents}\nApply: ${s.official_link || s.apply_via}`,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

function downloadIcs(s, r) {
  const esc = (t) => String(t || "").replace(/[\\,;]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Scholarship Hunter//EN", "BEGIN:VEVENT",
    `UID:${s.id}-${ymd(r.date)}@scholarship-hunter`, `DTSTAMP:${ymd(new Date())}T000000Z`,
    `DTSTART;VALUE=DATE:${ymd(r.date)}`, `DTEND;VALUE=DATE:${ymd(addDays(r.date, 1))}`,
    `SUMMARY:${esc(r.title)}`,
    `DESCRIPTION:${esc(`${s.amount}\nDocuments: ${s.documents}\nApply: ${s.official_link || s.apply_via}`)}`,
    "BEGIN:VALARM", "TRIGGER:-P3D", "ACTION:DISPLAY", `DESCRIPTION:${esc(r.title)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const a = el("a", { href: URL.createObjectURL(new Blob([ics], { type: "text/calendar" })), download: `${s.id}.ics` });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- results ----------

const BADGE = { eligible: "✅ Eligible", maybe: "🟡 Maybe", not_eligible: "❌ Not eligible" };

function card(r) {
  const s = r.scheme;
  const rem = r.result !== "not_eligible" ? reminderDate(s, r.status) : null;
  return el("div", { class: `card ${r.result}` },
    el("h3", {}, s.name),
    el("p", {}, el("span", { class: "badge" }, BADGE[r.result]), ` · ${r.status.label}`),
    el("p", {}, el("b", {}, "Amount: "), s.amount),
    el("p", {}, el("b", {}, "Why: "), r.reason),
    r.verify ? el("p", { class: "warn" }, "⚠ Some details conflict between sources — confirm on the official site.") : null,
    r.result !== "not_eligible" ? el("details", {},
      el("summary", {}, "Documents & how to apply"),
      el("p", {}, el("b", {}, "Documents: "), s.documents || "—"),
      el("p", {}, el("b", {}, "Apply via: "), s.apply_via || "—"),
      el("p", {}, el("b", {}, "Deadline: "), s.deadline_note || "—"),
      s.notes ? el("p", {}, el("b", {}, "Note: "), s.notes) : null,
      el("p", {}, el("b", {}, "Provider: "), s.provider)) : null,
    el("div", { class: "actions" },
      s.official_link ? el("a", { href: s.official_link, target: "_blank", rel: "noopener" }, "Official site ↗") : null,
      rem ? el("a", { href: googleCalLink(s, rem), target: "_blank", rel: "noopener" }, rem.next ? "Remind me next cycle (Google)" : "Add to Google Calendar") : null,
      rem ? el("button", { type: "button", onclick: () => downloadIcs(s, rem) }, "Download .ics") : null));
}

function renderResults() {
  const profile = readProfile();
  store.set("profile", profile);
  const list = findScholarships(schemes, profile);
  const groups = { eligible: [], maybe: [], not_eligible: [] };
  for (const r of list) groups[r.result].push(r);

  const missing = [...new Set(groups.maybe.flatMap((r) => r.missing))];
  $("#summary").textContent =
    `${groups.eligible.length} eligible · ${groups.maybe.length} maybe · ${groups.not_eligible.length} not eligible.` +
    (missing.length ? ` Fill these to clear the "Maybe"s: ${missing.map((f) => PROFILE_FIELDS[f]).join(", ")}.` : "");

  $("#eligible").replaceChildren(...(groups.eligible.length ? [el("h3", {}, "Eligible"), ...groups.eligible.map(card)] : []));
  $("#maybe").replaceChildren(...(groups.maybe.length ? [el("h3", {}, "Maybe — check these"), ...groups.maybe.map(card)] : []));
  $("#not").replaceChildren(...groups.not_eligible.map(card));
  $("#not-wrap").hidden = !groups.not_eligible.length;
}

// ---------- chat ----------

function addMsg(role, text) {
  const m = el("div", { class: `msg ${role}` }, role === "user" ? el("span", {}, text) : text);
  $("#log").append(m);
  $("#log").scrollTop = $("#log").scrollHeight;
  return m;
}

async function sendChat(e) {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addMsg("user", text);
  chatHistory.push({ role: "user", content: text });

  if (!online.groq) {
    addMsg("error", "Chat is offline right now. Use the form above — it works without the internet AI.");
    return;
  }
  const thinking = addMsg("bot", "…");
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: chatHistory, profile: readProfile() }),
    });
    const data = await res.json();
    if (data.profile) writeProfile(data.profile);
    if (!res.ok) throw new Error(data.error || "Chat failed");
    thinking.textContent = data.reply;
    chatHistory.push({ role: "assistant", content: data.reply });
    renderResults();
    if (data.showResults) addMsg("hint", "↑ Results updated in section 2.");
  } catch (err) {
    thinking.className = "msg error";
    thinking.textContent = err.message;
    chatHistory.pop();
  }
}

// ---------- certificate check ----------

// Shrink phone photos to ≤1600px JPEG so uploads are fast and under the 4 MB limit.
async function fileToBase64(file) {
  if (file.type === "application/pdf") {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { data: btoa(bin), mimeType: file.type };
  }
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = el("canvas", { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return { data: canvas.toDataURL("image/jpeg", 0.85).split(",")[1], mimeType: "image/jpeg" };
}

async function checkDoc(e) {
  e.preventDefault();
  const out = $("#doc-result");
  if (!online.gemini) return out.replaceChildren(el("p", { class: "warn" }, "Certificate check is offline right now."));
  const f = new FormData(e.target);
  const file = f.get("file");
  if (!file || !file.size) return;
  out.replaceChildren(el("p", {}, "Checking…"));
  try {
    const { data, mimeType } = await fileToBase64(file);
    const res = await fetch(`${API}/api/check-doc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: data, mimeType, docType: f.get("docType"), studentName: f.get("studentName") }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || "Check failed");
    out.replaceChildren(el("div", { class: `card ${r.verdict === "ok" ? "eligible" : "maybe"}` },
      el("h3", {}, r.verdict === "ok" ? "✅ Looks fine" : "🟡 Problems found"),
      el("p", {}, el("b", {}, "Detected: "), r.doc_type_detected || "—"),
      el("p", {}, el("b", {}, "Name on certificate: "), r.name_on_doc || "—"),
      el("p", {}, el("b", {}, "Issued: "), r.issue_date || "not visible", r.valid_until ? ` · valid until ${r.valid_until}` : ""),
      r.issuing_authority ? el("p", {}, el("b", {}, "Issued by: "), r.issuing_authority) : null,
      r.issues.length ? el("ul", {}, r.issues.map((i) => el("li", {}, i))) : null,
      el("p", { class: "hint" }, "This is an AI check — the scholarship office makes the final decision.")));
  } catch (err) {
    out.replaceChildren(el("p", { class: "warn" }, err.message));
  }
}

// ---------- start ----------

async function checkServer() {
  const mode = $("#mode");
  try {
    const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(4000) });
    online = await res.json();
  } catch { /* offline */ }
  mode.className = online.groq ? "mode" : "mode offline";
  mode.textContent = online.groq
    ? `Online — AI chat ${online.gemini ? "and certificate check " : ""}available.`
    : "Offline mode — the form and results work; chat and certificate check need the server.";
}

async function start() {
  schemes = await (await fetch("../data/scholarships.json")).json();
  const saved = store.get("profile");
  if (saved) { writeProfile(saved); renderResults(); }
  form.addEventListener("submit", (e) => { e.preventDefault(); renderResults(); $("#results").scrollIntoView(); });
  $("#reset").addEventListener("click", () => { writeProfile({}); renderResults(); });
  $("#chat-form").addEventListener("submit", sendChat);
  $("#doc-form").addEventListener("submit", checkDoc);
  addMsg("bot", "Hi! Tell me about yourself — your course, year and state — and I'll find scholarships for you. தமிழிலும் பேசலாம்.");
  checkServer();
}

start();
