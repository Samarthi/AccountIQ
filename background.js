const MODEL_ID = "gemini-2.5-flash";
const EXPORT_TEMPLATE_KEY = "exportTemplate";
const TARGET_HISTORY_KEY = "targetHistory";
const TARGET_COMPANY_GOAL = 100;

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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;

  const headers = {
    "Content-Type": "application/json",
  };

  // Merge caller config with safer, deterministic defaults and clamps
  const userCfg = opts.generationConfig || {};
  const generationConfig = {
    ...userCfg,
    // Keep temperature low for determinism; clamp to [0, 0.2]
    temperature: Math.max(0, Math.min(userCfg.temperature ?? 0.1, 0.2)),
    // Allow large outputs while bounded; default to 100000, clamp to 100000 max
    maxOutputTokens: Math.min(userCfg.maxOutputTokens ?? 100000, 100000),
    // Single candidate to reduce variance
    candidateCount: 1,
  };
    
  const isStructured = generationConfig.responseMimeType === "application/json";
  const customContents = Array.isArray(opts.contents) && opts.contents.length ? opts.contents : null;
  const requestedTools = Array.isArray(opts.tools) && opts.tools.length ? opts.tools.filter(Boolean) : null;

  const body = {
    contents: customContents || [{ role: "user", parts: [{ text: promptText || "" }] }],
    generationConfig: generationConfig,
  };

  if (requestedTools && requestedTools.length) {
    body.tools = requestedTools;
  } else if (!isStructured) {
    body.tools = [{ google_search: {} }];
  }

  if (opts.toolConfig && typeof opts.toolConfig === "object") {
    body.toolConfig = opts.toolConfig;
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

function getValueAtPath(obj, path) {
  if (!path) return undefined;
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  return segments.reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[key];
  }, obj);
}

function truncateText(str, max = 3000) {
  if (typeof str !== "string") return "";
  if (str.length <= max) return str;
  return str.substring(0, max) + "...";
}

function normalizeTargetCompanies(rawList = []) {
  if (!Array.isArray(rawList)) return [];
  const normalized = [];
  const seen = new Set();

  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const name = item.name ? String(item.name).trim() : "";
    const website = item.website ? String(item.website).trim() : "";
    const revenue = item.revenue ? String(item.revenue).trim() : "";
    const notes =
      item.notes?.toString().trim() ||
      item.rationale?.toString().trim() ||
      item.summary?.toString().trim() ||
      item.reason?.toString().trim() ||
      "";
    if (!name) continue;

    const canonicalName = name.toLowerCase();
    const normalizedWebsite = website
      ? website.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase()
      : "";
    const dedupeKey = `${canonicalName}|${normalizedWebsite}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    normalized.push({ name, website, revenue, notes });
    if (normalized.length >= TARGET_COMPANY_GOAL) break;
  }

  return normalized;
}

async function generateTargets({ product, location, sectors, docName, docText, docBase64 }) {
  const trimmedProduct = typeof product === "string" ? product.trim() : "";
  const trimmedLocation = typeof location === "string" ? location.trim() : "";
  const normalizedSectors = Array.isArray(sectors)
    ? sectors
        .map((sector) => (typeof sector === "string" ? sector.trim() : ""))
        .filter((sector) => !!sector)
    : [];

  if (!trimmedProduct) {
    return { error: "Product name is required to generate targets." };
  }

  let documentText = "";
  if (typeof docText === "string" && docText.trim()) {
    documentText = docText.trim();
  } else if (docBase64) {
    documentText = decodeBase64Text(docBase64);
  }

  const truncatedDoc = truncateText(documentText, 4000);
  const docSection = truncatedDoc
    ? `Supporting document (${docName || "uploaded document"}) excerpt (first 4000 characters):
${truncatedDoc}`
    : "No supporting document provided.";

  const sectorSection = normalizedSectors.length
    ? `Target sectors of the product (use these as guardrails): ${normalizedSectors.join(", ")}`
    : "Target sectors of the product were not provided. Infer the most relevant industries based on the context and product value.";

  const mullInstruction = normalizedSectors.length
    ? `- Spend several internal reasoning steps comparing "${trimmedProduct}" against each target sector (${normalizedSectors.join(
        ", "
      )}) before listing companies. Keep this reasoning private but let it guide your short list so every recommendation clearly fits one of those sectors.`
    : `- Spend several internal reasoning steps inferring which sectors benefit most from "${trimmedProduct}" before listing companies. Keep this reasoning private but let it guide your short list.`;

  const prompt = `You are a B2B sales intelligence researcher who uses live web search to validate insights.
Identify companies located in the specified geography that would be high-priority targets for purchasing the product described below.
List only companies that plausibly operate in that location and have a clear fit with the product's value.

Product name: ${trimmedProduct}
Target location: ${trimmedLocation || "Not explicitly provided. Infer a sensible geography from context but prioritize the stated location if any."}
${sectorSection}

${docSection}

Guidelines:
- ${mullInstruction.replace(/^- /, "")}
- Use search to confirm the company's presence in the target geography, their core business, and the official website.
- Prefer mid-market or enterprise buyers whose needs align with the product.
- Aggressively remove duplicates or near-duplicates so each company appears only once.
- Provide up to ${TARGET_COMPANY_GOAL} distinct companies, aiming for ${TARGET_COMPANY_GOAL} whenever credible candidates exist. Only return fewer if the market truly lacks more qualified prospects.
- If revenue is unavailable, leave the revenue field as an empty string.
- Keep notes to one concise sentence explaining the fit.

Respond in STRICT JSON with this shape (no Markdown fences, no commentary):
{
  "companies": [
    {
      "name": "Company name",
      "website": "https://official.website",
      "revenue": "Most recent annual revenue or range, or empty string if unknown",
      "notes": "One sentence on why the company is a fit"
    }
  ]
}`;

  const resp = await callGeminiDirect(prompt, {
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 100000,
    },
  });

  if (resp.error) {
    return { error: resp.error, details: resp.details };
  }

  const rawText = resp.text || "";
  let parsed = extractJsonFromText(rawText);

  if (!parsed && rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      parsed = null;
    }
  }

  if (!parsed && resp.raw?.candidates?.[0]?.content?.parts?.length) {
    const combined = resp.raw.candidates[0].content.parts
      .map((part) => part?.text || "")
      .filter(Boolean)
      .join("\n");
    if (combined) {
      parsed = extractJsonFromText(combined);
      if (!parsed) {
        try {
          parsed = JSON.parse(combined);
        } catch (err) {
          parsed = null;
        }
      }
    }
  }

  if (!parsed || !Array.isArray(parsed.companies)) {
    return { error: "Model did not return a structured company list.", details: rawText || null };
  }

  const companies = normalizeTargetCompanies(parsed.companies);
  return { ok: true, companies };
}

function prepareDatasetForPrompt(entries = []) {
  return entries.map((entry) => {
    const briefHtml = truncateText(entry?.result?.brief_html || "", 2000);
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      request: entry.request || {},
      result: {
        brief_html: briefHtml,
        personas: Array.isArray(entry?.result?.personas) ? entry.result.personas : [],
        personaEmails: Array.isArray(entry?.result?.personaEmails) ? entry.result.personaEmails : [],
        email: entry?.result?.email || {},
      },
    };
  });
}

function composeExportPrompt(columns, entries, format) {
  const columnLines = columns
    .map((col, idx) => `${idx + 1}. ${col.header} - ${col.description}`)
    .join("\n");

  const dataset = prepareDatasetForPrompt(entries);
  const datasetJson = JSON.stringify(dataset, null, 2);

  const formatInstruction =
    format === "md"
      ? "Provide a Markdown table string in the field `markdownTable`."
      : "Ensure the JSON rows can be used to build an .xlsx file.";

  return `You are helping prepare research data for export.

Column specifications (respect the header text exactly):
${columnLines}

The research entries are provided as JSON below. Each entry may include nested details such as personas and generated content. Derive values for each column from the available data. If a value is missing, use an empty string. Do not invent data beyond reasonable inferences from the supplied content.

Research entries JSON:
${datasetJson}

Respond in strict JSON with this shape:
{
  "rows": [
    {
      "<Header 1>": "cell value",
      "<Header 2>": "cell value"
    }
  ],
  "notes": "optional short quality notes or considerations",
  "markdownTable": "optional markdown table representing all rows"
}

- The \`rows\` array must contain one object per research entry in the same order they were supplied.
- Each row object must include every header and only those headers.
- Use multiline strings where helpful (they will be preserved).
- ${formatInstruction}
`;
}

