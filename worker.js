// Sensible Care — Lenny Snapforms Proxy Worker (v2.1 — HCP + SaH)
//
// Deploy target: Cloudflare Workers (Sensible Care organisation account)
//
// Environment variables required (Settings → Variables → encrypt all four):
//   SNAP_CLIENT_SECRET  — Snapforms OAuth client secret
//   SNAP_USERNAME       — Snapforms API username
//   SNAP_PASSWORD       — Snapforms API password
//   GEMINI_API_KEY      — Google AI Studio API key
//
// KV binding required (Settings → Bindings):
//   LENNY_PARTICIPANTS  — bound to a KV namespace named e.g. "lenny-participants"
//
// Client contract:
//   Every /snapforms-proxy/* endpoint accepts a ?form=hcp|sah|sah_vc query parameter.
//   resolve-record-key and kv-search-participants also accept form=auto, which
//   searches every form and returns the formId the participant was found on.
//   Default is 'hcp' when omitted (backwards-compat with old Lenny). Unknown
//   values are rejected with 400. KV keys are namespaced per form so an HCP
//   participant can't collide with a same-named SaH participant.

const SNAP_BASE  = "https://user.snapforms.com.au/api";
const SNAP_AUTH  = "https://user.snapforms.com.au/oauth/token";
const CLIENT_ID  = "3864";

