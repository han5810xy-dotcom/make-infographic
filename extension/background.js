chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ bridgeUrl: 'http://127.0.0.1:5278' });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'SAVE_TRACE') return false;
  chrome.storage.local.set({ lastTrace: message.trace }, () => sendResponse({ ok: !chrome.runtime.lastError }));
  return true;
});
