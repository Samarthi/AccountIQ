// background.js — fixed and simplified version
const MODEL_ID = "gemini-2.5-flash";

// Helper: Build Gemini API endpoint
function geminiGenerateUrl(modelId, apiKey, flavor = "generateContent") {
  // modelId should be like "models/gemini-1.5-flash-latest"
  
  // --- THIS IS THE FIX ---
  // The URL must include "/models/" before the modelId
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:${flavor}`;
  // --- END OF FIX ---

  if (apiKey && apiKey.length) {
    return `${base}?key=${encodeURIComponent(apiKey)}`;
  }
  return base;
}

/**
 * Calls the Gemini API using the standard v1beta 'generateContent' method.
 * @param {string} promptText The user prompt.
 * @param {object} [opts={}] Options, including generationConfig.
 * @returns {Promise<object>} A promise that resolves to { ok: true, text: "...", raw: {...} } or { error: "..." }
 */
async function callGeminiDirect(promptText, opts = {}) {
  const data = await chrome.storage.local.get("geminiKey");
  const geminiKey = data && data.geminiKey;
  if (!geminiKey) {
    return { error: "No Gemini API key found. Please add it in the popup." };
  }

  // Assuming geminiGenerateUrl and MODEL_ID are defined elsewhere.
  // const url = geminiGenerateUrl(MODEL_ID, geminiKey, "generateContent");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${geminiKey}`; // Using a placeholder URL for completeness

  const headers = {
    "Content-Type": "application/json",
  };

  // 1. Set the default generation config
  const generationConfig = opts.generationConfig || {
    temperature: 0.4,
    maxOutputTokens: 1200,
  };
    
  // 2. Check if structured output is requested, as it conflicts with tools
  const isStructured = generationConfig.responseMimeType === "application/json";

  // 3. Build the request body
  const body = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: generationConfig,
  };

  // 4. Conditionally add tools: only add them if structured output is NOT requested
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
      // API might return non-JSON on a server error
      if (!resp.ok) {
        return { error: `Gemini API error (Status ${resp.status}): ${respText}` };
      }
      // If resp was ok but body is not JSON, it's an unexpected state
      return { error: "Failed to parse Gemini API response as JSON.", details: respText };
    }

    if (!resp.ok) {
      // API returned a JSON error object
      const errorDetails = respJson?.error?.message || respText;
      return { error: `Gemini API error: ${errorDetails}`, details: respJson };
    }

    // Extract output text from the correct location
    let outputText = "";
    if (respJson?.candidates?.[0]?.content?.parts?.[0]?.text) {
      outputText = respJson.candidates[0].content.parts[0].text;
    } else {
      // Fallback in case the structure is different (e.g., safety stop)
      if (respJson?.candidates?.[0]?.finishReason) {
         return { error: `Gemini generation stopped: ${respJson.candidates[0].finishReason}`, details: respJson };
      }
      return { error: "Could not find text in Gemini response.", details: respJson };
    }

    return { ok: true, text: outputText, raw: respJson };
  } catch (err) {
    // Network error or other fetch-related failure
    return { error: `Network request failed: ${String(err)}` };
  }
}

// helper to extract JSON substring from model text output
function extractJsonFromText(s) {
  if (!s || typeof s !== "string") return null;
  
  // Look for JSON block markers
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
    // try cleaning up common issues
    const cleaned = sub.replace(/[\u2018\u2019\u201C\u201D]/g, '"').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(cleaned); } catch (e2) { return null; }
  }
}

// decode base64
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

async function generateBrief({ company, location, product, docs = [] }) {
  try {
    const docsText = (docs || []).map(d => {
      const txt = decodeBase64Text(d.content_b64 || d.content || "");
      return `--- ${d.name || "doc"} ---\n${txt.substring(0, 4000)}`;
    }).join("\n\n");

    const prompt = `You are a helpful assistant. Generate a concise sales brief for the following:
Instructions:
    - Search for the product and what the product's objectives are. 
    - Based on the product's objectives, figure out the key personas that would be making purchase decisions
    - Search for the name, designation and departname of each of the personas in the company
    - Search for the company's HQ in India, revenue and figure out the revenue revenue_estimate
    - The email draft should be from the seller to the persona
    - Search and include the zoominfo link for each persona as a google search string link.
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

    // Pass generationConfig correctly
    const resp = await callGeminiDirect(prompt, {
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048, // Increased for potentially large JSON
        responseMimeType: "application/json", // Request JSON output
      }
    });

    if (resp.error) return { error: resp.error + (resp.details ? ' Details: ' + JSON.stringify(resp.details) : ''), attempts: resp.details || [] };

    const outText = resp.text || resp.raw || "";
    const parsed = extractJsonFromText(outText); // Use this as a robust parser
    
    if (!parsed) {
      // If parsing failed, the model might have returned an error message instead of JSON
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

    // --- build targeted Google search link for ZoomInfo (replace previous personas mapping) ---
    function buildZoomInfoSearchLink(persona, companyName) {
        const parts = [];

        if (persona.name) parts.push(`"${persona.name.trim()}"`);
        if (persona.designation) parts.push(`"${persona.designation.trim()}"`);
        if (persona.department) parts.push(`"${persona.department.trim()}"`);
        if (companyName) parts.push(`"${companyName.trim()}"`);

        // 3 scope domains
        // linkedin → only profiles (/in/)
        const scope = `(site:zoominfo.com OR site:cognism.com OR site:linkedin.com/in)`;

        const query = `${scope} ${parts.join(' ')}`.trim();

        return `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`;
    }
      

    const personas = (parsed.key_personas || []).map(p => ({
      name: p.name || "",
      designation: p.designation || "",
      department: p.department || "",
      // prefer any model-provided link but always generate a safe Google search fallback
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
  // Use chrome.tabs.create to open a new tab with your extension's HTML file
  chrome.tabs.create({
    url: chrome.runtime.getURL("popup.html") // Assuming your main file is named popup.html
  });
});

// storage APIs and listener
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
          sendResponse(result);
          return;
        }
      }
      sendResponse({ error: "Unknown action/type" });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true; // Indicates asynchronous response
});