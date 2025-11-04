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
const exportTrigger = document.getElementById('exportTrigger');
const settingsTrigger = document.getElementById('settingsTrigger');
const modalRoot = document.getElementById('modalRoot');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalFooter = document.getElementById('modalFooter');
const modalClose = document.getElementById('modalClose');

const EXPORT_TEMPLATE_STORAGE_KEY = 'exportTemplate';
const EXPORT_PAGE_SIZE = 8;

let historyEntries = [];
let currentHistoryId = null;
let personaEmailDrafts = [];
let selectedPersonaIndex = -1;
let exportTemplate = { columns: [] };
let availableDateFields = [];
let defaultDateFieldPath = 'createdAt';
let activeModalCleanup = null;
let activeExportState = null;

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

function closeModal() {
  if (modalRoot?.classList.contains('hidden')) return;
  if (typeof activeModalCleanup === 'function') {
    try {
      activeModalCleanup();
    } catch (err) {
      console.warn('modal cleanup failed', err);
    }
  }
  activeModalCleanup = null;
  if (modalTitle) modalTitle.textContent = '';
  if (modalBody) modalBody.innerHTML = '';
  if (modalFooter) modalFooter.innerHTML = '';
  modalRoot?.classList.add('hidden');
  modalRoot?.setAttribute('aria-hidden', 'true');
}

function openModal({ title = '', render }) {
  if (!modalRoot) return;
  if (!modalRoot.classList.contains('hidden')) {
    closeModal();
  }
  if (modalTitle) modalTitle.textContent = title;
  if (modalBody) modalBody.innerHTML = '';
  if (modalFooter) modalFooter.innerHTML = '';
  modalRoot.classList.remove('hidden');
  modalRoot.setAttribute('aria-hidden', 'false');
  if (typeof render === 'function') {
    const cleanup = render({ body: modalBody, footer: modalFooter, close: closeModal });
    if (typeof cleanup === 'function') {
      activeModalCleanup = cleanup;
    }
  }
}

modalClose?.addEventListener('click', () => closeModal());
modalRoot?.addEventListener('click', (evt) => {
  if (!evt.target) return;
  if (evt.target === modalRoot || evt.target.classList.contains('modal-backdrop')) {
    closeModal();
  }
});

document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape' && !modalRoot?.classList.contains('hidden')) {
    closeModal();
  }
});

settingsTrigger?.addEventListener('click', () => {
  openModal({ title: 'Settings', render: renderSettingsModal });
});

exportTrigger?.addEventListener('click', async () => {
  await loadExportTemplateFromStorage();
  activeExportState = null;
  openModal({ title: 'Export Research', render: renderExportModal });
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

function sanitizeTemplateColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .map((col, idx) => {
      const header = col && col.header ? String(col.header).trim() : '';
      const description = col && col.description ? String(col.description).trim() : '';
      if (!header) return null;
      return {
        header,
        description: description || `Column ${idx + 1}`,
      };
    })
    .filter(Boolean);
}

function setupTemplateEditor(container, initialColumns = []) {
  if (!container) {
    return {
      getColumns: () => [],
    };
  }

  let columns = sanitizeTemplateColumns(initialColumns);

  const listEl = document.createElement('div');
  listEl.className = 'template-columns';

  const actionsEl = document.createElement('div');
  actionsEl.className = 'template-actions';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add column';
  actionsEl.appendChild(addBtn);

  function render() {
    listEl.innerHTML = '';
    if (!columns.length) {
      const empty = document.createElement('div');
      empty.className = 'template-empty';
      empty.textContent = 'No columns configured yet. Add one to start.';
      listEl.appendChild(empty);
      return;
    }

    columns.forEach((col, idx) => {
      const row = document.createElement('div');
      row.className = 'template-column-row';

      const headerInput = document.createElement('input');
      headerInput.placeholder = 'Column header';
      headerInput.value = col.header || '';
      headerInput.addEventListener('input', (evt) => {
        columns[idx].header = evt.target.value;
      });
      row.appendChild(headerInput);

      const descInput = document.createElement('input');
      descInput.placeholder = 'Description';
      descInput.value = col.description || '';
      descInput.addEventListener('input', (evt) => {
        columns[idx].description = evt.target.value;
      });
      row.appendChild(descInput);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        columns.splice(idx, 1);
        render();
      });
      row.appendChild(removeBtn);

      listEl.appendChild(row);
    });
  }

  addBtn.addEventListener('click', () => {
    columns.push({ header: '', description: '' });
    render();
  });

  container.appendChild(listEl);
  container.appendChild(actionsEl);
  render();

  return {
    getColumns: () => sanitizeTemplateColumns(columns),
    setColumns: (cols) => {
      columns = sanitizeTemplateColumns(cols);
      render();
    },
  };
}

