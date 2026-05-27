'use strict';

function renderCount() {
  chrome.storage.local.get('tracked_jobs', (res) => {
    const jobs = (res && res.tracked_jobs) || {};
    document.getElementById('count').textContent = String(Object.keys(jobs).length);
  });
}

document.getElementById('open-dashboard').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tracked_jobs) renderCount();
});

renderCount();
