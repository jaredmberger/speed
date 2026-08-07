import app from './entry.js';
import worker from './worker.js';
import { runSpeedMonitor, readSpeedSnapshot } from './speed-monitor.js';

const VERSION = '1.1';
const CALLBACK_RE = /^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[A-Za-z_$][0-9A-Za-z_$]*)*$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) return new Response(null, { status: 204, headers: corsHeaders() });
    if (url.pathname === '/api/speed-snapshot' && request.method === 'GET') return json({ ok: true, snapshot: await readSpeedSnapshot(env) });
    if (url.pathname === '/api/speed-monitor') {
      if (request.method === 'GET') return json({ ok: true, snapshot: await readSpeedSnapshot(env) });
      if (request.method === 'POST') {
        try { return json(await runSpeedMonitor(env, target => analyzePage(target, env, ctx))); }
        catch (error) { return json({ ok: false, error: error?.message || String(error) }, 500); }
      }
      return json({ ok: false, error: 'Method not allowed.' }, 405);
    }
    if (url.pathname === '/api/curator-intelligence' && request.method === 'GET') {
      const snapshot = await readSpeedSnapshot(env);
      return intelligenceResponse(buildIntelligencePayload(snapshot), url.searchParams.get('callback'));
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runSpeedMonitor(env, target => analyzePage(target, env, ctx)).catch(error => console.error('Curator Speed scheduled monitor failed', error)));
  }
};

async function analyzePage(target, env, ctx) {
  const request = new Request('https://speed.oceanliners.net/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ url: target }) });
  const response = await worker.fetch(request, env, ctx);
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) throw new Error(data?.error || `Speed analyzer returned HTTP ${response.status}`);
  return data;
}

