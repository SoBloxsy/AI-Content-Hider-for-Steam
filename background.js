let statsCache = { totalChecked: 0, totalFlagged: 0 };
let isStatsLoaded = false;
let statsCommitTimer = null;

chrome.storage.local.get(['stats'], (result) => {
  if (result?.stats) {
    statsCache = result.stats;
  }
  isStatsLoaded = true;
});

const persistStats = () => {
  chrome.storage.local.set({ stats: statsCache });
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
    statsCache.totalChecked += message.checked || 0;
    statsCache.totalFlagged += message.flagged || 0;

    if (!statsCommitTimer) {
      statsCommitTimer = setTimeout(() => {
        statsCommitTimer = null;
        persistStats();
      }, 1000);
    }
  }

  if (message.type === 'getStats') {
    if (statsCommitTimer) {
      clearTimeout(statsCommitTimer);
      statsCommitTimer = null;
      persistStats();
    }
    if (!isStatsLoaded) {
      chrome.storage.local.get(['stats'], (result) => {
        if (result?.stats) {
          statsCache = result.stats;
        }
        isStatsLoaded = true;
        sendResponse(statsCache);
      });
      return true;
    }
    sendResponse(statsCache);
  }

  if (message.type === 'resetStats') {
    if (statsCommitTimer) {
      clearTimeout(statsCommitTimer);
      statsCommitTimer = null;
    }
    statsCache = { totalChecked: 0, totalFlagged: 0 };
    chrome.storage.local.set({ stats: statsCache }, () => {
      sendResponse(!chrome.runtime.lastError);
    });
    return true;
  }
});
