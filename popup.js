chrome.storage.sync.get(['slopMode'], (result) => {
  const mode = result.slopMode || 'text';
  document.querySelector(`input[value="${mode}"]`).checked = true;
});

document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener('change', (e) => {
    chrome.storage.sync.set({ slopMode: e.target.value }, () => {
      
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        chrome.tabs.reload(tabs[0].id);
      });
    });
  });
});