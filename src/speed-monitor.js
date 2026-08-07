const SITE_ORIGIN = 'https://oceanliners.net';
const SITEMAP_URL = `${SITE_ORIGIN}/sitemap.xml`;
const STATE_KEY = 'monitor:state';
const SNAPSHOT_KEY = 'snapshot:latest';
const PAGE_PREFIX = 'page:';
const BATCH_SIZE = 12;
const MATERIAL_MS = 200;
const MATERIAL_PCT = 30;

export async function runSpeedMonitor(env, analyzePage) {
  if (!env.CURATOR_SPEED_RECORDS) throw new Error('CURATOR_SPEED_RECORDS KV binding is not configured.');
  const urls = await discoverPages();
  if (!urls.length) throw new Error('No site pages were discovered from sitemap.xml.');

  const state = (await env.CURATOR_SPEED_RECORDS.get(STATE_KEY, 'json')) || { cursor: 0, cycle: 1 };
  let cursor = Number(state.cursor || 0);
  if (cursor >= urls.length) cursor = 0;
  const batch = [];
  for (let i = 0; i < Math.min(BATCH_SIZE, urls.length); i++) batch.push(urls[(cursor + i) % urls.length]);

  const results = [];
  const changes = [];
  for (const url of batch) {
    const path = toPath(url);
    const previous = await env.CURATOR_SPEED_RECORDS.get(PAGE_PREFIX + path, 'json');
    let record;
    try {
      const data = await analyzePage(url);
      record = normalizeAnalysis(data, url);
    } catch (error) {
      record = { path, url, scannedAt: new Date().toISOString(), ok: false, error: error?.message || String(error), responseTimeMs: null, actionableCount: 0, highCount: 0, mediumCount: 0, verdict: 'error' };
    }
    changes.push(...compareSpeed(previous, record));
    results.push(record);
    await env.CURATOR_SPEED_RECORDS.put(PAGE_PREFIX + record.path, JSON.stringify(record));
  }

  const nextCursor = (cursor + batch.length) % urls.length;
  const nextCycle = nextCursor === 0 && batch.length ? Number(state.cycle || 1) + 1 : Number(state.cycle || 1);
  await env.CURATOR_SPEED_RECORDS.put(STATE_KEY, JSON.stringify({ cursor: nextCursor, cycle: nextCycle, pageCount: urls.length, updatedAt: new Date().toISOString() }));

  const snapshot = await buildSnapshot(env, urls.length, nextCycle, changes);
  await env.CURATOR_SPEED_RECORDS.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return { ok: true, batchSize: batch.length, snapshot };
}

export async function readSpeedSnapshot(env) {
  if (!env.CURATOR_SPEED_RECORDS) return null;
  return env.CURATOR_SPEED_RECORDS.get(SNAPSHOT_KEY, 'json');
}

async function buildSnapshot(env, discoveredPageCount, cycle, changes = []) {
  const list = await env.CURATOR_SPEED_RECORDS.list({ prefix: PAGE_PREFIX, limit: 1000 });
  const pages = [];
  for (const key of list.keys) {
    const row = await env.CURATOR_SPEED_RECORDS.get(key.name, 'json');
    if (row) pages.push(row);
  }
  const successful = pages.filter(p => p.ok !== false && Number.isFinite(Number(p.responseTimeMs)));
  const responseTimes = successful.map(p => Number(p.responseTimeMs)).sort((a, b) => a - b);
  const avg = responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : null;
  const p50 = responseTimes.length ? responseTimes[Math.floor((responseTimes.length - 1) * 0.5)] : null;
  const p90 = responseTimes.length ? responseTimes[Math.floor((responseTimes.length - 1) * 0.9)] : null;
  const attention = pages.filter(p => p.highCount > 0 || p.verdict === 'attention');
  const opportunities = pages.filter(p => !attention.includes(p) && (p.mediumCount > 0 || p.verdict === 'good-with-opportunities'));
  const slowest = [...successful].sort((a, b) => Number(b.responseTimeMs) - Number(a.responseTimeMs)).slice(0, 8);
  const counts = changes.reduce((acc, item) => (acc[item.type] = (acc[item.type] || 0) + 1, acc), {});

  return {
    generatedAt: new Date().toISOString(), cycle, discoveredPageCount, auditedPageCount: pages.length,
    coveragePct: discoveredPageCount ? Math.round((pages.length / discoveredPageCount) * 1000) / 10 : 0,
    healthyPageCount: pages.filter(p => p.verdict === 'healthy').length, attentionPageCount: attention.length,
    opportunityPageCount: opportunities.length, errorPageCount: pages.filter(p => p.ok === false).length,
    averageResponseTimeMs: avg, medianResponseTimeMs: p50, p90ResponseTimeMs: p90,
    changes: { total: changes.length, counts, items: changes.slice(0, 40), materialThreshold: `${MATERIAL_MS} ms and/or ${MATERIAL_PCT}%`, note: 'Synthetic response-time changes are observational; repeated measurements matter more than one sample.' },
    slowestPages: slowest.map(p => ({ path: p.path, responseTimeMs: p.responseTimeMs, verdict: p.verdict, highCount: p.highCount, mediumCount: p.mediumCount })),
    attentionPages: attention.slice(0, 8).map(p => ({ path: p.path, responseTimeMs: p.responseTimeMs, highCount: p.highCount, mediumCount: p.mediumCount, priorities: p.priorities || [] })),
    note: 'Synthetic Worker-side HTML response observations; use trends and repeated measurements rather than treating one sample as visitor-experience proof.'
  };
}

