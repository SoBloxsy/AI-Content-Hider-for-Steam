let pendingChecked = 0;
let pendingFlagged = 0;
let statsCommitTimer = null;

const commitStats = () => {
  if (pendingChecked === 0 && pendingFlagged === 0) return;
  const incChecked = pendingChecked;
  const incFlagged = pendingFlagged;
  pendingChecked = 0;
  pendingFlagged = 0;

  chrome.storage.local.get(['stats'], (result) => {
    if (chrome.runtime.lastError) return;
    const stats = result.stats || { totalFlagged: 0, totalChecked: 0 };
    stats.totalChecked += incChecked;
    stats.totalFlagged += incFlagged;
    chrome.storage.local.set({ stats });
  });
};

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
    pendingChecked += message.checked || 0;
    pendingFlagged += message.flagged || 0;

    if (!statsCommitTimer) {
      statsCommitTimer = setTimeout(() => {
        statsCommitTimer = null;
        commitStats();
      }, 1000);
    }
  }

  if (message.type === 'getStats') {
    commitStats();
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
    pendingChecked = 0;
    pendingFlagged = 0;
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
