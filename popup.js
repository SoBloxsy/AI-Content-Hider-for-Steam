chrome.storage.sync.get(['filterMode'], (result) => {
  const mode = result.filterMode || 'text';
  document.querySelector(`input[value="${mode}"]`).checked = true;
});

document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener('change', (e) => {
    chrome.storage.sync.set({ filterMode: e.target.value }, () => {
      
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        chrome.tabs.reload(tabs[0].id);
      });
    });
  });
});

document.getElementById('clear-cache')?.addEventListener('click', (e) => {
  chrome.storage.local.get(null, (items) => {
    const keys = Object.keys(items).filter((key) => key.startsWith('slop_cache_'));
    chrome.storage.local.remove(keys, () => {
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