function ensureRowValues(row, columns) {
  const normalized = {};
  columns.forEach((col) => {
    const header = col.header;
    const value = row && Object.prototype.hasOwnProperty.call(row, header) ? row[header] : "";
    if (value === undefined || value === null) {
      normalized[header] = "";
    } else if (typeof value === "string") {
      normalized[header] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      normalized[header] = String(value);
    } else {
      try {
        normalized[header] = JSON.stringify(value);
      } catch (err) {
        normalized[header] = String(value);
      }
    }
  });
  return normalized;
}

function filterHistoryEntries(entries, selection = {}) {
  const { type = "all" } = selection;
  if (type === "all") {
    return [...entries];
  }

  if (type === "custom") {
    const ids = Array.isArray(selection.selectedIds) ? new Set(selection.selectedIds) : new Set();
    if (!ids.size) return [];
    return entries.filter((entry) => ids.has(entry.id));
  }

  if (type === "date") {
    const path = selection.dateFieldPath || "createdAt";
    const fromTime = selection.from ? new Date(selection.from).getTime() : null;
    const toTime = selection.to ? new Date(selection.to).getTime() : null;

    return entries.filter((entry) => {
      const value = getValueAtPath(entry, path);
      if (!value) return false;
      const ts = new Date(value).getTime();
      if (Number.isNaN(ts)) return false;
      if (fromTime !== null && ts < fromTime) return false;
      if (toTime !== null && ts > toTime) return false;
      return true;
    });
  }

  return [...entries];
}

function normalizeLocationString(candidate) {
  if (!candidate) return "";
  if (typeof candidate === "string") {
    return candidate.trim();
  }
  if (Array.isArray(candidate)) {
    const parts = candidate.map((item) => normalizeLocationString(item)).filter(Boolean);
    return parts.join(", ");
  }
  if (typeof candidate === "object") {
    const prioritizedKeys = [
      "formatted_address",
      "address",
      "address_text",
      "address_line",
      "description",
      "text",
      "value",
      "name",
      "full_address",
    ];
    for (const key of prioritizedKeys) {
      if (typeof candidate[key] === "string" && candidate[key].trim()) {
        return candidate[key].trim();
      }
    }

    const cityParts = [];
    if (candidate.city) cityParts.push(candidate.city);
    if (candidate.state || candidate.region || candidate.province) {
      cityParts.push(candidate.state || candidate.region || candidate.province);
    }
    if (candidate.country) cityParts.push(candidate.country);
    if (cityParts.length) {
      return cityParts
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean)
        .join(", ");
    }
  }
  return "";
}

