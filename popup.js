// -- Mode selection --

chrome.storage.sync.get(['filterMode'], (result) => {
  if (chrome.runtime.lastError) return;
  const mode = result.filterMode || 'text';
  const radio = document.querySelector(`input[value="${mode}"]`);
  if (radio) radio.checked = true;
});

document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener('change', (e) => {
    chrome.storage.sync.set({ filterMode: e.target.value }, () => {
      if (chrome.runtime.lastError) return;
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (tabs[0]) chrome.tabs.reload(tabs[0].id);
      });
    });
  });
});

// -- Clear cache --

document.getElementById('clear-cache')?.addEventListener('click', (e) => {
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

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) chrome.tabs.reload(tabs[0].id);
      });
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

// -- Promo banner --

chrome.storage.local.get(['promoDismissed'], (result) => {
  if (chrome.runtime.lastError) return;
  if (!result.promoDismissed) {
    const banner = document.getElementById('promo-banner');
    if (banner) banner.style.display = 'block';
  }
});

document.getElementById('promo-dismiss')?.addEventListener('click', () => {
  chrome.storage.local.set({ promoDismissed: true });
  const banner = document.getElementById('promo-banner');
  if (banner) banner.style.display = 'none';
});