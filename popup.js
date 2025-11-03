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
const copyEmailBtn = document.getElementById('copyEmail');
const viewDocs = document.getElementById('viewDocs');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');

let historyEntries = [];
let currentHistoryId = null;

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
    chrome.runtime.sendMessage({ action: 'storeDoc', name: f.name, content_b64: b64 });
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

copyEmailBtn?.addEventListener('click', async () => {
  const text = emailOut?.innerText || '';
  if (!text.trim()) {
    if (status) status.innerText = 'No email to copy yet.';
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    if (status) status.innerText = 'Email copied to clipboard.';
  } catch (err) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'absolute';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    try {
      const ok = document.execCommand('copy');
      if (ok) {
        if (status) status.innerText = 'Email copied to clipboard.';
      } else {
        throw new Error('Copy command failed');
      }
    } catch (fallbackErr) {
      if (status) status.innerText = 'Unable to copy email.';
      console.warn('Copy failed', fallbackErr);
    } finally {
      document.body.removeChild(helper);
    }
  }
});

function normalizeUrl(u) {
  if (!u) return '';
  u = String(u).trim();

  if (/^https?:\/\//i.test(u)) return u;

  if (/^(www\.)?google\.[a-z]{2,}\/search/i.test(u) || /^google\.[a-z]{2,}\/search/i.test(u)) {
    return 'https://' + u;
  }

  if (!/\s/.test(u) && /\.[a-z]{2,}$/i.test(u)) {
    return u.startsWith('www.') ? 'https://' + u : 'https://' + u;
  }

  if (/site:|zoominfo\.|cognism\.|linkedin\.com\/in|["\s]/i.test(u)) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(u) + '&num=20';
  }

  return 'https://www.google.com/search?q=' + encodeURIComponent(u) + '&num=20';
}

function clearAndRenderPersonas(personas) {
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

    const rawLink = p.zoominfo_link || p.zoomInfo || p.zoominfo || p.zoom || '';
    const link = normalizeUrl(rawLink);

    if (link) {
      const linkWrap = document.createElement('div');
      const a = document.createElement('a');
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

function renderResultView(data = {}) {
  if (!resultDiv || !briefDiv || !emailOut) return;

  resultDiv.style.display = 'block';
  briefDiv.innerHTML = data.brief_html || data.brief || '';

  const personasData = Array.isArray(data.personas) ? data.personas : [];
  clearAndRenderPersonas(personasData);

  if (data.email && typeof data.email === 'object' && (data.email.subject || data.email.body)) {
    const subject = data.email.subject || '';
    const body = data.email.body || '';
    const segments = [];
    if (subject) segments.push(subject);
    if (body) segments.push(body);
    emailOut.innerText = segments.join('\n\n');
  } else if (typeof data.email === 'string') {
    emailOut.innerText = data.email;
  } else if (data.email && typeof data.email === 'object') {
    emailOut.innerText = data.email.body || '';
  } else {
    emailOut.innerText = '';
  }

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      resultDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } else {
    resultDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function formatHistoryTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderHistory(entries, opts = {}) {
  if (!historyList || !historyEmpty) return null;

  const toSortValue = (entry) => {
    if (!entry) return 0;
    const ts = entry.createdAt ? new Date(entry.createdAt).getTime() : NaN;
    if (!Number.isNaN(ts)) return ts;
    const idNum = Number(entry.id);
    return Number.isNaN(idNum) ? 0 : idNum;
  };

  historyEntries = Array.isArray(entries) ? [...entries] : [];
  historyEntries.sort((a, b) => toSortValue(b) - toSortValue(a));

  if (opts.selectEntryId) {
    currentHistoryId = opts.selectEntryId;
  } else if (opts.selectLatest && historyEntries.length) {
    currentHistoryId = historyEntries[0].id;
  } else if (currentHistoryId && !historyEntries.some(item => item.id === currentHistoryId)) {
    currentHistoryId = historyEntries.length ? historyEntries[0].id : null;
  }

  const hasEntries = historyEntries.length > 0;
  historyEmpty.style.display = hasEntries ? 'none' : 'block';

  historyList.innerHTML = '';
  if (!hasEntries) return currentHistoryId;

  historyEntries.forEach((entry) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    btn.setAttribute('role', 'listitem');
    btn.dataset.id = entry.id;
    if (entry.id === currentHistoryId) btn.classList.add('active');

    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = entry?.request?.company || 'Untitled brief';
    btn.appendChild(title);

    const subtitleText = [entry?.request?.product, entry?.request?.location].filter(Boolean).join(' • ');
    if (subtitleText) {
      const subtitle = document.createElement('span');
      subtitle.className = 'history-subtitle';
      subtitle.textContent = subtitleText;
      btn.appendChild(subtitle);
    }

    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = formatHistoryTimestamp(entry.createdAt) || '';
    btn.appendChild(meta);

    historyList.appendChild(btn);
  });

  return currentHistoryId;
}

function setActiveHistoryItem(id) {
  currentHistoryId = id;
  if (!historyList) return;
  const buttons = historyList.querySelectorAll('.history-item');
  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.id === id);
  });
}

function showHistoryEntry(entry, options = {}) {
  if (!entry) return;
  const opts = { updateForm: true, statusText: 'Loaded previous brief.', ...options };

  if (opts.updateForm) {
    if (companyEl) companyEl.value = entry?.request?.company || '';
    if (locationEl) locationEl.value = entry?.request?.location || '';
    if (productEl) productEl.value = entry?.request?.product || '';
  }

  if (entry.result) {
    renderResultView(entry.result);
  }

  if (status && typeof opts.statusText === 'string') {
    status.innerText = opts.statusText;
  }
}

function loadHistory(options = {}) {
  const opts = { autoShow: false, selectLatest: false, updateForm: true, statusText: 'Loaded previous brief.', ...options };
  chrome.runtime.sendMessage({ action: 'getResearchHistory' }, (resp) => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.warn('Failed to load history', err);
      return;
    }
    const entries = resp && Array.isArray(resp.history) ? resp.history : [];
    const selectedId = renderHistory(entries, opts);

    if (opts.autoShow && selectedId) {
      const entry = historyEntries.find(item => item.id === selectedId);
      if (entry) {
        showHistoryEntry(entry, { updateForm: opts.updateForm, statusText: opts.statusText });
        setActiveHistoryItem(selectedId);
      }
    } else if (typeof selectedId === 'string') {
      setActiveHistoryItem(selectedId);
    }
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
  currentHistoryId = null;

  chrome.runtime.sendMessage({ action: 'getDocsForProduct', product }, (resp) => {
    const docErr = chrome.runtime.lastError;
    if (docErr) {
      status.innerText = 'Failed to load docs: ' + docErr.message;
      return;
    }
    const docs = resp && Array.isArray(resp.docs) ? resp.docs : [];
    chrome.runtime.sendMessage({ action: 'generateBrief', company, location, product, docs }, (result) => {
      const genErr = chrome.runtime.lastError;
      if (genErr) { status.innerText = 'Error: ' + genErr.message; return; }
      if (!result) { status.innerText = 'Generation failed'; return; }
      if (result.error) { status.innerText = 'Error: ' + result.error; return; }
      renderResultView(result);
      status.innerText = 'Done.';
      loadHistory({ selectLatest: true, autoShow: false, updateForm: false, statusText: '' });
    });
  });
});

historyList?.addEventListener('click', (evt) => {
  const button = evt.target.closest('.history-item');
  if (!button) return;
  const { id } = button.dataset;
  if (!id) return;
  const entry = historyEntries.find(item => item.id === id);
  if (!entry) return;
  evt.preventDefault();
  setActiveHistoryItem(id);
  showHistoryEntry(entry, { updateForm: true });
});

loadHistory({ selectLatest: true, autoShow: true, statusText: '' });

(async () => {
  const data = await chrome.storage.local.get(['geminiKey']);
  if (data && data.geminiKey) apiKeyInput.value = data.geminiKey;
})();
