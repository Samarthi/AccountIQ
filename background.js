const MODEL_ID = "gemini-2.5-flash";

function geminiGenerateUrl(modelId, apiKey, flavor = "generateContent") {
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:${flavor}`;

  if (apiKey && apiKey.length) {
    return `${base}?key=${encodeURIComponent(apiKey)}`;
  }
  return base;
}

async function callGeminiDirect(promptText, opts = {}) {
  const data = await chrome.storage.local.get("geminiKey");
  const geminiKey = data && data.geminiKey;
  if (!geminiKey) {
    return { error: "No Gemini API key found. Please add it in the popup." };
  }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${geminiKey}`;

  const headers = {
    "Content-Type": "application/json",
  };

  const generationConfig = opts.generationConfig || {
    temperature: 0.4,
    maxOutputTokens: 1200,
  };
    
  const isStructured = generationConfig.responseMimeType === "application/json";

  const body = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: generationConfig,
  };

  if (!isStructured) {
    body.tools = [{ google_search: {} }];
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const respText = await resp.text();
    let respJson = null;

    try {
      respJson = JSON.parse(respText);
    } catch (e) {
      if (!resp.ok) {
        return { error: `Gemini API error (Status ${resp.status}): ${respText}` };
      }
      return { error: "Failed to parse Gemini API response as JSON.", details: respText };
    }

    if (!resp.ok) {
      const errorDetails = respJson?.error?.message || respText;
      return { error: `Gemini API error: ${errorDetails}`, details: respJson };
    }

    let outputText = "";
    if (respJson?.candidates?.[0]?.content?.parts?.[0]?.text) {
      outputText = respJson.candidates[0].content.parts[0].text;
    } else {
      if (respJson?.candidates?.[0]?.finishReason) {
         return { error: `Gemini generation stopped: ${respJson.candidates[0].finishReason}`, details: respJson };
      }
      return { error: "Could not find text in Gemini response.", details: respJson };
    }

    return { ok: true, text: outputText, raw: respJson };
  } catch (err) {
    return { error: `Network request failed: ${String(err)}` };
  }
}

function extractJsonFromText(s) {
  if (!s || typeof s !== "string") return null;
  
  const jsonMatch = s.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch && jsonMatch[1]) {
    s = jsonMatch[1];
  }

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  
  const sub = s.substring(first, last + 1);
  try {
    return JSON.parse(sub);
  } catch (e) {
    const cleaned = sub.replace(/[\u2018\u2019\u201C\u201D]/g, '"').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(cleaned); } catch (e2) { return null; }
  }
}

function decodeBase64Text(b64) {
  if (!b64) return "";
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    return decoder.decode(bytes);
  } catch (e) {
    return "";
  }
}

async function saveResearchHistoryEntry(request, result) {
  try {
    const entry = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      request: {
        company: request.company || "",
        location: request.location || "",
        product: request.product || "",
      },
      result: {
        brief_html: result.brief_html || "",
        personas: Array.isArray(result.personas) ? result.personas : [],
        email: result.email || {},
      },
    };

    const existing = await chrome.storage.local.get(["researchHistory"]);
    const history = Array.isArray(existing.researchHistory) ? existing.researchHistory : [];

    history.unshift(entry);
    const trimmed = history.slice(0, 25);

    await chrome.storage.local.set({ researchHistory: trimmed });
    return entry;
  } catch (err) {
    console.warn("Failed to persist research history", err);
    return null;
  }
}

