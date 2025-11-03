const companyEl = document.getElementById('company');
const locationEl = document.getElementById('location');
const productEl = document.getElementById('product');
const fileInput = document.getElementById('fileInput');
const saveKeyBtn = document.getElementById('saveKey');
const newResearchBtn = document.getElementById('newResearch');
const apiKeyInput = document.getElementById('apiKey');
const generateBtn = document.getElementById('generate');
const status = document.getElementById('status');
const resultDiv = document.getElementById('result');
const briefDiv = document.getElementById('brief');
const personasDiv = document.getElementById('personas');
const emailOut = document.getElementById('emailOut');
const copyEmailBtn = document.getElementById('copyEmail');
const personaTabs = document.getElementById('personaTabs');
const viewDocs = document.getElementById('viewDocs');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');

let historyEntries = [];
let currentHistoryId = null;
let personaEmailDrafts = [];
let selectedPersonaIndex = -1;

updateCopyEmailButtonState('');

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

newResearchBtn?.addEventListener('click', () => {
  companyEl && (companyEl.value = '');
  locationEl && (locationEl.value = '');
  productEl && (productEl.value = '');
  if (fileInput) fileInput.value = '';

  currentHistoryId = null;
  setActiveHistoryItem('');

  if (status) status.innerText = 'Ready for a new research brief.';

  if (resultDiv) resultDiv.style.display = 'none';
  if (briefDiv) briefDiv.innerHTML = '';
  if (personasDiv) personasDiv.innerHTML = '';

  personaEmailDrafts = [];
  selectedPersonaIndex = -1;

  if (personaTabs) {
    personaTabs.innerHTML = '';
    personaTabs.style.display = 'none';
  }

  if (emailOut) emailOut.innerText = 'No email generated yet.';
  updateCopyEmailButtonState('');
});

personaTabs?.addEventListener('click', (evt) => {
  const button = evt.target.closest('.persona-tab');
  if (!button) return;
  const { index } = button.dataset;
  const idx = Number(index);
  if (!Number.isNaN(idx)) {
    activatePersonaTab(idx);
  }
});

copyEmailBtn?.addEventListener('click', async () => {
  const text = emailOut?.innerText || '';
  if (!text.trim()) {
    if (status) status.innerText = 'No email to copy yet.';
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    if (status) {
      const personaName = getActivePersonaName();
      status.innerText = personaName ? `Email for ${personaName} copied to clipboard.` : 'Email copied to clipboard.';
    }
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
        if (status) {
          const personaName = getActivePersonaName();
          status.innerText = personaName ? `Email for ${personaName} copied to clipboard.` : 'Email copied to clipboard.';
        }
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

function mergePersonaEmails(personas = [], personaEmails = []) {
  const maxLen = Math.max(personas.length, personaEmails.length);
  if (!maxLen) return [];

  const merged = [];
  for (let i = 0; i < maxLen; i += 1) {
    const persona = personas[i] || {};
    const email = personaEmails[i] || {};
    const personaName = email.personaName || persona.name || `Persona ${i + 1}`;
    const personaDesignation = email.personaDesignation || persona.designation || '';
    const personaDepartment = email.personaDepartment || persona.department || '';
    const subject = email.subject || (persona.email && persona.email.subject) || '';
    const body = email.body || (persona.email && persona.email.body) || '';

    merged.push({
      personaName,
      personaDesignation,
      personaDepartment,
      subject,
      body,
    });
  }

  return merged;
}

function formatEmailDraftText(draft = {}) {
  const subject = typeof draft.subject === 'string' ? draft.subject.trim() : '';
  const body = typeof draft.body === 'string' ? draft.body.trim() : '';
  return [subject, body].filter(Boolean).join('\n\n');
}

function formatFallbackEmailText(email) {
  if (!email) return '';
  if (typeof email === 'string') return email;
  if (typeof email === 'object') {
    const subject = typeof email.subject === 'string' ? email.subject.trim() : '';
    const body = typeof email.body === 'string' ? email.body.trim() : '';
    return [subject, body].filter(Boolean).join('\n\n');
  }
  return '';
}

function updateCopyEmailButtonState(text = '') {
  if (!copyEmailBtn) return;
  const hasText = typeof text === 'string' && text.trim().length > 0;
  copyEmailBtn.disabled = !hasText;
}

function getActivePersonaName() {
  if (selectedPersonaIndex < 0) return '';
  const draft = personaEmailDrafts[selectedPersonaIndex];
  return draft && draft.personaName ? draft.personaName : '';
}

function activatePersonaTab(index) {
  if (!personaTabs || !personaEmailDrafts.length) return;
  const safeIndex = Math.max(0, Math.min(index, personaEmailDrafts.length - 1));
  selectedPersonaIndex = safeIndex;

  const buttons = personaTabs.querySelectorAll('.persona-tab');
  buttons.forEach((btn, btnIdx) => {
    const isActive = btnIdx === safeIndex;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.tabIndex = isActive ? 0 : -1;
  });

  const draft = personaEmailDrafts[safeIndex] || {};
  const text = formatEmailDraftText(draft);
  if (text) {
    emailOut.innerText = text;
    updateCopyEmailButtonState(text);
  } else {
    emailOut.innerText = 'No email available for this persona yet.';
    updateCopyEmailButtonState('');
  }
}

function renderPersonaEmailDrafts(personasData = [], personaEmailsData = [], fallbackEmail) {
  personaEmailDrafts = mergePersonaEmails(personasData, personaEmailsData);

  if (personaTabs) {
    personaTabs.innerHTML = '';
  }

  if (personaEmailDrafts.length && personaTabs) {
    personaTabs.style.display = '';

    personaEmailDrafts.forEach((draft, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'persona-tab';
      btn.dataset.index = String(idx);
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
      btn.tabIndex = idx === 0 ? 0 : -1;

      const labelBits = [];
      const name = draft.personaName && draft.personaName.trim() ? draft.personaName.trim() : `Persona ${idx + 1}`;
      labelBits.push(name);
      if (draft.personaDesignation) labelBits.push(draft.personaDesignation);

      btn.textContent = labelBits.join(' \u2013 ');
      personaTabs.appendChild(btn);
    });

    activatePersonaTab(0);
  } else {
    if (personaTabs) personaTabs.style.display = 'none';
    personaEmailDrafts = [];
    selectedPersonaIndex = -1;
    const fallbackText = formatFallbackEmailText(fallbackEmail);
    if (fallbackText) {
      emailOut.innerText = fallbackText;
      updateCopyEmailButtonState(fallbackText);
    } else {
      emailOut.innerText = 'No email generated yet.';
      updateCopyEmailButtonState('');
    }
  }
}

function renderResultView(data = {}) {
  if (!resultDiv || !briefDiv || !emailOut) return;

  resultDiv.style.display = 'block';
  briefDiv.innerHTML = data.brief_html || data.brief || '';

  const personasData = Array.isArray(data.personas) ? data.personas : [];
  clearAndRenderPersonas(personasData);

  const personaEmailsData = Array.isArray(data.personaEmails) ? data.personaEmails : [];
  renderPersonaEmailDrafts(personasData, personaEmailsData, data.email);

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