// The two Snapforms Care Plan forms this Worker knows about. Add new forms
// here — no other code changes needed.
const FORM_SLUGS = {
  hcp:    "sensible-care---hcp-initial-assessment-and-care-plan",
  sah:    "sensible-care---sah-initial-assessment--care-plan",
  sah_vc: "sensible-care---new-sah-participant-vc-setup-form",
};
// Forms searched by form=auto. sah_vc is the VisualCare setup form — it has no
// care plan sections, so a participant should never resolve to it for Lenny.
const AUTO_FORMS = ["hcp", "sah"];
const FORM_NAMES = {
  hcp:    "HCP Initial Assessment & Care Plan",
  sah:    "SaH Initial Assessment & Care Plan",
  sah_vc: "New SaH Participant VC Setup Form",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function errorResponse(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Read ?form=hcp|sah from the URL (defaults to 'hcp' for backwards-compat).
// Returns { formId, slug } or throws with a 400-friendly message if unknown.
function pickForm(url) {
  const formId = (url.searchParams.get("form") || "hcp").toLowerCase();
  const slug   = FORM_SLUGS[formId];
  if (!slug) {
    const known = Object.keys(FORM_SLUGS).join(", ");
    throw Object.assign(new Error(`Unknown form "${formId}". Valid values: ${known}`), { status: 400 });
  }
  return { formId, slug };
}

// Safely extract a string value from any answer format:
//   - plain string  → returned as-is
//   - field table   → [{row:1, data:[{fieldname,fieldvalue}]}] → all fieldvalues joined
//   - anything else → String()
function extractAnswerStr(answer) {
  if (answer == null) return "";
  if (typeof answer === "string") return answer;
  if (Array.isArray(answer)) {
    return answer
      .map(row => {
        if (row && Array.isArray(row.data)) {
          return row.data.map(d => (d.fieldvalue != null ? String(d.fieldvalue) : "")).join(" ");
        }
        return String(row || "");
      })
      .join(" ");
  }
  return String(answer);
}

async function getBearerToken(env) {
  const res = await fetch(SNAP_AUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type:    "password",
      client_id:     CLIENT_ID,
      client_secret: env.SNAP_CLIENT_SECRET,
      username:      env.SNAP_USERNAME,
      password:      env.SNAP_PASSWORD,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("Failed to get Snapforms token: " + (data.message || data.error || res.status));
  }
  return data.access_token;
}

function parseRecordKey(key) {
  const dobMatch = key.match(/\d{2}\/\d{2}\/\d{4}/);
  const dob = dobMatch ? dobMatch[0] : null;
  const name = key
    .replace(/\bIACP\b/gi, "")
    .replace(/\d{2}\/\d{2}\/\d{4}/g, "")
    .replace(/^[-\s]+|[-\s]+$/g, "")
    .replace(/--+/g, "-")
    .trim();
  return { name, dob };
}

function normDobStr(s) {
  return s.replace(/\b0(\d)\//g, "$1/").toLowerCase().trim();
}

function normWS(s) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

const REVIEW_COLUMNS = ["Date", "Staff Initial", "Section"];

// Fallback checkbox question names for "Are there any Identified Risks?" per section.
// These apply to BOTH HCP and SaH — the section numbering + naming is consistent.
// If SaH turns out to use different labels, split this into per-form maps.
const RISKS_CHECKBOX_QUESTIONS = {
  "12. Disaster & Emergency Management":          "12. Disaster & Emergency Management: Are there any Identified Risks?",
  "20. Personal Care":                            "20. Personal Care: Are there any Identified Risks?",
  "21. Oral Hygiene":                             "21. Oral Hygiene: Are there any Identified Risks?",
  "22. Toileting & Continence":                   "22. Toileting & Continence: Are there any Identified Risks?",
  "23. Mobility & Transfers":                     "23. Mobility & Transfers: Are there any Identified Risks?",
  "24. Household Tasks":                          "24. Household Tasks: Are there any Identified Risks?",
  "25. Home Environment":                         "25. Home Environment: Are there any Identified Risks?",
  "26. Communication & Sensory Care":             "26. Communication & Sensory Care: Are there any Identified Risks?",
  "27. Nutrition & Meal Planning & Preparation":  "27. Nutrition & Meal Planning & Preparation: Are there any Identified Risks?",
  "29. Clinical Care":                            "29. Clinical Care: Are there any Identified Risks?",
  "30. Medication Management":                    "30. Medication Management: Are there any Identified Risks?",
  "31. Skin Integrity":                           "31. Skin Integrity: Are there any Identified Risks?",
  "32. Foot Health":                              "32. Foot Health: Are there any Identified Risks?",
  "33. Sleep":                                    "33. Sleep: Are there any Identified Risks?",
  "34. Breathing":                                "34. Breathing: Are there any Identified Risks?",
  "37. Cognition & Mental Health":                "37. Cognition & Behaviour: Are there any Identified Risks?",
  "38. Mental Health":                            "38. Mental Health: Are there any Identified Risks?",
  "39. Carer":                                    "39. Carer: Are there any Identified Risks?",
};

function appendFieldTableRow(existingArray, parts, defaultColumns = null) {
  if (!Array.isArray(existingArray)) return null;

  let fieldNames;
  if (existingArray.length === 0) {
    if (!defaultColumns || defaultColumns.length === 0) return null;
    fieldNames = defaultColumns;
  } else {
    const template = existingArray.find(r => Array.isArray(r.data) && r.data.length > 0);
    if (!template) return null;
    fieldNames = template.data.map(d => d.fieldname || "");
  }

  const nextRowNum = existingArray.length > 0
    ? Math.max(...existingArray.map(r => Number(r.row) || 0)) + 1
    : 1;
  const newData = fieldNames.map((fn, i) => ({
    fieldname:  fn,
    fieldvalue: i < fieldNames.length - 1
      ? (parts[i] || "")
      : parts.slice(i).join(" | "),
  }));
  return [...existingArray, { row: nextRowNum, data: newData }];
}

function scanAnswer(a, nameLower, dob, originalKey) {
  const q        = String(a.question || "").toLowerCase().trim();
  const v        = extractAnswerStr(a.answer).toLowerCase();
  const vNorm    = normWS(v);
  const nameNorm = normWS(nameLower);
  const normDob  = normDobStr(dob);

  let hasName = false, hasDob = false, hasKey = false;

  if (q === "record key" || q === "record key - archived" || q.includes("record key")) {
    if (originalKey && v === originalKey.toLowerCase()) hasKey = true;
    if (vNorm.includes(nameNorm) && (v.includes(dob.toLowerCase()) || v.includes(normDob))) hasKey = true;
  }
  if (q.includes("client name") || q.includes("participant name")) {
    if (vNorm.includes(nameNorm)) hasName = true;
  }
  if (q.includes("client dob") || q.includes("participant dob") || q === "dob" || q.endsWith(": dob") || q.includes("date of birth")) {
    if (v === dob.toLowerCase() || normDobStr(v) === normDob) hasDob = true;
  }

  if (Array.isArray(a.answer)) {
    for (const row of a.answer) {
      for (const d of (row.data || [])) {
        const fn   = String(d.fieldname  || "").toLowerCase();
        const fv   = String(d.fieldvalue || "").toLowerCase();
        const fvNorm = normWS(fv);
        if ((fn.includes("client name") || fn === "name") && fvNorm.includes(nameNorm)) hasName = true;
        if ((fn.includes("dob") || fn.includes("date of birth") || fn.includes("birth")) &&
            (fv === dob.toLowerCase() || normDobStr(fv) === normDob)) hasDob = true;
        if (fn.includes("record key") && originalKey && fv === originalKey.toLowerCase()) hasKey = true;
      }
    }
  }

  if (vNorm.includes(nameNorm)) hasName = true;
  if (v === dob.toLowerCase() || normDobStr(v) === normDob) hasDob = true;

  return { hasName, hasDob, hasKey };
}

async function fetchPage(slug, token, offset, limit = 100) {
  try {
    const res = await fetch(
      `${SNAP_BASE}/forms/${slug}/responses?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.responses || (Array.isArray(data) ? data : []);
  } catch {
    return [];
  }
}

async function findResponseByNameAndDob(slug, name, dob, token, originalKey) {
  const limit     = 100;
  const batchSize = 5;
  const maxPages  = 20;
  const nameLower = name.toLowerCase();

  for (let batch = 0; batch < maxPages; batch += batchSize) {
    const offsets  = Array.from({ length: batchSize }, (_, i) => (batch + i) * limit);
    const pages    = await Promise.all(offsets.map(o => fetchPage(slug, token, o, limit)));
    const allEmpty = pages.every(p => p.length === 0);
    if (allEmpty) break;

    for (const responses of pages) {
      for (const r of responses) {
        const answers  = r.answers || [];
        let foundName  = false;
        let foundDob   = false;
        let foundKey   = false;

        for (const a of answers) {
          const { hasName, hasDob, hasKey } = scanAnswer(a, nameLower, dob, originalKey);
          if (hasKey)  foundKey  = true;
          if (hasName) foundName = true;
          if (hasDob)  foundDob  = true;
        }

        if (foundKey || (foundName && foundDob)) {
          console.log(`Match: id=${r.response_id} key=${foundKey} name=${foundName} dob=${foundDob}`);
          return String(r.response_id);
        }
      }
      if (responses.length < limit) return null;
    }
  }
  return null;
}

// KV keys are namespaced by form so HCP and SaH participants can't collide.
// Old (v1 worker) KV entries used unprefixed "participant:name" — those will
// stop resolving after cutover. That's fine; they get re-populated on first
// lookup. If Rachel wants to migrate the old KV, do it via a one-off script.
function kvParticipantKey(formId, name) {
  return `participant:${formId}:${normWS(name)}`;
}

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── Gemini proxy (form-agnostic) ─────────────────────────────────────────
    if (path === "/claude-proxy" && request.method === "POST") {
      try {
        const body = await request.json();

        const modelMap = {
          "claude-sonnet-4-6":         "gemini-2.5-flash",
          "claude-haiku-4-5-20251001": "gemini-2.5-flash",
        };
        const geminiModel = modelMap[body.model] || "gemini-2.5-flash";

        function toGeminiParts(content) {
          if (typeof content === "string") return [{ text: content }];
          if (!Array.isArray(content)) return [{ text: String(content) }];
          return content.map(block => {
            if (block.type === "text")     return { text: block.text };
            if (block.type === "image")    return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
            if (block.type === "document") return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
            return { text: "" };
          });
        }

        const allPromptText = (body.messages || [])
          .flatMap(m => Array.isArray(m.content)
            ? m.content.filter(b => b.type === "text").map(b => b.text)
            : [String(m.content || "")])
          .join(" ");
        const wantsJson = /\bjson\b/i.test(allPromptText);

        const careUpdateSchema = {
          type: "OBJECT",
          properties: {
            fields: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  key:    { type: "STRING" },
                  answer: { type: "STRING" },
                },
                required: ["key", "answer"],
              },
            },
            pronouns: { type: "STRING", nullable: true },
          },
          required: ["fields"],
        };

        const geminiBody = {
          contents: (body.messages || []).map(msg => ({
            role:  msg.role === "assistant" ? "model" : "user",
            parts: toGeminiParts(msg.content),
          })),
          generationConfig: {
            maxOutputTokens: body.max_tokens || 16384,
            ...(wantsJson ? {
              responseMimeType: "application/json",
              responseSchema:   careUpdateSchema,
            } : {}),
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          ],
        };

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${env.GEMINI_API_KEY}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiBody) }
        );
        const geminiData = await geminiRes.json();
        if (!geminiRes.ok) return jsonResponse(geminiData, geminiRes.status);

        const text = geminiData.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
        return jsonResponse({ content: [{ type: "text", text }], stop_reason: "end_turn" });
      } catch (err) {
        return errorResponse("Gemini proxy error: " + err.message);
      }
    }

    // ── List supported forms (for client dropdowns / debug) ──────────────────
    if (path === "/snapforms-proxy/forms" && request.method === "GET") {
      return jsonResponse({ forms: Object.entries(FORM_SLUGS).map(([id, slug]) => ({ id, slug, name: FORM_NAMES[id] || id })) });
    }

    // ── Distinct question labels on a form (for building Lenny field maps) ──
    // GET /snapforms-proxy/labels?form=sah_vc  → sorted unique question labels
    // across the first 100 responses, with how many responses use each one.
    if (path === "/snapforms-proxy/labels" && request.method === "GET") {
      try {
        const { formId, slug } = pickForm(url);
        const token = await getBearerToken(env);
        const responses = await fetchPage(slug, token, 0, 100);
        const counts = {};
        for (const r of responses) for (const a of (r.answers || [])) {
          const q = String(a.question || "").trim(); if (!q) continue;
          counts[q] = (counts[q] || 0) + 1;
        }
        const labels = Object.keys(counts).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
          .map(q => ({ question: q, responses: counts[q] }));
        return jsonResponse({ formId, form: FORM_NAMES[formId], sampled: responses.length, count: labels.length, labels });
      } catch (err) {
        return errorResponse("Labels error: " + err.message, err.status || 500);
      }
    }

    // ── Resolve by wf_token (full Snapforms URL paste) ────────────────────────
    if (path === "/snapforms-proxy/resolve-token" && request.method === "GET") {
      const wfToken = url.searchParams.get("wf_token");
      if (!wfToken) return errorResponse("Missing wf_token", 400);
      try {
        const { formId, slug } = pickForm(url);
        const token = await getBearerToken(env);
        const res   = await fetch(
          `${SNAP_BASE}/forms/${slug}/responses?wf_token=${encodeURIComponent(wfToken)}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
        );
        if (!res.ok) return errorResponse(`Snapforms token lookup failed (${res.status})`, res.status);
        const data      = await res.json();
        const responses = data.responses || (Array.isArray(data) ? data : []);
        if (!responses.length) return errorResponse("No response found for that URL", 404);

        const r       = responses[0];
        const answers = r.answers || [];
        let name = null;
        for (const a of answers) {
          const _ql = String(a.question || "").toLowerCase().trim();
          if (_ql === "client name" || _ql === "participant name") {
            name = extractAnswerStr(a.answer).trim();
          }
        }
        return jsonResponse({ formId, responseId: String(r.response_id), participantName: name });
      } catch (err) {
        return errorResponse("Token resolve error: " + err.message, err.status || 500);
      }
    }

    // ── DEBUG: show raw answers for name/dob scan ─────────────────────────────
    if (path === "/snapforms-proxy/debug" && request.method === "GET") {
      const dname = url.searchParams.get("name") || "";
      try {
        const { formId, slug } = pickForm(url);
        const token = await getBearerToken(env);
        const res   = await fetch(
          `${SNAP_BASE}/forms/${slug}/responses?limit=100&offset=0`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
        );
        const data      = await res.json();
        const responses = data.responses || (Array.isArray(data) ? data : []);
        const nameLow = dname.toLowerCase();
        const out = responses.slice(0, 200).map(r => {
          const answers = (r.answers || []).map(a => ({
            question: a.question,
            answerType: Array.isArray(a.answer) ? "field_table" : typeof a.answer,
            answerExtracted: extractAnswerStr(a.answer).slice(0, 120),
          }));
          const containsName = answers.some(a => a.answerExtracted.toLowerCase().includes(nameLow));
          return { response_id: r.response_id, containsName, answers };
        }).filter(r => r.containsName || dname === "");
        return jsonResponse({ formId, total: responses.length, matching: out.length, results: out.slice(0, 5) });
      } catch (err) {
        return errorResponse("Debug error: " + err.message, err.status || 500);
      }
    }

    // ── Resolve record key → responseId ──────────────────────────────────────
    if (path === "/snapforms-proxy/resolve-record-key" && request.method === "GET") {
      const recordKey = url.searchParams.get("recordKey");
      if (!recordKey) return errorResponse("Missing recordKey param", 400);
      try {
        const wantAuto = (url.searchParams.get("form") || "").toLowerCase() === "auto";
        const { name, dob }    = parseRecordKey(recordKey);
        if (wantAuto) {
          if (!name || !dob) {
            return errorResponse(`Could not parse name and DOB from "${recordKey}". Use format: Firstname Lastname-DD/MM/YYYY-IACP`, 400);
          }
          const force = url.searchParams.get("force") === "1";
          let token = null;
          for (const fid of AUTO_FORMS) {
            const fslug = FORM_SLUGS[fid];
            const kk = kvParticipantKey(fid, name);
            if (!force) {
              const cached = await env.LENNY_PARTICIPANTS.get(kk);
              if (cached) { const p = JSON.parse(cached); return jsonResponse({ formId: fid, formName: FORM_NAMES[fid], responseId: p.response_id, participantName: p.name || name }); }
            }
            token = token || await getBearerToken(env);
            const rid = await findResponseByNameAndDob(fslug, name, dob, token, recordKey);
            if (rid) {
              await env.LENNY_PARTICIPANTS.put(kk, JSON.stringify({ form: fid, name, dob, record_key: recordKey, response_id: rid }));
              return jsonResponse({ formId: fid, formName: FORM_NAMES[fid], responseId: rid, participantName: name });
            }
          }
          return errorResponse(`No Snapforms response found for name="${name}", dob="${dob}" on any Care Plan form (${AUTO_FORMS.map(f => FORM_NAMES[f]).join(", ")}). Check the name and date of birth match exactly.`, 404);
        }
        const { formId, slug } = pickForm(url);
        console.log(`Resolving [${formId}]: "${recordKey}" → name="${name}", dob="${dob}"`);

        if (!name || !dob) {
          return errorResponse(
            `Could not parse name and DOB from "${recordKey}". Use format: Firstname Lastname-DD/MM/YYYY-IACP`, 400
          );
        }

        // 1. Check KV cache (per-form namespaced)
        const kvKey   = kvParticipantKey(formId, name);
        const force   = url.searchParams.get("force") === "1";
        if (!force) {
          const cached = await env.LENNY_PARTICIPANTS.get(kvKey);
          if (cached) {
            const p = JSON.parse(cached);
            console.log(`KV cache hit [${formId}] for "${name}": responseId=${p.response_id}`);
            return jsonResponse({ formId, responseId: p.response_id, participantName: p.name || name });
          }
        } else {
          console.log(`Force-bypass KV cache [${formId}] for "${name}"`);
        }

        // 2. Full Snapforms scan
        const token      = await getBearerToken(env);
        const responseId = await findResponseByNameAndDob(slug, name, dob, token, recordKey);

        if (!responseId) {
          return errorResponse(
            `No Snapforms response found for name="${name}", dob="${dob}" on form "${formId}". ` +
            `Check the name and date of birth match the care plan exactly.`,
            404
          );
        }

        // 3. Cache
        await env.LENNY_PARTICIPANTS.put(kvKey, JSON.stringify({
          form: formId, name, dob, record_key: recordKey, response_id: responseId,
        }));

        return jsonResponse({ formId, responseId, participantName: name });
      } catch (err) {
        return errorResponse(err.message, err.status || 500);
      }
    }

    // ── KV search + live Snapforms fallback ───────────────────────────────────
    if (path === "/snapforms-proxy/kv-search-participants" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (q.length < 2) return jsonResponse({ results: [] });
      if ((url.searchParams.get("form") || "").toLowerCase() === "auto") {
        try {
          const all = [];
          for (const fid of AUTO_FORMS) {
            const u2 = new URL(request.url); u2.searchParams.set("form", fid);
            const r2 = await this.fetch(new Request(u2.toString(), { method: "GET" }), env);
            const d2 = await r2.json().catch(() => ({}));
            (d2.results || []).forEach(x => all.push(Object.assign({ form: fid, form_name: FORM_NAMES[fid] }, x)));
          }
          return jsonResponse({ formId: "auto", results: all.slice(0, 20) });
        } catch (err) {
          return errorResponse("Search error: " + err.message, 500);
        }
      }
      try {
        const { formId, slug } = pickForm(url);

        // 1. Try KV (per-form namespace)
        const list    = await env.LENNY_PARTICIPANTS.list({ prefix: `participant:${formId}:${q}` });
        const results = [];
        for (const key of list.keys) {
          const val = await env.LENNY_PARTICIPANTS.get(key.name);
          if (val) results.push(JSON.parse(val));
        }
        if (results.length > 0) return jsonResponse({ formId, results });

        // 2. Fall back to live Snapforms scan
        const token       = await getBearerToken(env);
        const limit       = 100;
        let   offset      = 0;
        const snapResults = [];

        while (offset <= 500 && snapResults.length < 10) {
          const res = await fetch(
            `${SNAP_BASE}/forms/${slug}/responses?limit=${limit}&offset=${offset}`,
            { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
          );
          if (!res.ok) break;
          const data      = await res.json();
          const responses = data.responses || (Array.isArray(data) ? data : []);
          if (responses.length === 0) break;

          for (const r of responses) {
            if (snapResults.length >= 10) break;
            const answers = r.answers || [];
            let name = null, dob = null, recordKey = null;

            for (const a of answers) {
              const ql = String(a.question || "").toLowerCase().trim();
              const v  = extractAnswerStr(a.answer);
              if (ql === "client name" || ql === "participant name")            name      = v;
              if (ql === "record key"  || ql === "record key - archived")       recordKey = v;
              if (ql === "client dob"  || ql === "participant dob" || ql === "dob") dob  = v;
            }

            if (name && name.toLowerCase().includes(q)) {
              snapResults.push({
                form:        formId,
                name:        name.trim(),
                dob:         dob       || null,
                record_key:  recordKey || null,
                response_id: String(r.response_id),
              });
            }
          }

          if (responses.length < limit) break;
          offset += limit;
        }

        return jsonResponse({ formId, results: snapResults });
      } catch (err) {
        return errorResponse("Search error: " + err.message, err.status || 500);
      }
    }

    // ── GET single response (for display) ────────────────────────────────────
    const getMatch = path.match(/^\/snapforms-proxy\/responses\/([^/]+)$/);
    if (getMatch && request.method === "GET") {
      const responseId = getMatch[1];
      try {
        const { slug } = pickForm(url);
        const token  = await getBearerToken(env);
        const getRes = await fetch(
          `${SNAP_BASE}/forms/${slug}/responses/${responseId}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
        );
        if (!getRes.ok) return errorResponse(`Snapforms fetch failed (${getRes.status})`, getRes.status);
        const data = await getRes.json();
        return jsonResponse(data, getRes.status);
      } catch (err) {
        return errorResponse("Fetch error: " + err.message, err.status || 500);
      }
    }

    // ── PUT: fetch existing, append new content, save ─────────────────────────
    const putMatch = path.match(/^\/snapforms-proxy\/responses\/([^/]+)$/);
    if (putMatch && request.method === "PUT") {
      const responseId = putMatch[1];
      try {
        const { formId, slug } = pickForm(url);
        const { participant, payload } = await request.json();
        const token = await getBearerToken(env);

        // 1. Fetch existing answers
        const getRes = await fetch(
          `${SNAP_BASE}/forms/${slug}/responses/${responseId}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
        );
        const existingData = getRes.ok ? await getRes.json().catch(() => ({})) : {};
        const existingRaw  = existingData.answers || existingData.fields || [];
        const existingMap    = {};
        const existingMapRaw = {};
        for (const f of existingRaw) {
          if (f.question && f.answer != null) {
            const key = f.question.trim();
            existingMap[key]    = extractAnswerStr(f.answer);
            existingMapRaw[key] = f.answer;
          }
        }
        console.log(`[${formId}] existingMap size: ${Object.keys(existingMap).length}`);

        // 2. Merge only the changed fields (partial PUT — Snapforms leaves other fields untouched)
        const changedOnly = payload.map(item => {
          const q       = item.question.trim();
          const prev    = existingMap[q] || "";
          const prevRaw = existingMapRaw[q];

          if (item.appendPlain) {
            const rawArr = Array.isArray(prevRaw)
              ? prevRaw
              : (() => {
                  const hit = existingRaw.find(f =>
                    Array.isArray(f.answer) && /47|review/i.test(String(f.question || ""))
                  );
                  return hit ? hit.answer : null;
                })();

            const parts = item.answer.split(/\s*\|\s*/);

            if (rawArr !== null && rawArr !== undefined) {
              const updated = appendFieldTableRow(rawArr, parts, REVIEW_COLUMNS);
              if (updated) {
                console.log(`Field-table append for "${q}": now ${updated.length} row(s)`);
                return { question: q, answer: updated };
              }
            }

            if (/47|review/i.test(q)) {
              const updated = appendFieldTableRow([], parts, REVIEW_COLUMNS);
              if (updated) {
                console.log(`New field-table for "${q}": created row 1`);
                return { question: q, answer: updated };
              }
            }

            return { question: q, answer: prev ? `${prev}\n${item.answer}` : item.answer };
          }

          return { question: q, answer: prev ? `${prev}\n\n${item.answer}` : item.answer };
        });

        // 2b. Auto-tick "Are there any Identified Risks?" checkboxes.
        for (const item of payload) {
          const q = item.question.trim();
          const riskMatch = q.match(/^(\d+\.\s+.+?):\s+Identified Risks$/i);
          if (!riskMatch) continue;
          const sectionPrefix = riskMatch[1].trim();

          let checkboxQ = null;
          const secNum = (sectionPrefix.match(/^(\d+)\./) || [])[1];
          const checkboxField = existingRaw.find(f => {
            const fq = String(f.question || "").trim();
            return /Are there any Identified Risks\?/i.test(fq) &&
                   (fq.toLowerCase().startsWith(sectionPrefix.toLowerCase()) || (secNum && fq.startsWith(secNum + ". ")));
          });
          if (checkboxField) {
            checkboxQ = checkboxField.question.trim();
          } else {
            checkboxQ = RISKS_CHECKBOX_QUESTIONS[sectionPrefix] || null;
          }

          if (checkboxQ && !changedOnly.some(c => c.question === checkboxQ)) {
            console.log(`Auto-ticking risks checkbox: "${checkboxQ}"`);
            changedOnly.push({ question: checkboxQ, answer: true });
          }
        }

        // 3. PUT with retry on 5xx
        const putBody = JSON.stringify(changedOnly);
        let putRes, result;
        for (let attempt = 1; attempt <= 3; attempt++) {
          putRes = await fetch(
            `${SNAP_BASE}/forms/${slug}/responses/${responseId}`,
            {
              method:  "PUT",
              headers: {
                Authorization:  `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept:         "application/json",
              },
              body: putBody,
            }
          );
          result = await putRes.json().catch(() => ({}));
          if (putRes.ok || (putRes.status >= 400 && putRes.status < 500)) break;
          console.log(`PUT attempt ${attempt} failed (${putRes.status}), retrying...`);
          await new Promise(r => setTimeout(r, attempt * 1000));
        }

        // 4. Save participant to KV for quick search next time (per-form key)
        if (putRes.ok && participant?.name) {
          await env.LENNY_PARTICIPANTS.put(
            kvParticipantKey(formId, participant.name),
            JSON.stringify({
              form:        formId,
              name:        participant.name,
              dob:         participant.dob        || null,
              record_key:  participant.record_key || null,
              response_id: responseId,
            })
          );
        }

        return jsonResponse(result, putRes.status);
      } catch (err) {
        return errorResponse("Update error: " + err.message, err.status || 500);
      }
    }

    return errorResponse("Not found", 404);
  },
};
