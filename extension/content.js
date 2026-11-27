(() => {
  const capture = () => globalThis.TraceCore.captureQwen(document, window.location, { attachments: [] });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'CAPTURE_QWEN') return false;
    try {
      const trace = capture();
      const errors = globalThis.TraceCore.validateTrace(trace);
      if (errors.length) throw new Error(errors.join('；'));
      chrome.storage.local.set({ lastTrace: trace }, () => sendResponse({ ok: true, trace }));
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || '捕获失败' });
    }
    return true;
  });

  globalThis.QwenTraceCapture = { capture };
})();