function resolveLocationFromStructured(structured) {
  if (!structured || typeof structured !== "object") return "";
  const candidates = [
    structured.hq_location,
    structured.headquarters,
    structured.location,
    structured.answer,
    structured.result,
  ];

  if (Array.isArray(structured.supporting_places)) {
    structured.supporting_places.forEach((place) => {
      candidates.push(place);
      if (place && typeof place === "object") {
        candidates.push(place.formatted_address);
      }
    });
  }

  for (const candidate of candidates) {
    const normalized = normalizeLocationString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnNumberToName(n) {
  let name = "";
  let num = n;
  while (num > 0) {
    const remainder = (num - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    num = Math.floor((num - 1) / 26);
  }
  return name;
}

function buildWorksheetXml(headers, rows) {
  const totalRows = rows.length + 1;
  const lastColumn = columnNumberToName(headers.length);
  const dimensionRef = `A1:${lastColumn}${Math.max(totalRows, 1)}`;

  const makeCell = (rowIndex, colIndex, value, isHeader = false) => {
    const ref = `${columnNumberToName(colIndex)}${rowIndex}`;
    const escaped = escapeXml(value);
    const style = isHeader ? ` s="1"` : "";
    return `<c r="${ref}" t="inlineStr"${style}><is><t>${escaped}</t></is></c>`;
  };

  const rowsXml = [];
  const headerCells = headers
    .map((header, idx) => makeCell(1, idx + 1, header, true))
    .join("");
  rowsXml.push(`<row r="1">${headerCells}</row>`);

  rows.forEach((row, rowIdx) => {
    const cells = headers
      .map((header, colIdx) => makeCell(rowIdx + 2, colIdx + 1, row[header] || "", false))
      .join("");
    rowsXml.push(`<row r="${rowIdx + 2}">${cells}</row>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dimensionRef}"/>
  <sheetViews>
    <sheetView workbookViewId="0"/>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>
    ${rowsXml.join("\n    ")}
  </sheetData>
</worksheet>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font>
      <sz val="11"/>
      <color theme="1"/>
      <name val="Calibri"/>
      <family val="2"/>
    </font>
    <font>
      <b/>
      <sz val="11"/>
      <color theme="1"/>
      <name val="Calibri"/>
      <family val="2"/>
    </font>
  </fonts>
  <fills count="1">
    <fill>
      <patternFill patternType="none"/>
    </fill>
  </fills>
  <borders count="1">
    <border>
      <left/>
      <right/>
      <top/>
      <bottom/>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;
}

function buildContentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function buildRootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildWorkbookRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function buildWorkbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <fileVersion appName="Calc"/>
  <sheets>
    <sheet name="Export" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}

function buildDocPropsCoreXml(timestamp) {
  const iso = timestamp.toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>AccountIQ Export</dc:creator>
  <cp:lastModifiedBy>AccountIQ Export</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>
</cp:coreProperties>`;
}

function buildDocPropsAppXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>AccountIQ Export</Application>
</Properties>`;
}

function stringToUint8(str) {
  return new TextEncoder().encode(str);
}

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    let c;
    const table = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })());

  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

function dateToDosParts(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  return {
    dosDate: year < 1980 ? 0 : dosDate,
    dosTime: year < 1980 ? 0 : dosTime,
  };
}

function assembleZip(files) {
  let totalSize = 0;
  const fileEntries = [];
  const centralEntries = [];
  let offset = 0;

  const encoder = new TextEncoder();
  const now = new Date();
  const { dosDate, dosTime } = dateToDosParts(now);

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.path);
    let dataBytes = file.data instanceof Uint8Array ? file.data : encoder.encode(file.data);
    const crc = crc32(dataBytes);
    const compressedSize = dataBytes.length;
    const uncompressedSize = dataBytes.length;
    const localHeaderSize = 30 + nameBytes.length;

    const localHeader = new Uint8Array(localHeaderSize);
    const lhView = new DataView(localHeader.buffer);
    lhView.setUint32(0, 0x04034b50, true);
    lhView.setUint16(4, 20, true);
    lhView.setUint16(6, 0, true);
    lhView.setUint16(8, 0, true);
    lhView.setUint16(10, dosTime, true);
    lhView.setUint16(12, dosDate, true);
    lhView.setUint32(14, crc, true);
    lhView.setUint32(18, compressedSize, true);
    lhView.setUint32(22, uncompressedSize, true);
    lhView.setUint16(26, nameBytes.length, true);
    lhView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    fileEntries.push(localHeader);
    fileEntries.push(dataBytes);

    const centralHeaderSize = 46 + nameBytes.length;
    const centralHeader = new Uint8Array(centralHeaderSize);
    const chView = new DataView(centralHeader.buffer);
    chView.setUint32(0, 0x02014b50, true);
    chView.setUint16(4, 20, true);
    chView.setUint16(6, 20, true);
    chView.setUint16(8, 0, true);
    chView.setUint16(10, 0, true);
    chView.setUint16(12, dosTime, true);
    chView.setUint16(14, dosDate, true);
    chView.setUint32(16, crc, true);
    chView.setUint32(20, compressedSize, true);
    chView.setUint32(24, uncompressedSize, true);
    chView.setUint16(28, nameBytes.length, true);
    chView.setUint16(30, 0, true);
    chView.setUint16(32, 0, true);
    chView.setUint16(34, 0, true);
    chView.setUint16(36, 0, true);
    chView.setUint32(38, 0, true);
    chView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralEntries.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  });

  const centralDirectorySize = centralEntries.reduce((acc, arr) => acc + arr.length, 0);
  const centralDirectoryOffset = offset;

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralDirectorySize, true);
  eocdView.setUint32(16, centralDirectoryOffset, true);
  eocdView.setUint16(20, 0, true);

  totalSize =
    fileEntries.reduce((acc, arr) => acc + arr.length, 0) +
    centralEntries.reduce((acc, arr) => acc + arr.length, 0) +
    eocd.length;

  const output = new Uint8Array(totalSize);
  let pointer = 0;
  fileEntries.forEach((arr) => {
    output.set(arr, pointer);
    pointer += arr.length;
  });
  centralEntries.forEach((arr) => {
    output.set(arr, pointer);
    pointer += arr.length;
  });
  output.set(eocd, pointer);

  return output;
}

function buildXlsxFile(headers, rows) {
  const timestamp = new Date();
  const worksheetXml = buildWorksheetXml(headers, rows);
  const files = [
    { path: "[Content_Types].xml", data: buildContentTypesXml() },
    { path: "_rels/.rels", data: buildRootRelsXml() },
    { path: "xl/workbook.xml", data: buildWorkbookXml() },
    { path: "xl/_rels/workbook.xml.rels", data: buildWorkbookRelsXml() },
    { path: "xl/worksheets/sheet1.xml", data: worksheetXml },
    { path: "xl/styles.xml", data: buildStylesXml() },
    { path: "docProps/core.xml", data: buildDocPropsCoreXml(timestamp) },
    { path: "docProps/app.xml", data: buildDocPropsAppXml() },
  ];
  return assembleZip(files);
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function stringToBase64(str) {
  return uint8ToBase64(stringToUint8(str));
}

function generateMarkdownFromRows(headers, rows) {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((row) => {
      const cells = headers.map((header) => {
        const value = row[header] || "";
        return value.replace(/\n/g, "<br>");
      });
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
  return `${headerLine}\n${separator}${body ? `\n${body}` : ""}`;
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
        personaEmails: Array.isArray(result.personaEmails) ? result.personaEmails : [],
        industry_sector: typeof result.industry_sector === "string" ? result.industry_sector : "",
        telephonicPitches: Array.isArray(result.telephonicPitches) ? result.telephonicPitches : [],
        telephonicPitchError: typeof result.telephonicPitchError === "string" ? result.telephonicPitchError : "",
        telephonicPitchAttempts: Array.isArray(result.telephonicPitchAttempts) ? result.telephonicPitchAttempts : [],
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

async function saveTargetHistoryEntry(request, result) {
  try {
    const entry = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      request: {
        product: request.product || "",
        location: request.location || "",
        docName: request.docName || "",
        sectors: Array.isArray(request.sectors)
          ? request.sectors
              .map((sector) => (typeof sector === "string" ? sector.trim() : ""))
              .filter((sector) => !!sector)
          : [],
      },
      result: {
        companies: Array.isArray(result?.companies) ? result.companies : [],
      },
    };

    const existing = await chrome.storage.local.get([TARGET_HISTORY_KEY]);
    const history = Array.isArray(existing[TARGET_HISTORY_KEY]) ? existing[TARGET_HISTORY_KEY] : [];

    history.unshift(entry);
    const trimmed = history.slice(0, 25);

    await chrome.storage.local.set({ [TARGET_HISTORY_KEY]: trimmed });
    return entry;
  } catch (err) {
    console.warn("Failed to persist target history", err);
    return null;
  }
}

async function fetchHeadquartersLocation({ companyName, locationHint }) {
  if (!companyName) {
    return { location: "", metadata: null, rawText: "", error: "Missing company name" };
  }

  const focusInstruction = locationHint
    ? `If multiple locations exist, prioritize the HQ that governs operations connected to ${locationHint}.`
    : `Return the official global headquarters registered for the company.`;

  const prompt = `You are verifying the official headquarters for ${companyName}.
${focusInstruction}

Requirements:
- Use Google Search to gather the latest authoritative mentions of the headquarters address.
- Then call the Google Maps tool to pull the place details, coordinates, and formatted address so the answer is grounded in a real map listing.
- If there are conflicting sources, explain why the selected HQ is most accurate.

Respond strictly in JSON:
{
  "hq_location": "City, State/Region, Country",
  "hq_coordinates": "Latitude,Longitude or descriptive coordinates string",
  "confidence_notes": "Short justification mentioning Google Search and Google Maps signals",
  "supporting_places": [
    {
      "name": "",
      "formatted_address": "",
      "map_url": "",
      "evidence": "What the Google Maps lookup confirmed"
    }
  ]
}
`;

  try {
    const resp = await callGeminiDirect(prompt, {
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
        
      },
      tools: [{ google_search: {} }, { googleMaps: {} }],
    });

    if (resp.error) {
      console.warn("Failed to fetch headquarters location", resp.error, resp.details || resp);
      return { location: "", metadata: null, rawText: "", error: resp.error };
    }

    const payloadText = resp.text || "";
    let parsed = extractJsonFromText(payloadText);
    if (!parsed && payloadText) {
      try {
        parsed = JSON.parse(payloadText);
      } catch (err) {
        parsed = null;
      }
    }

    if (!parsed && resp.raw?.candidates?.[0]?.content?.parts?.length) {
      const combined = resp.raw.candidates[0].content.parts
        .map((part) => part?.text || "")
        .filter(Boolean)
        .join("\n");
      if (combined) {
        parsed = extractJsonFromText(combined);
        if (!parsed) {
          try {
            parsed = JSON.parse(combined);
          } catch (err) {
            parsed = null;
          }
        }
      }
    }

    const structured = parsed && typeof parsed === "object" ? parsed : null;
    if (!structured) {
      return {
        location: "",
        metadata: null,
        rawText: payloadText,
        error: "Headquarters lookup returned no structured JSON.",
      };
    }

    const resolvedLocation = resolveLocationFromStructured(structured);

    if (!resolvedLocation) {
      return {
        location: "",
        metadata: structured,
        rawText: payloadText,
        error: "Headquarters lookup did not include a location.",
      };
    }

    return {
      location: resolvedLocation,
      metadata: structured,
      rawText: payloadText,
    };
  } catch (err) {
    console.warn("Failed to fetch headquarters location", err);
    return { location: "", metadata: null, rawText: "", error: err?.message || String(err) };
  }
}

function summarizePersonasForTelepitch(personas = []) {
  if (!Array.isArray(personas) || !personas.length) return "";
  return personas
    .map((persona, idx) => {
      const bits = [
        `Persona ${idx + 1}:`,
        `Name: ${persona.name || `Persona ${idx + 1}`}`,
        persona.designation ? `Designation: ${persona.designation}` : null,
        persona.department ? `Department: ${persona.department}` : null,
      ].filter(Boolean);
      return bits.join(" ");
    })
    .join("\n");
}

function buildTelephonicPitchPrompt({ personas, company, location, product, docsText }) {
  const personaSummary = summarizePersonasForTelepitch(personas);
  return `You are a helpful assistant. Generate a concise telephonic sales pitch for the following:
  Instructions:
      - Research the product, company priorities, and each persona's responsibilities so the caller sounds well informed and relevant.
      - Build a 45-60 second phone script for every persona that starts with a personalized opener, adds one probing question, and ties ${product} to their KPIs.
      - Include a proof or credibility statement plus a clear CTA (Asking for a 20-minute follow-up or meeting).
      - Maintain a confident, consultative tone that feels natural for a live call. Avoid long email-like sentences.
      - Here's an example of telephonic pitch: "Hi [Name], this is [Your Name] calling from [Your Company]. Am I catching you at a good time for quick minute?
      Great, thank you! I'll keep this really short. I work with companies in the [Target company sector]- helping them [your product feature verbs].
      You might have heard of [Your Product] - it's a solution that helps [Your Product Features]. 
      For a company like yours, where you're [Target Company Pain Point verbs], [Your Product] can [Your Product's Effects and Improvements].
      I'd love to set up a short 20 minute demo with our [Relevant Team from Your Company]. 
      They can walk you through how [Target Company] could use it for [Your Product's Effects and Improvements]. Would that work for you sometime this week?" 

      Company: ${company}
  Location: ${location || "N/A"}
  Product: ${product}

  Known personas:
  ${personaSummary || "None provided. Infer from context."}

  Context docs (first 4000 chars each):
  ${docsText || "(no docs provided)"}

  Output JSON in this structure EXACTLY. Do not include \`\`\`json markdown wrappers.
  {
    "telephonic_pitches": [
      {"full_pitch": ""}
    ]
  }

  Keep each section crisp and action-oriented.`;
}

function deriveTelephonicPitchArray(payload, depth = 0) {
  if (!payload || depth > 2) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];

  const candidateKeys = [
    "telephonic_pitches",
    "telephonicPitches",
    "telephonicPitch",
    "pitches",
    "scripts",
    "phone_scripts",
    "phoneScripts",
  ];

  for (const key of candidateKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate) && candidate.length) {
      return candidate;
    }
  }

  if (payload.result && typeof payload.result === "object") {
    const nested = deriveTelephonicPitchArray(payload.result, depth + 1);
    if (nested.length) return nested;
  }

  if (payload.data && typeof payload.data === "object") {
    const nested = deriveTelephonicPitchArray(payload.data, depth + 1);
    if (nested.length) return nested;
  }

  return [];
}

function normalizeTelephonicPitchEntry(pitch, idx, personas) {
  const fallbackPersona = (Array.isArray(personas) && personas[idx]) || {};
  const base = {
    personaName: fallbackPersona.name || `Persona ${idx + 1}`,
    personaDesignation: fallbackPersona.designation || "",
    personaDepartment: fallbackPersona.department || "",
    callGoal: "",
    opener: "",
    discoveryQuestion: "",
    valueStatement: "",
    proofPoint: "",
    cta: "",
    script: "",
  };

  if (!pitch) return base;
  if (typeof pitch === "string") {
    base.script = pitch;
    return base;
  }
  if (typeof pitch !== "object") {
    return base;
  }

  base.personaName = pitch.persona_name || pitch.name || base.personaName;
  base.personaDesignation = pitch.designation || pitch.persona_designation || base.personaDesignation;
  base.personaDepartment = pitch.department || pitch.persona_department || base.personaDepartment;
  base.callGoal = pitch.call_goal || pitch.callGoal || pitch.call_objective || pitch.goal || base.callGoal;
  base.opener = pitch.opener || pitch.opening || pitch.opening_hook || pitch.hook || base.opener;

  if (Array.isArray(pitch.discovery_questions) && pitch.discovery_questions.length) {
    base.discoveryQuestion = pitch.discovery_questions.join(" / ");
  } else {
    base.discoveryQuestion =
      pitch.discovery_question || pitch.discoveryQuestion || pitch.question || base.discoveryQuestion;
  }

  base.valueStatement =
    pitch.value_statement || pitch.valueStatement || pitch.value_pitch || pitch.value || base.valueStatement;
  base.proofPoint =
    pitch.proof_point ||
    pitch.proofPoint ||
    pitch.credibility_statement ||
    pitch.social_proof ||
    base.proofPoint;
  base.cta = pitch.cta || pitch.closing_prompt || pitch.next_step || pitch.closing || base.cta;
  base.script = pitch.full_pitch || pitch.fullPitch || pitch.pitch || pitch.call_script || pitch.script || base.script;

  if (!base.script) {
    const fallbackLines = [
      base.opener,
      base.discoveryQuestion ? `Discovery: ${base.discoveryQuestion}` : "",
      base.valueStatement,
      base.proofPoint,
      base.cta,
    ]
      .filter(Boolean)
      .join("\n");
    base.script = fallbackLines;
  }

  return base;
}

function summarizeTelephonicDebugInfo(payload) {
  if (!payload) return "";
  let str = "";
  if (typeof payload === "string") {
    str = payload;
  } else {
    try {
      str = JSON.stringify(payload);
    } catch (err) {
      str = "";
    }
  }
  if (!str) return "";
  const trimmed = str.trim();
  if (!trimmed) return "";
  return trimmed.length > 800 ? `${trimmed.slice(0, 800)}...` : trimmed;
}

function extractTelephonicPitchResponse(resp, personas) {
  let teleText = typeof resp.text === "string" ? resp.text : "";
  let teleParsed = extractJsonFromText(teleText);
  if (!teleParsed && teleText) {
    try {
      teleParsed = JSON.parse(teleText);
    } catch (err) {
      teleParsed = null;
    }
  }

  if (!teleParsed && resp.raw?.candidates?.[0]?.content?.parts?.length) {
    const combined = resp.raw.candidates[0].content.parts
      .map((part) => part?.text || "")
      .filter(Boolean)
      .join("\n");
    if (combined) {
      teleParsed = extractJsonFromText(combined);
      if (!teleParsed) {
        try {
          teleParsed = JSON.parse(combined);
        } catch (err) {
          teleParsed = null;
        }
      }
      if (!teleText) {
        teleText = combined;
      }
    }
  }

  const teleArray = deriveTelephonicPitchArray(teleParsed);
  if (!teleArray.length) {
    return {
      pitches: [],
      rawText: teleText || null,
      error: "Response did not include a telephonic_pitches array.",
    };
  }

  const normalized = teleArray
    .filter((entry) => entry && (typeof entry === "object" || typeof entry === "string"))
    .map((entry, idx) => normalizeTelephonicPitchEntry(entry, idx, personas))
    .filter(Boolean);

  if (!normalized.length) {
    return {
      pitches: [],
      rawText: teleText || null,
      error: "Unable to normalize telephonic pitch entries.",
    };
  }

  return { pitches: normalized };
}

async function generateTelephonicPitchScripts({ personas, company, location, product, docsText }) {
  const prompt = buildTelephonicPitchPrompt({ personas, company, location, product, docsText });
  const attempts = [];

  const runAttempt = async (label, structuredOutput) => {
    try {
      const generationConfig = {
        temperature: 0.2,
        maxOutputTokens: 4096,
      };
      if (structuredOutput) {
        generationConfig.responseMimeType = "application/json";
      }
      const teleResp = await callGeminiDirect(prompt, {
        generationConfig,
        tools: [{ google_search: {} }],
      });

      if (teleResp.error) {
        attempts.push({
          label,
          error: teleResp.error,
          details: summarizeTelephonicDebugInfo(teleResp.details),
        });
        return null;
      }

      const parsed = extractTelephonicPitchResponse(teleResp, personas);
      if (parsed.pitches.length) {
        return parsed.pitches;
      }
      attempts.push({
        label,
        error: parsed.error || "Model response missing telephonic pitches.",
        details: summarizeTelephonicDebugInfo(parsed.rawText || teleResp.text || teleResp.raw),
      });
      return null;
    } catch (err) {
      attempts.push({
        label,
        error: err?.message || String(err),
      });
      return null;
    }
  };

  const structuredResult = await runAttempt("json-output", true);
  if (structuredResult && structuredResult.length) {
    return { pitches: structuredResult, attempts };
  }

  const fallbackResult = await runAttempt("text-output", false);
  if (fallbackResult && fallbackResult.length) {
    return { pitches: fallbackResult, attempts };
  }

  const lastError =
    attempts.length && attempts[attempts.length - 1].error
      ? attempts[attempts.length - 1].error
      : "Unable to generate telephonic pitches.";

  return { pitches: [], error: lastError, attempts };
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
      - Search for the designation and department of each of the personas in the company.
      - Search for the recent news headlines related the target company.
      - Search for the company's revenue, Industry Sector and provide a realistic revenue_estimate.
      - For each persona, craft a separate outreach email from the seller to that persona highlighting product value for their responsibilities.
      - Each persona email must include a clear subject line and a concise, professional body tailored to that persona.
      - Search and include the ZoomInfo OR LinkedIn OR Cognism link for each persona as a search string link. DO NOT INCLUDE the term "google search:"
      - The email should have a strong sales pitch tone. 
      - As an example take the following reference: "Hi [Name], this is [Your Name] from IBM. I'll keep this really short - I work with [Target Sector] leaders on speeding up how they move and manage large files securely. I want to quickly bring up [Product] - [Product Description]. For a Company like [Company Name], where you're [Company objectives and core sector verbs]- [Product] can help streamline [Pain points]. Would it make sense to schedule a quick 20 minute discussion with your [relevant team]- just to explore if this could optimize your [core sectoral verbs]?"
  Company: ${company}
  Location: ${location || "N/A"}
  Product: ${product}

  Context docs (first 4000 chars each):
  ${docsText || "(no docs provided)"}

  Output JSON in this structure EXACTLY. Do not include \`\`\`json markdown wrappers.
  {
    "company_name": "",
    "revenue_estimate": "",
    "industry_sector":'',
    "top_5_news": [
      {"title": "", "summary": ""}
    ],
    "key_personas": [
      {"name": "", "designation": "", "department": "", "zoominfo_link": "", "email": {"subject": "", "body": ""}}
    ]
  }

  Be concise. If no data available, return empty strings or empty arrays as appropriate.
  `;

    const resp = await callGeminiDirect(prompt, {
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096
      },
      tools: [{ google_search: {} }],
    });

    if (resp.error) return { error: resp.error + (resp.details ? ' Details: ' + JSON.stringify(resp.details) : ''), attempts: resp.details || [] };

    const outText = resp.text || resp.raw || "";
    const parsed = extractJsonFromText(outText);
    
    if (!parsed) {
      return { brief: outText || "No output from model.", raw: outText, error: "Model did not return valid JSON." };
    }

    const hqLookup = await fetchHeadquartersLocation({
      companyName: parsed.company_name || company,
      locationHint: location || "",
    });
    const resolvedHqLocation = hqLookup?.location || parsed.hq_location || "";
    const hqErrorMessage = hqLookup?.error ? `HQ lookup failed: ${hqLookup.error}` : "";
    const displayedHq = resolvedHqLocation || hqErrorMessage || "Not found";
    const industrySector =
      parsed.industry_sector ||
      parsed.industrySector ||
      parsed.industry ||
      "";
    const displayedIndustry = industrySector || "Not found";

    let brief_html = `<h4>${parsed.company_name || company}</h4>`;
    brief_html += `<p><strong>Headquarters:</strong> ${displayedHq} &nbsp; <strong>Revenue:</strong> ${
      parsed.revenue_estimate || ""
    } &nbsp; <strong>Industry sector:</strong> ${displayedIndustry}</p>`;
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
      

    const rawPersonas = Array.isArray(parsed.key_personas) ? parsed.key_personas : [];

    const personas = rawPersonas.map(p => ({
      name: p.name || "",
      designation: p.designation || "",
      department: p.department || "",
      zoominfo_link: (p.zoominfo_link || p.zoomInfo || p.zoominfo || p.zoom) || buildZoomInfoSearchLink(p, parsed.company_name || company)
    }));

    const personaEmails = rawPersonas.map((p, idx) => {
      const personaName = p.name || `Persona ${idx + 1}`;
      const emailData = p.email || p.persona_email || {};
      const subject = (emailData && typeof emailData === "object" ? emailData.subject : undefined) || p.email_subject || "";
      const body = (emailData && typeof emailData === "object" ? emailData.body : undefined) || p.email_body || "";
      return {
        personaName,
        personaDesignation: p.designation || "",
        personaDepartment: p.department || "",
        subject: subject || "",
        body: body || ""
      };
    });

    const personaEmailsArray = Array.isArray(parsed.persona_emails) ? parsed.persona_emails : Array.isArray(parsed.personaEmails) ? parsed.personaEmails : [];
    if (personaEmailsArray.length) {
      personaEmails.forEach((entry, idx) => {
        const fallbackEmail = personaEmailsArray[idx] || personaEmailsArray.find(pe => {
          const candidateName = (pe.persona_name || pe.name || "").toLowerCase();
          return candidateName && candidateName === (entry.personaName || "").toLowerCase();
        });
        if (fallbackEmail) {
          const sub = fallbackEmail.subject || fallbackEmail.email_subject || "";
          const bod = fallbackEmail.body || fallbackEmail.email_body || "";
          if (!entry.subject) entry.subject = sub || "";
          if (!entry.body) entry.body = bod || "";
        }
      });
      if (!personaEmails.length) {
        personaEmailsArray.forEach((pe, idx) => {
          personaEmails.push({
            personaName: pe.persona_name || pe.name || `Persona ${idx + 1}`,
            personaDesignation: pe.persona_designation || pe.designation || "",
            personaDepartment: pe.persona_department || pe.department || "",
            subject: pe.subject || pe.email_subject || "",
            body: pe.body || pe.email_body || ""
          });
        });
      }
    }

    let telephonicPitches = [];
    let telephonicPitchError = "";
    let telephonicPitchAttempts = [];
    if (personas.length) {
      try {
        const teleResult = await generateTelephonicPitchScripts({
          personas,
          company,
          location,
          product,
          docsText,
        });
        telephonicPitches = Array.isArray(teleResult.pitches) ? teleResult.pitches : [];
        telephonicPitchError = teleResult.error || "";
        telephonicPitchAttempts = Array.isArray(teleResult.attempts) ? teleResult.attempts : [];
        if (telephonicPitchError) {
          console.warn("Telephonic pitch generation failed", telephonicPitchError, telephonicPitchAttempts);
        }
      } catch (teleErr) {
        telephonicPitchError = teleErr?.message || String(teleErr);
        console.warn("Telephonic pitch generation threw", teleErr);
      }
    }

    let emailObj = { subject: "", body: "" };
    if (personaEmails.length) {
      emailObj.subject = personaEmails[0]?.subject || "";
      emailObj.body = personaEmails[0]?.body || "";
    }

    if (!emailObj.subject && !emailObj.body) {
      if (typeof parsed.personalized_email === "string") {
        emailObj.body = parsed.personalized_email;
      } else if (parsed.personalized_email && typeof parsed.personalized_email === "object") {
        emailObj.subject = parsed.personalized_email.subject || "";
        emailObj.body = parsed.personalized_email.body || "";
      }
    }

    return {
      brief_html,
      personas,
      personaEmails,
      industry_sector: industrySector,
      telephonicPitches,
      telephonicPitchError,
      telephonicPitchAttempts,
      email: emailObj,
      hq_location: resolvedHqLocation,
      hq_lookup_details: hqLookup?.metadata || null,
      hq_lookup_error: hqLookup?.error || "",
      hq_lookup_raw: hqLookup?.rawText || "",
      raw: outText,
    };
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
        if (req.action === 'generateTargets') {
          const result = await generateTargets({
            product: req.product,
            location: req.location,
            sectors: req.sectors,
            docName: req.docName,
            docText: req.docText,
            docBase64: req.docBase64,
          });
          if (result && result.ok) {
            await saveTargetHistoryEntry(
              { product: req.product, location: req.location, docName: req.docName, sectors: req.sectors },
              { companies: result.companies }
            );
          }
          sendResponse(result);
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
        if (req.action === 'getTargetHistory') {
          const data = await chrome.storage.local.get([TARGET_HISTORY_KEY]);
          const history = Array.isArray(data[TARGET_HISTORY_KEY]) ? data[TARGET_HISTORY_KEY] : [];
          sendResponse({ history });
          return;
        }
        if (req.action === 'exportResearch') {
          const selection = req.selection || { type: "all" };
          const format = req.format === "md" ? "md" : "xlsx";

          let activeTemplate = req.template;
          if (!activeTemplate || !Array.isArray(activeTemplate.columns) || !activeTemplate.columns.length) {
            const stored = await chrome.storage.local.get([EXPORT_TEMPLATE_KEY]);
            const storedTemplate = stored && stored[EXPORT_TEMPLATE_KEY];
            if (storedTemplate && Array.isArray(storedTemplate.columns) && storedTemplate.columns.length) {
              activeTemplate = storedTemplate;
            }
          }

          if (!activeTemplate || !Array.isArray(activeTemplate.columns) || !activeTemplate.columns.length) {
            sendResponse({ error: "No export template found. Please add export columns in settings." });
            return;
          }

          const columns = activeTemplate.columns
            .map((col, idx) => {
              const header = (col && col.header ? String(col.header) : "").trim();
              const descriptionRaw = col && col.description ? String(col.description) : "";
              const description = descriptionRaw.trim() || `User defined column ${idx + 1}`;
              return header ? { header, description } : null;
            })
            .filter(Boolean);

          if (!columns.length) {
            sendResponse({ error: "Export template must include at least one column header." });
            return;
          }

          const storedData = await chrome.storage.local.get(["researchHistory"]);
          const history = Array.isArray(storedData.researchHistory) ? storedData.researchHistory : [];

          if (!history.length) {
            sendResponse({ error: "No research history available to export." });
            return;
          }

          const filteredEntries = filterHistoryEntries(history, selection);
          if (!filteredEntries.length) {
            sendResponse({ error: "No research entries match the selected range." });
            return;
          }

          const prompt = composeExportPrompt(columns, filteredEntries, format);
          const llmResult = await callGeminiDirect(prompt, {
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 4096,
              responseMimeType: "application/json",
            },
          });

          if (llmResult.error) {
            sendResponse({ error: llmResult.error, details: llmResult.details });
            return;
          }

          const payloadText = llmResult.text || "";
          let parsed = extractJsonFromText(payloadText);
          if (!parsed && payloadText) {
            try {
              parsed = JSON.parse(payloadText);
            } catch (err) {
              parsed = null;
            }
          }

          if (!parsed && llmResult.raw?.candidates?.[0]?.content?.parts?.length) {
            const combined = llmResult.raw.candidates[0].content.parts
              .map((part) => part?.text || "")
              .filter(Boolean)
              .join("\n");
            if (combined) {
              parsed = extractJsonFromText(combined);
              if (!parsed) {
                try {
                  parsed = JSON.parse(combined);
                } catch (err) {
                  parsed = null;
                }
              }
            }
          }

          if (!parsed || !Array.isArray(parsed.rows)) {
            sendResponse({ error: "Model did not return structured rows for export.", details: payloadText || null });
            return;
          }

          const normalizedRows = parsed.rows.map((row) => ensureRowValues(row, columns));
          const headers = columns.map((col) => col.header);

          let markdownTable = parsed.markdownTable || parsed.markdown || parsed.table;
          if (format === "md" && !markdownTable) {
            markdownTable = generateMarkdownFromRows(headers, normalizedRows);
          }

          let base64Data = "";
          let mimeType = "";
          let filename = "";

          if (format === "md") {
            const exportLines = [];
            exportLines.push(`# Research Export`);
            exportLines.push(`Generated: ${new Date().toISOString()}`);
            exportLines.push("");
            if (markdownTable) {
              exportLines.push(markdownTable);
            } else {
              exportLines.push(generateMarkdownFromRows(headers, normalizedRows));
            }
            if (parsed.notes) {
              exportLines.push("");
              exportLines.push(`> ${parsed.notes}`);
            }
            const markdownContent = exportLines.join("\n");
            base64Data = stringToBase64(markdownContent);
            mimeType = "text/markdown";
            filename = `research-export-${Date.now()}.md`;
          } else {
            const workbookBytes = buildXlsxFile(headers, normalizedRows);
            base64Data = uint8ToBase64(workbookBytes);
            mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            filename = `research-export-${Date.now()}.xlsx`;
          }

          sendResponse({
            ok: true,
            totalRows: normalizedRows.length,
            preview: {
              headers,
              rows: normalizedRows.slice(0, 10),
            },
            notes: parsed.notes || "",
            download: {
              format,
              mimeType,
              filename,
              base64: base64Data,
            },
          });
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