function formatFieldLabel(path) {
  return path
    .split('.')
    .map((part) => part.replace(/\b\w/g, (char) => char.toUpperCase()).replace(/_/g, ' '))
    .join(' > ');
}

function discoverDateFields(entries) {
  const candidates = new Map();

  const walk = (value, path) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      const ts = Date.parse(value);
      if (!Number.isNaN(ts)) {
        const existing = candidates.get(path) || { path, count: 0 };
        existing.count += 1;
        candidates.set(path, existing);
      }
      return;
    }
    if (typeof value !== 'object' || Array.isArray(value)) return;
    Object.keys(value).forEach((key) => {
      const nextPath = path ? `${path}.${key}` : key;
      walk(value[key], nextPath);
    });
  };

  entries.forEach((entry) => walk(entry, ''));

  const results = Array.from(candidates.values()).map((item) => ({
    path: item.path,
    label: `${formatFieldLabel(item.path)} (${item.path})`,
    count: item.count,
  }));

  results.sort((a, b) => {
    if (a.path === 'createdAt') return -1;
    if (b.path === 'createdAt') return 1;
    return b.count - a.count;
  });

  return results;
}

function paginate(array, page = 1, pageSize = 10) {
  const start = (page - 1) * pageSize;
  return array.slice(start, start + pageSize);
}

async function loadExportTemplateFromStorage() {
  try {
    const data = await chrome.storage.local.get([EXPORT_TEMPLATE_STORAGE_KEY]);
    const template = data && data[EXPORT_TEMPLATE_STORAGE_KEY];
    if (template && Array.isArray(template.columns)) {
      exportTemplate = { columns: sanitizeTemplateColumns(template.columns) };
    } else {
      exportTemplate = { columns: [] };
    }
  } catch (err) {
    console.warn('Failed to load export template', err);
    exportTemplate = { columns: [] };
  }
}

async function persistExportTemplate(template) {
  const columns = sanitizeTemplateColumns(template?.columns || []);
  exportTemplate = { columns };
  await chrome.storage.local.set({ [EXPORT_TEMPLATE_STORAGE_KEY]: exportTemplate });
  return exportTemplate;
}

function base64ToBlob(base64, mimeType) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function triggerDownload(downloadInfo) {
  if (!downloadInfo || !downloadInfo.base64) return;
  try {
    const blob = base64ToBlob(downloadInfo.base64, downloadInfo.mimeType || 'application/octet-stream');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadInfo.filename || 'export';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      document.body.removeChild(anchor);
    }, 200);
  } catch (err) {
    console.error('Download failed', err);
    if (status) status.innerText = 'Unable to start download.';
  }
}

function renderSettingsModal({ body, footer, close }) {
  if (!body || !footer) return;

  const form = document.createElement('form');
  form.id = 'settingsForm';
  form.noValidate = true;

  const errorEl = document.createElement('div');
  errorEl.className = 'modal-error';
  errorEl.style.display = 'none';
  form.appendChild(errorEl);

  const apiSection = document.createElement('div');
  apiSection.className = 'modal-section';
  const apiHeader = document.createElement('h4');
  apiHeader.textContent = 'Add API key';
  apiSection.appendChild(apiHeader);
  const apiHelper = document.createElement('p');
  apiHelper.className = 'modal-helper';
  apiHelper.textContent = 'Provide your Gemini API key. This is required for AI powered exports and brief generation.';
  apiSection.appendChild(apiHelper);
  const apiInputField = document.createElement('input');
  apiInputField.type = 'text';
  apiInputField.placeholder = 'Gemini API key';
  apiInputField.value = apiKeyInput?.value?.trim() || '';
  apiSection.appendChild(apiInputField);
  form.appendChild(apiSection);

  const templateSection = document.createElement('div');
  templateSection.className = 'modal-section';
  const templateHeader = document.createElement('h4');
  templateHeader.textContent = 'Add export options';
  templateSection.appendChild(templateHeader);
  const templateHelper = document.createElement('p');
  templateHelper.className = 'modal-helper';
  templateHelper.textContent = 'Optional: Add the column headers and descriptions that the export should follow.';
  templateSection.appendChild(templateHelper);
  const templateHost = document.createElement('div');
  templateSection.appendChild(templateHost);
  const templateEditor = setupTemplateEditor(templateHost, exportTemplate.columns || []);
  form.appendChild(templateSection);

  body.appendChild(form);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => close());

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Save';
  saveBtn.classList.add('primary');
  saveBtn.setAttribute('form', form.id);

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  const onSubmit = async (evt) => {
    evt.preventDefault();
    errorEl.style.display = 'none';
    errorEl.textContent = '';

    const key = apiInputField.value.trim();
    const columns = templateEditor.getColumns();

    try {
      if (key) {
        await chrome.storage.local.set({ geminiKey: key });
      } else {
        await chrome.storage.local.remove('geminiKey');
      }
      await persistExportTemplate({ columns });
      if (apiKeyInput) apiKeyInput.value = key;
      if (status) status.innerText = 'Settings saved.';
      close();
    } catch (err) {
      errorEl.textContent = err?.message || 'Failed to save settings.';
      errorEl.style.display = 'block';
    }
  };

  form.addEventListener('submit', onSubmit);

  return () => {
    form.removeEventListener('submit', onSubmit);
  };
}

