// popup.js — UI handlers (rewritten to use safe DOM rendering for persona links)
const companyEl = document.getElementById('company');
const locationEl = document.getElementById('location');
const productEl = document.getElementById('product');
const fileInput = document.getElementById('fileInput');
const saveKeyBtn = document.getElementById('saveKey');
const apiKeyInput = document.getElementById('apiKey');
const generateBtn = document.getElementById('generate');
const status = document.getElementById('status');
const resultDiv = document.getElementById('result');
const briefDiv = document.getElementById('brief');
const personasDiv = document.getElementById('personas');
const emailOut = document.getElementById('emailOut');
const viewDocs = document.getElementById('viewDocs');

saveKeyBtn?.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { status.innerText = 'API key required'; return; }
  await chrome.storage.local.set({ geminiKey: key });
  status.innerText = 'API key saved.';
});

fileInput?.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files || !files.length) return;
  for (const f of files) {
    const arr = await f.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(arr)));
    chrome.runtime.sendMessage({ action: 'storeDoc', name: f.name, content_b64: b64 }, (resp) => {
      // ignore
    });
  }
  status.innerText = 'Uploaded ' + files.length + ' files.';
});

viewDocs?.addEventListener('click', async () => {
  chrome.runtime.sendMessage({ action: 'listDocs' }, (resp) => {
    const docs = resp && resp.docs ? resp.docs : [];
    if (!docs.length) {
      alert('No docs stored.');
      return;
    }
    const names = docs.map(d => d.name).join('\n');
    alert('Stored docs:\n' + names);
  });
});

// Robust URL normalizer for persona links
function normalizeUrl(u) {
  if (!u) return '';
  u = String(u).trim();

  // 1) If already has protocol, assume it's a complete URL and return as-is
  if (/^https?:\/\//i.test(u)) return u;

  // 2) If it's a Google search URL missing protocol (e.g., "www.google.com/search?q=..."), add https://
  if (/^(www\.)?google\.[a-z]{2,}\/search/i.test(u) || /^google\.[a-z]{2,}\/search/i.test(u)) {
    return 'https://' + u;
  }

  // 3) If it looks like a bare domain (e.g., "zoominfo.com" or "www.zoominfo.com/path"), add https://
  //    but avoid treating plain text phrases as domains (we require at least one dot and no spaces)
  if (!/\s/.test(u) && /\.[a-z]{2,}$/i.test(u)) {
    return u.startsWith('www.') ? 'https://' + u : 'https://' + u;
  }

  // 4) If it contains site: or known domains or contains spaces/quotes, treat it as a search query.
  //    Build a Google search URL using encodeURIComponent to avoid broken links.
  //    We include linkedin.com/in, zoominfo.com, cognism.com as typical targets.
  if (/site:|zoominfo\.|cognism\.|linkedin\.com\/in|["\s]/i.test(u)) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(u) + '&num=20';
  }

  // 5) Fallback: if it's short free text (no dots, contains words), treat as search query
  //    This avoids creating "https://some plain phrase" malformed URLs.
  return 'https://www.google.com/search?q=' + encodeURIComponent(u) + '&num=20';
}

function clearAndRenderPersonas(personas) {
  // Clear existing content
  while (personasDiv.firstChild) personasDiv.removeChild(personasDiv.firstChild);

  if (!personas || !personas.length) {
    const p = document.createElement('p');
    p.textContent = 'No personas generated.';
    personasDiv.appendChild(p);
    return;
  }

  personas.forEach(p => {
    const wrapper = document.createElement('div');
    wrapper.className = 'persona';

    // Title line: Name (bold), designation, department
    const title = document.createElement('div');
    const nameEl = document.createElement('strong');
    nameEl.textContent = p.name || '';
    title.appendChild(nameEl);

    if (p.designation) {
      const des = document.createTextNode(' — ' + p.designation);
      title.appendChild(des);
    }
    if (p.department) {
      const dept = document.createTextNode(' (' + p.department + ')');
      title.appendChild(dept);
    }
    wrapper.appendChild(title);

    // Link row
    const rawLink = p.zoominfo_link || p.zoomInfo || p.zoominfo || p.zoom || '';
    const link = normalizeUrl(rawLink);

    if (link) {
      const linkWrap = document.createElement('div');
      const a = document.createElement('a');
      // Assign href via property so browser normalizes it (prevents chrome-extension:// resolution)
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'ZoomInfo search';
      linkWrap.appendChild(a);
      wrapper.appendChild(linkWrap);
    }

    personasDiv.appendChild(wrapper);
  });
}
// ---- End helpers ----

generateBtn?.addEventListener('click', async () => {
  const company = companyEl.value.trim();
  const location = locationEl.value.trim();
  const product = productEl.value.trim();
  if (!company || !product) { status.innerText = 'Company and Product required'; return; }
  status.innerText = 'Generating…';
  resultDiv.style.display = 'none';

  chrome.runtime.sendMessage({ action: 'getDocsForProduct', product }, async (resp) => {
    const docs = resp && resp.docs ? resp.docs : [];
    chrome.runtime.sendMessage({ action: 'generateBrief', company, location, product, docs }, (result) => {
      if (!result) { status.innerText = 'Generation failed'; return; }
      if (result.error) { status.innerText = 'Error: ' + result.error; return; }
      status.innerText = 'Done.';
      resultDiv.style.display = 'block';
      // brief_html is expected to be safe-ish HTML produced by the background; we set it directly
      briefDiv.innerHTML = result.brief_html || result.brief || '';

      // personas - use the safe DOM renderer
      const ps = result.personas || [];
      clearAndRenderPersonas(ps);

      // email
      if (result.email && (result.email.subject || result.email.body)) {
        emailOut.innerText = `${result.email.subject || ''}\n\n${result.email.body || ''}`;
      } else {
        emailOut.innerText = result.email || '';
      }
    });
  });
});

(async () => {
  const data = await chrome.storage.local.get(['geminiKey']);
  if (data && data.geminiKey) apiKeyInput.value = data.geminiKey;
})();
