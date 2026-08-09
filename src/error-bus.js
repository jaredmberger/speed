const INCIDENT_PREFIX = 'incident:';
const HEARTBEAT_PREFIX = 'heartbeat:';
const EVENT_PREFIX = 'event:';

export async function reportSystemError(env, { source, component, error, severity = 'p1', type = 'runtime-error', context = {} }) {
  if (!env.CURATOR_ERROR_RECORDS) return null;
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  const now = new Date().toISOString();
  const fingerprint = await fingerprintFor(source, component, type, message);
  const key = INCIDENT_PREFIX + fingerprint;
  const previous = await env.CURATOR_ERROR_RECORDS.get(key, 'json');
  const incident = { id: previous?.id || `incident_${fingerprint.slice(0,20)}`, fingerprint, source, component, severity: normalizeSeverity(severity), type, message, context: sanitize(context), firstSeenAt: previous?.firstSeenAt || now, lastSeenAt: now, occurrences: Number(previous?.occurrences || 0) + 1, status: 'active', recoveredAt: null, recoveryMessage: null };
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify(incident));
  await writeEvent(env, 'incident', incident);
  return incident;
}

export async function reportSystemSuccess(env, { source, component, message = 'Component completed successfully.', maxAgeMinutes = 180, context = {} }) {
  if (!env.CURATOR_ERROR_RECORDS) return;
  const now = new Date().toISOString();
  await env.CURATOR_ERROR_RECORDS.put(`${HEARTBEAT_PREFIX}${slug(source)}:${slug(component)}`, JSON.stringify({ source, component, status: 'ok', message, at: now, maxAgeMinutes, context: sanitize(context) }));
  const listed = await env.CURATOR_ERROR_RECORDS.list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  for (const key of listed.keys) {
    const incident = await env.CURATOR_ERROR_RECORDS.get(key.name, 'json');
    if (!incident || incident.status !== 'active' || incident.source !== source || incident.component !== component) continue;
    const recovered = { ...incident, status: 'recovered', recoveredAt: now, lastSuccessfulAt: now, recoveryMessage: message };
    await env.CURATOR_ERROR_RECORDS.put(key.name, JSON.stringify(recovered), { expirationTtl: 60 * 60 * 24 * 180 });
    await writeEvent(env, 'recovery', recovered);
  }
}
async function writeEvent(env, kind, incident) { const stamp = new Date().toISOString(); await env.CURATOR_ERROR_RECORDS.put(`${EVENT_PREFIX}${stamp}:${Math.random().toString(36).slice(2,8)}`, JSON.stringify({ kind, at: stamp, incidentId: incident.id, fingerprint: incident.fingerprint, source: incident.source, component: incident.component, severity: incident.severity, status: incident.status, message: incident.message }), { expirationTtl: 60 * 60 * 24 * 180 }); }
async function fingerprintFor(source, component, type, message) { const normalized = `${source}|${component}|${type}|${message}`.toLowerCase().replace(/\d{4}-\d\d-\d\d[t ][\d:.z+-]+/g,'<timestamp>').replace(/\b\d{6,}\b/g,'<number>'); const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized)); return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,40); }
function normalizeSeverity(v) { v=String(v||'').toLowerCase(); return ['p0','critical'].includes(v)?'p0':['p1','high'].includes(v)?'p1':'p2'; }
function slug(v) { return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'unknown'; }
function sanitize(value) { const out={}; if(!value||typeof value!=='object')return out; for(const [k,v] of Object.entries(value).slice(0,30)){ if(/token|secret|password|authorization|cookie/i.test(k))continue; if(v==null||['string','number','boolean'].includes(typeof v))out[String(k).slice(0,80)]=typeof v==='string'?v.slice(0,1000):v;} return out; }