function renderTemplateSetupModal({ body, footer, close }) {
  if (!body || !footer) return;

  const container = document.createElement('div');
  container.className = 'modal-section';

  const heading = document.createElement('h4');
  heading.textContent = 'Define an export template';
  container.appendChild(heading);

  const helper = document.createElement('p');
  helper.className = 'modal-helper';
  helper.textContent = 'Add the column headers and descriptions that the export should follow. You can edit these later from Settings.';
  container.appendChild(helper);

  const templateHost = document.createElement('div');
  container.appendChild(templateHost);

  body.appendChild(container);

  const templateEditor = setupTemplateEditor(templateHost, exportTemplate.columns || []);

  const errorEl = document.createElement('div');
  errorEl.className = 'modal-error';
  errorEl.style.display = 'none';
  body.insertBefore(errorEl, container);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => close && close());

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save template';
  saveBtn.classList.add('primary');
  saveBtn.addEventListener('click', async () => {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    const columns = templateEditor.getColumns();
    if (!columns.length) {
      errorEl.textContent = 'Add at least one column to continue.';
      errorEl.style.display = 'block';
      return;
    }
    try {
      await persistExportTemplate({ columns });
      if (status) status.innerText = 'Export template saved.';
      openModal({ title: 'Export Research', render: renderExportModal });
    } catch (err) {
      errorEl.textContent = err?.message || 'Failed to save template.';
      errorEl.style.display = 'block';
    }
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
}

function renderExportFlowModal({ body, footer, close }) {
  if (!body || !footer) return;

  if (!historyEntries.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'modal-helper';
    emptyMessage.textContent = 'No research history available. Generate a brief first to create exportable data.';
    body.appendChild(emptyMessage);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => close());
    footer.appendChild(closeBtn);
    return;
  }

  const initialState = {
    selectionType: 'all',
    dateFieldPath: defaultDateFieldPath,
    dateFrom: '',
    dateTo: '',
    customSearch: '',
    customPage: 1,
    selectedIds: new Set(),
    format: 'xlsx',
    inProgress: false,
    result: null,
    error: '',
  };

  if (!activeExportState) {
    activeExportState = initialState;
  } else {
    activeExportState = {
      ...initialState,
      ...activeExportState,
      selectedIds: activeExportState.selectedIds instanceof Set ? activeExportState.selectedIds : new Set(activeExportState.selectedIds || []),
    };
  }

  const state = activeExportState;
  if (!availableDateFields.length) {
    state.selectionType = state.selectionType === 'date' ? 'all' : state.selectionType;
  }
  if (!availableDateFields.find((field) => field.path === state.dateFieldPath)) {
    state.dateFieldPath = availableDateFields[0]?.path || 'createdAt';
  }

  body.innerHTML = '';
  footer.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'export-options';
  body.appendChild(container);

  const rangeFieldset = document.createElement('fieldset');
  const rangeLegend = document.createElement('legend');
  rangeLegend.textContent = 'Select range';
  rangeFieldset.appendChild(rangeLegend);
  const radioGroup = document.createElement('div');
  radioGroup.className = 'range-radios';
  rangeFieldset.appendChild(radioGroup);

  const rangeOptions = [
    { value: 'all', label: 'All history', disabled: false },
    { value: 'date', label: 'Date range', disabled: !availableDateFields.length },
    { value: 'custom', label: 'Custom selection', disabled: false },
  ];

  rangeOptions.forEach((option) => {
    const radioLabel = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'exportRange';
    radio.value = option.value;
    radio.checked = state.selectionType === option.value;
    radio.disabled = option.disabled;
    radio.addEventListener('change', () => {
      state.selectionType = option.value;
      refreshVisibility();
      refreshFooterButtons();
      if (option.value === 'custom') {
        renderCustomList();
      }
    });
    radioLabel.appendChild(radio);
    radioLabel.appendChild(document.createTextNode(option.label));
    radioGroup.appendChild(radioLabel);
  });

  container.appendChild(rangeFieldset);

  const dateContainer = document.createElement('div');
  dateContainer.className = 'date-range-inputs';

  if (availableDateFields.length) {
    const dateFieldWrapper = document.createElement('label');
    dateFieldWrapper.textContent = 'Date field';
    const dateSelect = document.createElement('select');
    availableDateFields.forEach((field) => {
      const option = document.createElement('option');
      option.value = field.path;
      option.textContent = field.label;
      dateSelect.appendChild(option);
    });
    dateSelect.value = state.dateFieldPath;
    dateSelect.addEventListener('change', (evt) => {
      state.dateFieldPath = evt.target.value;
    });
    dateFieldWrapper.appendChild(dateSelect);
    dateContainer.appendChild(dateFieldWrapper);
  }

  const fromWrapper = document.createElement('label');
  fromWrapper.textContent = 'From';
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.value = state.dateFrom || '';
  fromInput.addEventListener('change', (evt) => {
    state.dateFrom = evt.target.value;
  });
  fromWrapper.appendChild(fromInput);
  dateContainer.appendChild(fromWrapper);

  const toWrapper = document.createElement('label');
  toWrapper.textContent = 'To';
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.value = state.dateTo || '';
  toInput.addEventListener('change', (evt) => {
    state.dateTo = evt.target.value;
  });
  toWrapper.appendChild(toInput);
  dateContainer.appendChild(toWrapper);

  container.appendChild(dateContainer);

  const customContainer = document.createElement('div');
  customContainer.className = 'custom-selection';

  const searchRow = document.createElement('div');
  searchRow.className = 'search-row';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search company, product, location, or date';
  searchInput.value = state.customSearch || '';
  searchInput.addEventListener('input', (evt) => {
    state.customSearch = evt.target.value;
    state.customPage = 1;
    renderCustomList();
  });
  searchRow.appendChild(searchInput);

  const clearSearchBtn = document.createElement('button');
  clearSearchBtn.type = 'button';
  clearSearchBtn.textContent = 'Clear';
  clearSearchBtn.addEventListener('click', () => {
    state.customSearch = '';
    state.customPage = 1;
    searchInput.value = '';
    renderCustomList();
  });
  searchRow.appendChild(clearSearchBtn);

  customContainer.appendChild(searchRow);

  const listEl = document.createElement('div');
  listEl.className = 'custom-results';
  customContainer.appendChild(listEl);

  const paginationEl = document.createElement('div');
  paginationEl.className = 'pagination-controls';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.textContent = 'Prev';
  prevBtn.addEventListener('click', () => {
    if (state.customPage > 1) {
      state.customPage -= 1;
      renderCustomList();
    }
  });
  const pageInfo = document.createElement('span');
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.textContent = 'Next';
  nextBtn.addEventListener('click', () => {
    state.customPage += 1;
    renderCustomList();
  });
  paginationEl.appendChild(prevBtn);
  paginationEl.appendChild(pageInfo);
  paginationEl.appendChild(nextBtn);
  customContainer.appendChild(paginationEl);

  const customSummary = document.createElement('div');
  customSummary.className = 'export-status';
  customContainer.appendChild(customSummary);

  container.appendChild(customContainer);

  const formatFieldset = document.createElement('fieldset');
  const formatLegend = document.createElement('legend');
  formatLegend.textContent = 'Export format';
  formatFieldset.appendChild(formatLegend);
  const formatRadios = document.createElement('div');
  formatRadios.className = 'range-radios';
  formatFieldset.appendChild(formatRadios);

  [
    { value: 'xlsx', label: 'Excel (.xlsx)' },
    { value: 'md', label: 'Markdown (.md)' },
  ].forEach((option) => {
    const radioLabel = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'exportFormat';
    radio.value = option.value;
    radio.checked = state.format === option.value;
    radio.addEventListener('change', () => {
      state.format = option.value;
      refreshFooterButtons();
    });
    radioLabel.appendChild(radio);
    radioLabel.appendChild(document.createTextNode(option.label));
    formatRadios.appendChild(radioLabel);
  });

  container.appendChild(formatFieldset);

  const statusEl = document.createElement('div');
  statusEl.className = 'export-status';
  container.appendChild(statusEl);

  const notesEl = document.createElement('div');
  notesEl.className = 'notes-box';
  notesEl.style.display = 'none';
  container.appendChild(notesEl);

  const previewWrapper = document.createElement('div');
  container.appendChild(previewWrapper);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Close';
  cancelBtn.addEventListener('click', () => close());
  footer.appendChild(cancelBtn);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.classList.add('primary');
  footer.appendChild(exportBtn);

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.textContent = 'Download';
  downloadBtn.disabled = !state.result;
  downloadBtn.addEventListener('click', () => {
    if (state.result?.download) {
      triggerDownload(state.result.download);
    }
  });
  footer.appendChild(downloadBtn);

  function canRunExport() {
    if (!historyEntries.length) return false;
    if (!exportTemplate.columns || !exportTemplate.columns.length) return false;
    if (state.selectionType === 'custom' && state.selectedIds.size === 0) return false;
    return true;
  }

  function refreshFooterButtons() {
    exportBtn.textContent = state.inProgress ? 'Processing...' : state.result ? 'Run again' : 'Start export';
    exportBtn.disabled = state.inProgress || !canRunExport();
    downloadBtn.disabled = !state.result;
    const downloadLabel = (state.result?.format || state.format) === 'md' ? 'Download Markdown' : 'Download Excel';
    downloadBtn.textContent = downloadLabel;
  }

  function refreshVisibility() {
    dateContainer.style.display = state.selectionType === 'date' ? 'grid' : 'none';
    customContainer.style.display = state.selectionType === 'custom' ? 'flex' : 'none';
  }

  function formatCustomCandidates() {
    const term = state.customSearch.trim().toLowerCase();
    return historyEntries.map((entry) => {
      const title = entry?.request?.company || 'Untitled brief';
      const subtitle = [entry?.request?.product, entry?.request?.location].filter(Boolean).join(' - ');
      const meta = formatHistoryTimestamp(entry.createdAt) || '';
      const haystack = `${title} ${subtitle} ${meta}`.toLowerCase();
      const matches = !term || haystack.includes(term);
      return matches ? { id: entry.id, title, subtitle, meta } : null;
    }).filter(Boolean);
  }

  function renderCustomList() {
    listEl.innerHTML = '';
    const candidates = formatCustomCandidates();
    const total = candidates.length;
    const totalPages = Math.max(1, Math.ceil(total / EXPORT_PAGE_SIZE));
    if (state.customPage > totalPages) state.customPage = totalPages;
    if (state.customPage < 1) state.customPage = 1;
    const pageItems = paginate(candidates, state.customPage, EXPORT_PAGE_SIZE);

    if (!pageItems.length) {
      const empty = document.createElement('div');
      empty.className = 'template-empty';
      empty.textContent = 'No matches. Adjust the search or try another page.';
      listEl.appendChild(empty);
    } else {
      pageItems.forEach((item) => {
        const wrapper = document.createElement('label');
        wrapper.className = 'custom-result-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.selectedIds.has(item.id);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            state.selectedIds.add(item.id);
          } else {
            state.selectedIds.delete(item.id);
          }
          refreshSummary();
          refreshFooterButtons();
        });
        wrapper.appendChild(checkbox);

        const metaWrapper = document.createElement('div');
        metaWrapper.className = 'custom-result-meta';
        const titleEl = document.createElement('strong');
        titleEl.textContent = item.title;
        metaWrapper.appendChild(titleEl);
        if (item.subtitle) {
          const subtitleEl = document.createElement('span');
          subtitleEl.textContent = item.subtitle;
          metaWrapper.appendChild(subtitleEl);
        }
        if (item.meta) {
          const metaEl = document.createElement('span');
          metaEl.textContent = item.meta;
          metaWrapper.appendChild(metaEl);
        }
        wrapper.appendChild(metaWrapper);
        listEl.appendChild(wrapper);
      });
    }

    prevBtn.disabled = state.customPage <= 1;
    nextBtn.disabled = state.customPage >= totalPages;
    pageInfo.textContent = `Page ${totalPages ? state.customPage : 0} of ${totalPages}`;
    refreshSummary(total);
  }

  function refreshSummary(totalMatches = formatCustomCandidates().length) {
    const selectedCount = state.selectedIds.size;
    const selectionText = selectedCount === 1 ? '1 item selected' : `${selectedCount} items selected`;
    const matchText = state.selectionType === 'custom' ? ` | ${totalMatches} matches` : '';
    customSummary.textContent = `Custom selection${matchText ? matchText : ''}. ${selectionText}.`;
  }

  function setStatus(message, { type = 'info', loading = false } = {}) {
    statusEl.innerHTML = '';
    if (!message) return;
    if (loading) {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      statusEl.appendChild(spinner);
      const text = document.createElement('span');
      text.style.marginLeft = '8px';
      text.textContent = message;
      statusEl.appendChild(text);
    } else {
      statusEl.textContent = message;
    }
    statusEl.style.color = type === 'error' ? '#b91c1c' : '#374151';
  }

  function renderPreview() {
    previewWrapper.innerHTML = '';
    notesEl.style.display = 'none';
    if (!state.result?.preview) return;

    const { headers = [], rows = [] } = state.result.preview;
    const totalRows = state.result.totalRows || rows.length;

    const caption = document.createElement('div');
    caption.className = 'modal-helper';
    caption.textContent = `Showing first ${Math.min(rows.length, 10)} of ${totalRows} rows.`;
    previewWrapper.appendChild(caption);

    const table = document.createElement('table');
    table.className = 'preview-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headers.forEach((header) => {
      const th = document.createElement('th');
      th.textContent = header;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      headers.forEach((header) => {
        const td = document.createElement('td');
        td.textContent = row[header] || '';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    previewWrapper.appendChild(table);

    if (state.result.notes) {
      notesEl.textContent = state.result.notes;
      notesEl.style.display = 'block';
    }
  }

  async function runExport() {
    state.inProgress = true;
    state.error = '';
    setStatus('Formatting export...', { loading: true });
    refreshFooterButtons();
    notesEl.style.display = 'none';
    previewWrapper.innerHTML = '';

    const selectionPayload = (() => {
      if (state.selectionType === 'custom') {
        return { type: 'custom', selectedIds: Array.from(state.selectedIds) };
      }
      if (state.selectionType === 'date') {
        return {
          type: 'date',
          dateFieldPath: state.dateFieldPath,
          from: state.dateFrom || null,
          to: state.dateTo || null,
        };
      }
      return { type: 'all' };
    })();

    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: 'exportResearch',
          selection: selectionPayload,
          format: state.format,
          template: exportTemplate,
        },
        (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ error: err.message || 'Export failed.' });
            return;
          }
          resolve(resp);
        }
      );
    });

    state.inProgress = false;

    if (!response || response.error) {
      state.error = response?.error || 'Export failed.';
      state.result = null;
      setStatus(`Error: ${state.error}`, { type: 'error' });
      refreshFooterButtons();
      return;
    }

    state.result = {
      preview: response.preview,
      download: response.download,
      notes: response.notes,
      totalRows: response.totalRows,
      format: response.download?.format || state.format,
    };
    state.error = '';

    setStatus('Export ready. Review the preview and download the file when ready.', { type: 'info' });
    renderPreview();
    refreshFooterButtons();
  }

  exportBtn.addEventListener('click', () => {
    if (state.inProgress || !canRunExport()) return;
    runExport();
  });

  refreshVisibility();
  renderCustomList();
  refreshFooterButtons();
  if (state.result) {
    renderPreview();
    setStatus('Previous export preview is available below.', { type: 'info' });
  }

  return () => {
    state.inProgress = false;
  };
}

function renderExportModal(context) {
  if (!exportTemplate.columns || !exportTemplate.columns.length) {
    renderTemplateSetupModal(context);
  } else {
    renderExportFlowModal(context);
  }
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

    const subtitleText = [entry?.request?.product, entry?.request?.location].filter(Boolean).join(' - ');
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
    availableDateFields = discoverDateFields(entries);
    defaultDateFieldPath = availableDateFields[0]?.path || 'createdAt';
    if (activeExportState) {
      if (!availableDateFields.find((field) => field.path === activeExportState.dateFieldPath)) {
        activeExportState.dateFieldPath = defaultDateFieldPath;
      }
    }
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
  await loadExportTemplateFromStorage();
})();
