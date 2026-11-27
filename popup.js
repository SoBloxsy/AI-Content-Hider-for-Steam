// -- Mode selection & Settings --

const settingKeys = [
  'filterMode',
  'ignoreLocalization',
  'ignoreCode',
  'ignoreConceptArt',
  'ignoreMarketing',
  'ignoreEarlyAccess',
  'ignorePreRelease',
];

chrome.storage.sync.get(settingKeys, (result) => {
  if (chrome.runtime.lastError) return;
  const mode = result.filterMode || 'text';
  const radio = document.querySelector(`input[value="${mode}"]`);
  if (radio) radio.checked = true;

  const checkboxMap = {
    'ignore-localization': 'ignoreLocalization',
    'ignore-code': 'ignoreCode',
    'ignore-concept-art': 'ignoreConceptArt',
    'ignore-marketing': 'ignoreMarketing',
    'ignore-early-access': 'ignoreEarlyAccess',
    'ignore-pre-release': 'ignorePreRelease',
  };

  for (const [elementId, key] of Object.entries(checkboxMap)) {
    const el = document.getElementById(elementId);
    if (el) {
      el.checked = Boolean(result[key]);
    }
  }
});

document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener('change', (e) => {
    chrome.storage.sync.set({ filterMode: e.target.value });
  });
});

const bindCheckbox = (elementId, storageKey) => {
  document.getElementById(elementId)?.addEventListener('change', (e) => {
    chrome.storage.sync.set({ [storageKey]: e.target.checked });
  });
};

bindCheckbox('ignore-localization', 'ignoreLocalization');
bindCheckbox('ignore-code', 'ignoreCode');
bindCheckbox('ignore-concept-art', 'ignoreConceptArt');
bindCheckbox('ignore-marketing', 'ignoreMarketing');
bindCheckbox('ignore-early-access', 'ignoreEarlyAccess');
bindCheckbox('ignore-pre-release', 'ignorePreRelease');

// -- Clear cache --

document.getElementById('clear-cache')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.storage.local.get(null, (items) => {
    if (chrome.runtime.lastError) return;
    const keys = Object.keys(items).filter((key) => key.startsWith('slop_cache_'));
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) return;
      const btn = e.target;
      const originalText = btn.innerText;
      btn.innerText = 'Cleared!';
      setTimeout(() => {
        btn.innerText = originalText;
      }, 1000);
    });
  });
});

// -- Statistics --

const loadStats = () => {
  chrome.runtime.sendMessage({ type: 'getStats' }, (stats) => {
    if (chrome.runtime.lastError || !stats) return;
    const checkedEl = document.getElementById('stat-checked');
    const flaggedEl = document.getElementById('stat-flagged');
    if (checkedEl) checkedEl.textContent = stats.totalChecked.toLocaleString();
    if (flaggedEl) flaggedEl.textContent = stats.totalFlagged.toLocaleString();
  });
};

loadStats();

document.getElementById('reset-stats')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: 'resetStats' }, () => {
    if (chrome.runtime.lastError) return;
    loadStats();
  });
});

// -- External Links safe handler --
document.querySelectorAll('a[target="_blank"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    if (a.href && !a.href.startsWith('javascript:')) {
      chrome.tabs.create({ url: a.href });
    }
  });
});