function buildIntelligencePayload(snapshot) {
  if (!snapshot) {
    return {
      ok: true, schemaVersion: VERSION, generatedAt: new Date().toISOString(),
      system: { id: 'speed', name: 'Curator Speed', status: 'good', statusLabel: 'Connected', value: 'Building baseline', summary: 'Curator Speed is connected and waiting for its first retained monitoring batch.', detail: 'Scheduled bounded monitoring · 12 pages per hour', url: 'https://speed.oceanliners.net/' },
      metrics: { mode: 'scheduled-bounded', persistentSnapshot: true, auditedPageCount: 0, discoveredPageCount: 0, changeDetection: true },
      priorities: [], opportunities: [], activity: [], capabilities: { onDemandPageAnalysis: true, fullSiteScanOnRead: false, persistentSnapshot: true, scheduledMonitoring: true, changeDetection: true }
    };
  }

  const attention = Number(snapshot.attentionPageCount || 0), errors = Number(snapshot.errorPageCount || 0);
  const changes = snapshot.changes || { total: 0, counts: {}, items: [] };
  const regressions = (changes.items || []).filter(x => ['slower','regressed'].includes(x.type));
  const recoveries = (changes.items || []).filter(x => ['faster','recovered'].includes(x.type));
  const status = attention || errors || regressions.length ? 'warning' : 'good';
  const statusLabel = attention || errors || regressions.length ? 'Attention' : 'Connected';
  const avg = snapshot.averageResponseTimeMs == null ? '—' : `${snapshot.averageResponseTimeMs} ms avg`;

  const changePriorities = regressions.slice(0, 6).map((item, index) => ({
    title: item.title, summary: `${item.path}: ${item.summary}`, entity: item.path,
    severity: item.type === 'regressed' ? 'high' : 'medium', score: 92 - index * 3, sources: ['Curator Speed'], changeDetected: true
  }));
  const standingPriorities = (snapshot.attentionPages || []).slice(0, 6).map(page => ({
    title: 'Performance issue on monitored page', summary: `${page.path} recorded ${page.responseTimeMs ?? 'unknown'} ms HTML response time${page.highCount ? ` with ${page.highCount} high-priority finding${page.highCount === 1 ? '' : 's'}` : ''}.`,
    entity: page.path, severity: page.highCount ? 'high' : 'medium', score: Math.min(100, 55 + Number(page.highCount || 0) * 20 + Number(page.mediumCount || 0) * 8), sources: ['Curator Speed']
  }));
  const priorities = uniquePriorities([...changePriorities, ...standingPriorities]).slice(0, 8);
  const opportunities = (snapshot.slowestPages || []).slice(0, 5).map(page => ({ title: 'Review slower monitored page', summary: `${page.path} is among the slower recently measured pages at ${page.responseTimeMs} ms.`, meta: `${page.path} · ${page.verdict || 'observed'}`, entity: page.path, score: Number(page.responseTimeMs || 0), source: 'Curator Speed' }));

  const activity = [{
    title: changes.total ? 'Speed change detection completed' : 'Curator Speed retained monitoring active',
    summary: changes.total ? `${changes.total} material change${changes.total === 1 ? '' : 's'} detected in the latest batch: ${regressions.length} slower/regressed and ${recoveries.length} faster/recovered.` : `${snapshot.auditedPageCount || 0} pages have retained performance observations; no material changes were detected in the latest batch.`,
    meta: 'Curator Speed · Change Detection v1'
  }, ...recoveries.slice(0, 3).map(item => ({ title: item.title, summary: `${item.path}: ${item.summary}`, meta: 'Curator Speed · faster/recovered' }))];

  return {
    ok: true, schemaVersion: VERSION, generatedAt: snapshot.generatedAt || new Date().toISOString(),
    system: {
      id: 'speed', name: 'Curator Speed', status, statusLabel,
      value: regressions.length ? `${regressions.length} slower/regressed` : avg,
      summary: `${snapshot.auditedPageCount || 0}/${snapshot.discoveredPageCount || 0} pages have retained Speed observations; ${attention} currently require attention. Latest batch: ${regressions.length} slower/regressed, ${recoveries.length} faster/recovered.`,
      detail: `${snapshot.coveragePct || 0}% coverage · p90 ${snapshot.p90ResponseTimeMs ?? '—'} ms · Change Detection v1`, url: 'https://speed.oceanliners.net/'
    },
    metrics: {
      mode: 'scheduled-bounded', persistentSnapshot: true, auditedPageCount: Number(snapshot.auditedPageCount || 0), discoveredPageCount: Number(snapshot.discoveredPageCount || 0),
      coveragePct: Number(snapshot.coveragePct || 0), healthyPageCount: Number(snapshot.healthyPageCount || 0), attentionPageCount: attention,
      opportunityPageCount: Number(snapshot.opportunityPageCount || 0), errorPageCount: errors, averageResponseTimeMs: snapshot.averageResponseTimeMs,
      medianResponseTimeMs: snapshot.medianResponseTimeMs, p90ResponseTimeMs: snapshot.p90ResponseTimeMs,
      changeCount: Number(changes.total || 0), regressionCount: regressions.length, recoveryCount: recoveries.length
    },
    snapshot, priorities, opportunities, activity,
    capabilities: { onDemandPageAnalysis: true, fullSiteScanOnRead: false, persistentSnapshot: true, scheduledMonitoring: true, changeDetection: true }
  };
}
function uniquePriorities(items) { const seen = new Set(); return items.filter(item => { const key = `${item.title}|${item.entity}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function intelligenceResponse(payload, callback) { const headers = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' }; if (callback && CALLBACK_RE.test(callback)) return new Response(`${callback}(${JSON.stringify(payload)});`, { status: 200, headers: { ...headers, 'content-type': 'application/javascript; charset=utf-8' } }); return new Response(JSON.stringify(payload, null, 2), { status: 200, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } }); }
function corsHeaders() { return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }; }
function json(value, status = 200) { return new Response(JSON.stringify(value, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders() } }); }
