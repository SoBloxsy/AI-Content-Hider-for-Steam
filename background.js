
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'updateBadge') {
    const tabId = sender.tab?.id;
    if (tabId) {
      const count = message.count;
      chrome.action.setBadgeText({
        text: count > 0 ? String(count) : '',
        tabId: tabId,
      });
      chrome.action.setBadgeBackgroundColor({
        color: '#a30100',
        tabId: tabId,
      });
    }
  }

  if (message.type === 'incrementStats') {
    chrome.storage.local.get(['stats'], (result) => {
      if (chrome.runtime.lastError) return;
      const stats = result.stats || { totalFlagged: 0, totalChecked: 0 };
      stats.totalChecked += message.checked || 0;
      stats.totalFlagged += message.flagged || 0;
      chrome.storage.local.set({ stats });
    });
  }

  if (message.type === 'getStats') {
    chrome.storage.local.get(['stats'], (result) => {
      if (chrome.runtime.lastError) {
        sendResponse({ totalFlagged: 0, totalChecked: 0 });
        return;
      }
      sendResponse(result.stats || { totalFlagged: 0, totalChecked: 0 });
    });
    return true; // keep channel open for async sendResponse
  }

  if (message.type === 'resetStats') {
    chrome.storage.local.set({ stats: { totalFlagged: 0, totalChecked: 0 } }, () => {
      if (chrome.runtime.lastError) {
        sendResponse(false);
        return;
      }
      sendResponse(true);
    });
    return true;
  }
});