function compareSpeed(previous, current) {
  if (!previous) return [];
  const out = [];
  if (previous.ok !== false && current.ok === false) return [change('regressed', current.path, 'Speed monitor began failing', current.error || 'Performance analysis failed.')];
  if (previous.ok === false && current.ok !== false) out.push(change('recovered', current.path, 'Speed monitor recovered', `Page measured successfully at ${current.responseTimeMs} ms.`));
  if (current.ok === false || previous.ok === false) return out;

  const before = Number(previous.responseTimeMs || 0), after = Number(current.responseTimeMs || 0);
  const delta = after - before;
  const pct = before > 0 ? (delta / before) * 100 : 0;
  if (delta >= MATERIAL_MS && pct >= MATERIAL_PCT) out.push(change('slower', current.path, 'Page became materially slower', `${before} ms → ${after} ms (${Math.round(pct)}% slower).`, { before, after, deltaMs: delta, percent: pct }));
  else if (delta <= -MATERIAL_MS && pct <= -MATERIAL_PCT) out.push(change('faster', current.path, 'Page became materially faster', `${before} ms → ${after} ms (${Math.abs(Math.round(pct))}% faster).`, { before, after, deltaMs: delta, percent: pct }));

  const prevRank = verdictRank(previous), currRank = verdictRank(current);
  if (currRank > prevRank) out.push(change('regressed', current.path, 'Performance verdict worsened', `${previous.verdict || 'unknown'} → ${current.verdict || 'unknown'}.`));
  else if (currRank < prevRank) out.push(change('recovered', current.path, 'Performance verdict improved', `${previous.verdict || 'unknown'} → ${current.verdict || 'unknown'}.`));
  return out;
}

function verdictRank(row) {
  if (row?.ok === false || row?.verdict === 'error') return 4;
  if (row?.verdict === 'attention' || Number(row?.highCount || 0) > 0) return 3;
  if (row?.verdict === 'good-with-opportunities' || Number(row?.mediumCount || 0) > 0) return 2;
  return 1;
}
function change(type, path, title, summary, metrics = null) { return { type, path, title, summary, metrics, detectedAt: new Date().toISOString() }; }

function normalizeAnalysis(data, requestedUrl) {
  if (!data || data.error) throw new Error(data?.error || 'Speed analysis returned no data.');
  const finalUrl = data.page?.finalUrl || requestedUrl;
  return {
    path: toPath(finalUrl), url: finalUrl, title: data.page?.title || '', scannedAt: data.scannedAt || new Date().toISOString(), ok: true,
    responseTimeMs: Number(data.metrics?.responseTimeMs || 0), htmlBytes: Number(data.metrics?.htmlBytes || 0), imageCount: Number(data.metrics?.imageCount || 0),
    scriptCount: Number(data.metrics?.scriptCount || 0), stylesheetCount: Number(data.metrics?.stylesheetCount || 0), actionableCount: Number(data.verdict?.actionableCount || 0),
    highCount: Number(data.verdict?.highCount || 0), mediumCount: Number(data.verdict?.mediumCount || 0), verdict: data.verdict?.status || 'healthy',
    priorities: Array.isArray(data.verdict?.priorities) ? data.verdict.priorities.slice(0, 3) : []
  };
}

async function discoverPages() {
  const response = await fetch(SITEMAP_URL, { headers: { 'user-agent': 'CuratorSpeed-Monitor/1.0' } });
  if (!response.ok) throw new Error(`sitemap.xml returned HTTP ${response.status}`);
  const xml = await response.text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => decode(m[1].trim())).filter(isSiteHtmlUrl);
  return [...new Set(urls.map(normalizeUrl))];
}
function isSiteHtmlUrl(value) { try { const u = new URL(value); return u.hostname.replace(/^www\./i, '') === 'oceanliners.net' && !/\.(?:xml|json|js|css|jpg|jpeg|png|webp|gif|svg|pdf|zip)$/i.test(u.pathname); } catch { return false; } }
function normalizeUrl(value) { const u = new URL(value, SITE_ORIGIN); u.protocol = 'https:'; u.hostname = 'oceanliners.net'; u.hash = ''; u.search = ''; return u.href; }
function toPath(value) { try { let p = new URL(value, SITE_ORIGIN).pathname || '/'; p = p.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, ''); return p.length > 1 ? p.replace(/\/$/, '') : p; } catch { return String(value || ''); } }
function decode(value) { return String(value).replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"'); }