async function generateBrief({ company, location, product, docs = [] }) {
  try {
    const docsText = (docs || []).map(d => {
      const txt = decodeBase64Text(d.content_b64 || d.content || "");
      return `--- ${d.name || "doc"} ---\n${txt.substring(0, 4000)}`;
    }).join("\n\n");

    const prompt = `You are a helpful assistant. Generate a concise sales brief for the following:
Instructions:
    - Search for the product and what the product's objectives are. 
    - Based on the product's objectives, list out the key personas that would be making purchase decisions such as CTO, VP, Procurement Officers etc.
    - Search for the designation and departname of each of the personas in the company
    - Search for the company's HQ in India, revenue and figure out the revenue revenue_estimate
    - The email draft should be from the seller to the persona
    - Search and include the zoominfo OR linkedin OR Cognism link for each persona as a search string link. DO NOT INCLUDE the term "google search:"
Company: ${company}
Location: ${location || "N/A"}
Product: ${product}

Context docs (first 4000 chars each):
${docsText || "(no docs provided)"}

Output JSON in this structure EXACTLY. Do not include \`\`\`json markdown wrappers.
{
  "company_name": "",
  "revenue_estimate": "",
  "hq_location": "",
  "top_5_news": [
    {"title": "", "summary": ""}
  ],
  "key_personas": [
    {"name": "", "designation": "", "department": "", "zoominfo_link": ""}
  ],
  "personalized_email": {"subject": "", "body": ""}
}

Be concise. If no data available, return empty strings or empty arrays as appropriate.
`;

    const resp = await callGeminiDirect(prompt, {
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      }
    });

    if (resp.error) return { error: resp.error + (resp.details ? ' Details: ' + JSON.stringify(resp.details) : ''), attempts: resp.details || [] };

    const outText = resp.text || resp.raw || "";
    const parsed = extractJsonFromText(outText);
    
    if (!parsed) {
      return { brief: outText || "No output from model.", raw: outText, error: "Model did not return valid JSON." };
    }

    let brief_html = `<h4>${parsed.company_name || company}</h4>`;
    brief_html += `<p><strong>Headquarters:</strong> ${parsed.hq_location || ""} &nbsp; <strong>Revenue:</strong> ${parsed.revenue_estimate || ""}</p>`;
    if (parsed.top_5_news && parsed.top_5_news.length) {
      brief_html += `<h5>Top News</h5><ul>`;
      parsed.top_5_news.slice(0, 5).forEach(n => brief_html += `<li><strong>${n.title || ""}</strong><div>${n.summary || ""}</div></li>`);
      brief_html += `</ul>`;
    } else {
      brief_html += `<h5>Top News</h5><p>No recent headlines found.</p>`;
    }

    function buildZoomInfoSearchLink(persona, companyName) {
        const parts = [];

        if (persona.name) parts.push(`"${persona.name.trim()}"`);
        if (persona.designation) parts.push(`"${persona.designation.trim()}"`);
        if (persona.department) parts.push(`"${persona.department.trim()}"`);
        if (companyName) parts.push(`"${companyName.trim()}"`);

        const scope = `(site:zoominfo.com OR site:cognism.com OR site:linkedin.com/in)`;

        const query = `${scope} ${parts.join(' ')}`.trim();

        return `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`;
    }
      

    const personas = (parsed.key_personas || []).map(p => ({
      name: p.name || "",
      designation: p.designation || "",
      department: p.department || "",
      zoominfo_link: (p.zoominfo_link || p.zoomInfo || p.zoominfo || p.zoom) || buildZoomInfoSearchLink(p, parsed.company_name || company)
    }));


    let emailObj = { subject: "", body: "" };
    if (typeof parsed.personalized_email === "string") {
      emailObj.body = parsed.personalized_email;
    } else if (parsed.personalized_email && typeof parsed.personalized_email === "object") {
      emailObj.subject = parsed.personalized_email.subject || "";
      emailObj.body = parsed.personalized_email.body || "";
    }

    return { brief_html, personas, email: emailObj, raw: outText };
  } catch (err) {
    return { error: String(err) };
  }
}
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("popup.html")
  });
});

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    try {
      if (req && req.action) {
        if (req.action === 'storeDoc') {
          const data = await chrome.storage.local.get(['docs']);
          const docs = data.docs || [];
          const id = Date.now().toString();
          docs.push({ id, name: req.name, content_b64: req.content_b64 });
          await chrome.storage.local.set({ docs });
          sendResponse({ ok: true, id });
          return;
        }
        if (req.action === 'listDocs') {
          const data = await chrome.storage.local.get(['docs']);
          const docs = data.docs || [];
          sendResponse({ docs });
          return;
        }
        if (req.action === 'getDocsForProduct') {
          const data = await chrome.storage.local.get(['docs']);
          const docs = data.docs || [];
          const product = (req.product || '').toLowerCase();
          const filtered = docs.filter(d => d.name && d.name.toLowerCase().includes(product));
          sendResponse({ docs: filtered });
          return;
        }
        if (req.action === 'generateBrief') {
          const payload = { company: req.company, location: req.location, product: req.product, docs: req.docs || [] };
          const result = await generateBrief(payload);
          if (!result.error) {
            await saveResearchHistoryEntry(payload, result);
          }
          sendResponse(result);
          return;
        }
        if (req.action === 'getResearchHistory') {
          const data = await chrome.storage.local.get(['researchHistory']);
          const history = Array.isArray(data.researchHistory) ? data.researchHistory : [];
          sendResponse({ history });
          return;
        }
      }
      sendResponse({ error: "Unknown action/type" });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true;
});
