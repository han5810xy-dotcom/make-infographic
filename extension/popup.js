(() => {
  const captureButton = document.getElementById('capture');
  const downloadButton = document.getElementById('download');
  const copyButton = document.getElementById('copy');
  const bridgeButton = document.getElementById('bridge');
  const status = document.getElementById('status');
  const meta = document.getElementById('meta');
  let tabId = null;
  let trace = null;

  const say = (message, bad = false) => {
    status.textContent = message;
    status.className = `status${bad ? ' bad' : ''}`;
  };

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    tabId = tab?.id;
    const url = tab?.url || '';
    if (!/^https?:\/\/([^/]+\.)?qwen\.ai\//.test(url)) {
      meta.textContent = '当前不是 Qwen 会话页；仍可尝试捕获，但建议打开 chat.qwen.ai。';
      captureButton.disabled = false;
      return;
    }
    meta.textContent = tab.title || url;
  });

  captureButton.addEventListener('click', () => {
    say('正在读取可见对话…');
    chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_QWEN' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        say(response?.error || chrome.runtime.lastError?.message || '捕获失败', true);
        return;
      }
      trace = response.trace;
      downloadButton.disabled = false;
      copyButton.disabled = false;
      bridgeButton.disabled = false;
      const thinking = trace.turns.filter((turn) => turn.thinking).length;
      say(`已捕获 ${trace.turns.length} 轮；其中 ${thinking} 轮含可见思考。`);
    });
  });

  downloadButton.addEventListener('click', () => {
    if (!trace) return;
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(trace, null, 2))}`;
    chrome.downloads.download({ url, filename: `${trace.id}.json`, saveAs: true });
  });

  copyButton.addEventListener('click', async () => {
    if (!trace) return;
    await navigator.clipboard.writeText(JSON.stringify(trace, null, 2));
    say('Trace JSON 已复制。');
  });

  bridgeButton.addEventListener('click', async () => {
    if (!trace) return;
    say('正在发送到本机 127.0.0.1:5278…');
    try {
      const response = await fetch('http://127.0.0.1:5278/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(trace),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '本机出图失败');
      say(`已出图：${result.artifacts?.png || result.artifacts?.html || result.trace_path}`);
    } catch (error) {
      say(`本机桥接失败：${error.message}。可先下载 Trace，再交给 Skill 或导入入口。`, true);
    }
  });
})();
