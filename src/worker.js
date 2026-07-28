const MAX_HTML_BYTES = 2_000_000;
const ALLOWED_HOSTS = new Set(['oceanliners.net', 'www.oceanliners.net']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/analyze' && request.method === 'POST') {
      return analyzeRequest(request);
    }

    return env.ASSETS.fetch(request);
  }
};

async function analyzeRequest(request) {
  try {
    const body = await request.json();
    const target = normalizeTarget(body?.url);
    if (!target) return json({ error: 'Enter a valid OceanLiners.net URL.' }, 400);

    const started = Date.now();
    const response = await fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'CuratorSpeed/0.1 (+https://oceanliners.net/)'
      }
    });
    const responseTimeMs = Date.now() - started;
    const contentType = response.headers.get('content-type') || '';
    const buffer = await response.arrayBuffer();
    const transferBytes = buffer.byteLength;

    if (!contentType.includes('text/html')) {
      return json({ error: `Expected HTML but received ${contentType || 'an unknown content type'}.` }, 400);
    }
    if (transferBytes > MAX_HTML_BYTES) {
      return json({ error: 'The HTML document is larger than the current 2 MB analysis limit.' }, 413);
    }

    const html = new TextDecoder().decode(buffer);
    const resources = extractResources(html, response.url);
    const metrics = {
      status: response.status,
      responseTimeMs,
      htmlBytes: transferBytes,
      imageCount: resources.filter((item) => item.type === 'image').length,
      scriptCount: resources.filter((item) => item.type === 'script').length,
      stylesheetCount: resources.filter((item) => item.type === 'stylesheet').length,
      fontHintCount: resources.filter((item) => item.type === 'font-hint').length,
      preloadCount: resources.filter((item) => item.type === 'preload').length,
      lazyImageCount: resources.filter((item) => item.type === 'image' && item.loading === 'lazy').length
    };

    const findings = buildFindings({
      target,
      finalUrl: response.url,
      response,
      metrics,
      resources,
      html
    });

    return json({
      type: 'curator-performance-scan',
      version: 1,
      scannedAt: new Date().toISOString(),
      page: {
        requestedUrl: target.href,
        finalUrl: response.url,
        title: extractTitle(html)
      },
      metrics,
      cache: {
        cacheControl: response.headers.get('cache-control') || '',
        cfCacheStatus: response.headers.get('cf-cache-status') || '',
        contentEncoding: response.headers.get('content-encoding') || ''
      },
      resources,
      findings
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

function normalizeTarget(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return null;
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function extractResources(html, baseUrl) {
  const output = [];
  const add = (value) => {
    if (!value?.url) return;
    output.push(value);
  };

  for (const match of html.matchAll(/<img\b([^>]*?)>/gi)) {
    const attrs = attributes(match[1]);
    const src = attrs.src || firstSrcsetUrl(attrs.srcset);
    if (!src) continue;
    add({
      type: 'image',
      url: absoluteUrl(src, baseUrl),
      loading: attrs.loading || '',
      width: numeric(attrs.width),
      height: numeric(attrs.height),
      alt: attrs.alt || ''
    });
  }

  for (const match of html.matchAll(/<script\b([^>]*?)>/gi)) {
    const attrs = attributes(match[1]);
    if (!attrs.src) continue;
    add({ type: 'script', url: absoluteUrl(attrs.src, baseUrl), async: 'async' in attrs, defer: 'defer' in attrs, module: attrs.type === 'module' });
  }

  for (const match of html.matchAll(/<link\b([^>]*?)>/gi)) {
    const attrs = attributes(match[1]);
    const rel = String(attrs.rel || '').toLowerCase();
    if (!attrs.href) continue;
    if (rel.includes('stylesheet')) add({ type: 'stylesheet', url: absoluteUrl(attrs.href, baseUrl) });
    if (rel.includes('preload')) add({ type: 'preload', url: absoluteUrl(attrs.href, baseUrl), as: attrs.as || '' });
    if (rel.includes('preconnect') || rel.includes('dns-prefetch')) add({ type: 'font-hint', url: absoluteUrl(attrs.href, baseUrl), rel });
  }

  return dedupe(output);
}

function buildFindings({ target, finalUrl, response, metrics, resources, html }) {
  const findings = [];
  const push = (severity, category, title, summary, recommendation, estimatedImpact = '') => findings.push({
    id: `${category}:${stableId(`${target.href}|${title}`)}`,
    severity,
    category,
    title,
    summary,
    recommendation,
    estimatedImpact
  });

  if (target.href !== finalUrl) {
    push('low', 'redirect', 'Page request redirects', `The requested URL resolves to ${finalUrl}.`, 'Update internal links to use the final destination directly when convenient.', 'Small latency reduction');
  }
  if (metrics.responseTimeMs > 1200) {
    push('high', 'server-response', 'Slow initial response', `The HTML response took ${metrics.responseTimeMs} ms.`, 'Review Worker execution, origin response time, cache eligibility, and unnecessary redirects.', 'Potentially noticeable first-load improvement');
  } else if (metrics.responseTimeMs > 600) {
    push('medium', 'server-response', 'Initial response could be faster', `The HTML response took ${metrics.responseTimeMs} ms.`, 'Check Cloudflare caching and origin response time before changing front-end code.', 'Moderate improvement');
  }
  if (metrics.htmlBytes > 250_000) {
    push('medium', 'document-size', 'Large HTML document', `The page HTML is ${formatBytes(metrics.htmlBytes)}.`, 'Move repeated inline data or scripts into cached external files and remove obsolete markup.', 'Reduced transfer and parsing work');
  }
  if (metrics.imageCount > 25) {
    push('medium', 'images', 'Image-heavy page', `The page references ${metrics.imageCount} images.`, 'Lazy-load below-the-fold images and verify each image is appropriately sized and compressed.', 'Lower initial page weight');
  }
  const eagerImages = resources.filter((item) => item.type === 'image' && item.loading !== 'lazy');
  if (eagerImages.length > 8) {
    push('medium', 'images', 'Many images load eagerly', `${eagerImages.length} images are not marked for lazy loading.`, 'Keep the hero and immediately visible images eager, then add loading="lazy" to images farther down the page.', 'Faster initial rendering');
  }
  const missingDimensions = resources.filter((item) => item.type === 'image' && (!item.width || !item.height));
  if (missingDimensions.length > 3) {
    push('medium', 'layout-stability', 'Images lack dimensions', `${missingDimensions.length} images do not declare both width and height.`, 'Add intrinsic dimensions or an aspect-ratio so the layout reserves space before images load.', 'Less layout shifting');
  }
  if (metrics.scriptCount > 10) {
    push('medium', 'javascript', 'Many scripts requested', `The page references ${metrics.scriptCount} external scripts.`, 'Combine truly related scripts, remove obsolete utilities, and load page-specific behavior only where it is used.', 'Less network and execution overhead');
  }
  const blockingScripts = resources.filter((item) => item.type === 'script' && !item.async && !item.defer && !item.module);
  if (blockingScripts.length) {
    push('high', 'javascript', 'Render-blocking scripts detected', `${blockingScripts.length} external script${blockingScripts.length === 1 ? '' : 's'} may block HTML parsing.`, 'Use defer for scripts that do not need to execute before the document is parsed.', 'Faster first render');
  }
  if (metrics.stylesheetCount > 6) {
    push('low', 'css', 'Several stylesheets load separately', `The page references ${metrics.stylesheetCount} stylesheets.`, 'Review whether old or page-specific CSS is loading globally. Combine only files that are commonly used together.', 'Small request reduction');
  }
  const cacheControl = response.headers.get('cache-control') || '';
  if (!cacheControl) {
    push('medium', 'cache', 'No HTML cache policy detected', 'The response does not include a Cache-Control header.', 'Define an intentional cache policy for HTML while preserving timely editorial updates.', 'More predictable repeat visits');
  }
  if (!response.headers.get('content-encoding') && metrics.htmlBytes > 50_000) {
    push('medium', 'compression', 'HTML compression not detected', `The HTML response is ${formatBytes(metrics.htmlBytes)} and no Content-Encoding header was observed.`, 'Confirm Brotli or gzip compression is enabled at Cloudflare.', 'Reduced transfer size');
  }
  if (!/<meta\s+name=["']viewport["']/i.test(html)) {
    push('high', 'mobile', 'Viewport declaration missing', 'The page does not appear to include a mobile viewport meta tag.', 'Add width=device-width and initial-scale=1 to support proper mobile rendering.', 'Major mobile usability improvement');
  }

  return findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

function attributes(source) {
  const out = {};
  for (const match of String(source || '').matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return out;
}

function firstSrcsetUrl(value) {
  return String(value || '').split(',')[0]?.trim().split(/\s+/)[0] || '';
}

function absoluteUrl(value, baseUrl) {
  try { return new URL(value, baseUrl).href; } catch { return String(value || ''); }
}

function numeric(value) {
  const number = Number.parseInt(value || '', 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function dedupe(values) {
  return [...new Map(values.map((item) => [`${item.type}|${item.url}`, item])).values()];
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].trim()) : '';
}

function decodeEntities(value) {
  return String(value || '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#039;', "'");
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function severityRank(value) {
  return value === 'high' ? 0 : value === 'medium' ? 1 : 2;
}

function stableId(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
