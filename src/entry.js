import app from './worker.js';

const VERSION = '1.0';
const CALLBACK_RE = /^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[A-Za-z_$][0-9A-Za-z_$]*)*$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/curator-intelligence') {
      const payload = {
        ok: true,
        schemaVersion: VERSION,
        generatedAt: new Date().toISOString(),
        system: {
          id: 'speed',
          name: 'Curator Speed',
          status: 'good',
          statusLabel: 'Connected',
          value: 'Ready',
          summary: 'Curator Speed is available for on-demand performance analysis.',
          detail: 'No site-wide scan runs when Curator Intelligence loads.',
          url: 'https://speed.oceanliners.net/'
        },
        metrics: {
          mode: 'on-demand',
          persistentSnapshot: false
        },
        priorities: [],
        opportunities: [],
        activity: [],
        capabilities: {
          onDemandPageAnalysis: true,
          fullSiteScanOnRead: false,
          persistentSnapshot: false
        }
      };
      return intelligenceResponse(payload, url.searchParams.get('callback'));
    }
    return app.fetch(request, env, ctx);
  }
};

function intelligenceResponse(payload, callback) {
  const headers = {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  };
  if (callback && CALLBACK_RE.test(callback)) {
    return new Response(`${callback}(${JSON.stringify(payload)});`, {
      status: 200,
      headers: { ...headers, 'content-type': 'application/javascript; charset=utf-8' }
    });
  }
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }
  });
}
