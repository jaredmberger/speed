import base from './entry-v1.1.js';
import { reportSystemError, reportSystemSuccess } from './error-bus.js';

const SOURCE = 'Curator Speed';
const REPORTER = '<script src="https://errors.oceanliners.net/client-reporter.js?v=20260809-1"></script>';

export default {
  async fetch(request, env, ctx) {
    try {
      const response = await base.fetch(request, env, ctx);
      return injectReporter(response, request.method);
    } catch (error) {
      ctx?.waitUntil?.(reportSystemError(env, {
        source: SOURCE,
        component: 'request-handler',
        error,
        severity: 'p1',
        type: 'unhandled-request-error',
        context: { method: request.method, path: new URL(request.url).pathname }
      }));
      throw error;
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const response = await base.fetch(new Request('https://speed.internal/api/speed-monitor', { method: 'POST' }), env, ctx);
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.error || `Speed monitor returned HTTP ${response.status}`);
        }
        await reportSystemSuccess(env, {
          source: SOURCE,
          component: 'scheduled-monitor',
          message: 'Scheduled Speed monitor completed successfully.',
          maxAgeMinutes: 180,
          recoverAfter: 2,
        });
      } catch (error) {
        await reportSystemError(env, {
          source: SOURCE,
          component: 'scheduled-monitor',
          error,
          severity: 'p1',
          type: 'scheduled-monitor-error',
          confirmAfter: 3,
        });
        console.error('Curator Speed scheduled monitor failed', error);
      }
    })());
  }
};

async function injectReporter(response, method) {
  if (method === 'HEAD' || !(response.headers.get('content-type') || '').includes('text/html')) return response;
  const html = await response.text();
  if (html.includes('errors.oceanliners.net/client-reporter.js')) return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
  const enhanced = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${REPORTER}</head>`) : `${REPORTER}${html}`;
  return new Response(enhanced, { status: response.status, statusText: response.statusText, headers: response.headers });
}
