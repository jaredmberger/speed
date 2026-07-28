const form = document.querySelector('#scan-form');
const statusBox = document.querySelector('#status');
const summary = document.querySelector('#summary');
const findings = document.querySelector('#findings');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = new FormData(form).get('url');
  setStatus('Analyzing the page…');
  summary.hidden = true;
  findings.hidden = true;

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The scan could not be completed.');
    renderSummary(data);
    renderFindings(data);
    setStatus(`Finished analyzing ${data.page.title || data.page.finalUrl}.`, 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
});

function renderSummary(data) {
  const metrics = data.metrics || {};
  const cards = [
    [formatDuration(metrics.responseTimeMs), 'HTML response'],
    [formatBytes(metrics.htmlBytes), 'HTML size'],
    [metrics.imageCount || 0, 'Images'],
    [metrics.scriptCount || 0, 'Scripts'],
    [metrics.stylesheetCount || 0, 'Stylesheets'],
    [data.findings?.length || 0, 'Recommendations']
  ];
  summary.innerHTML = cards.map(([value, label]) => `<article><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`).join('');
  summary.hidden = false;
}

function renderFindings(data) {
  const items = data.findings || [];
  findings.innerHTML = `
    <div class="section-head">
      <div><span class="eyebrow">Performance briefing</span><h2>${items.length ? `${items.length} recommendation${items.length === 1 ? '' : 's'}` : 'No major recommendations'}</h2></div>
      <button type="button" id="export-json">Export for CuratorOS</button>
    </div>
    <div class="finding-list">
      ${items.length ? items.map(renderFinding).join('') : '<article class="finding low"><h3>This page passed the current MVP checks.</h3><p>Future versions will add resource-size measurement, page-type baselines, and cross-page comparisons.</p></article>'}
    </div>`;
  findings.hidden = false;
  document.querySelector('#export-json')?.addEventListener('click', () => downloadJson(data));
}

function renderFinding(item) {
  return `<article class="finding ${escapeHtml(item.severity)}">
    <div class="finding-head"><span>${escapeHtml(label(item.category))}</span><strong>${escapeHtml(item.severity)}</strong></div>
    <h3>${escapeHtml(item.title)}</h3>
    <p>${escapeHtml(item.summary)}</p>
    <p><b>Recommendation:</b> ${escapeHtml(item.recommendation)}</p>
    ${item.estimatedImpact ? `<small>${escapeHtml(item.estimatedImpact)}</small>` : ''}
  </article>`;
}

function setStatus(message, kind = '') {
  statusBox.textContent = message;
  statusBox.className = `status ${kind}`.trim();
  statusBox.hidden = false;
}

function downloadJson(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `curator-speed-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function formatDuration(value) {
  return `${Number(value || 0).toLocaleString()} ms`;
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (number < 1024) return `${number} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`;
  return `${(number / 1024 / 1024).toFixed(2)} MB`;
}

function label(value) {
  return String(value || 'finding').replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
