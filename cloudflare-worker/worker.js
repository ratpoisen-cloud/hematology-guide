/**
 * Cloudflare Worker for Minzdrav RF Clinical Recommendations API
 * Reverse proxy for https://apicr.minzdrav.gov.ru/
 * Bypasses CORS and provides edge caching for official clinical recommendations and PDFs.
 */

const UPSTREAM_API = 'https://apicr.minzdrav.gov.ru';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Route: /api/search or ?op=GetJsonClinrecsFilterV2
    if (path.startsWith('/api/search') || url.searchParams.get('op') === 'GetJsonClinrecsFilterV2') {
      return handleSearch(request);
    }

    // Route: /api/pdf or ?op=GetClinrecPdf
    if (path.startsWith('/api/pdf') || url.searchParams.get('op') === 'GetClinrecPdf') {
      return handlePdf(request, url);
    }

    // Route: /api/rec or ?op=GetClinrec2
    if (path.startsWith('/api/rec') || url.searchParams.get('op') === 'GetClinrec2') {
      return handleRec(request, url);
    }

    // Default: forward generic query to api.ashx
    const targetUrl = new URL('/api.ashx' + url.search, UPSTREAM_API);
    try {
      const upstreamResp = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: {
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; GemRefWorker/1.0)',
        },
        body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : null,
      });

      const respHeaders = new Headers(upstreamResp.headers);
      for (const [key, val] of Object.entries(CORS_HEADERS)) {
        respHeaders.set(key, val);
      }

      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: respHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};

async function handleSearch(request) {
  const targetUrl = `${UPSTREAM_API}/api.ashx?op=GetJsonClinrecsFilterV2`;
  try {
    const body = request.method === 'POST' ? await request.text() : JSON.stringify({
      filters: [{ fieldName: 'status', filterType: 1, filterValueType: 2, value1: 0, value2: '', values: [] }],
      sortOption: { fieldName: 'publishdate', sortType: 2 },
      pageSize: 20,
      currentPage: 1,
      useANDoperator: true,
      columns: [],
    });

    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'Mozilla/5.0 (compatible; GemRefWorker/1.0)',
      },
      body,
    });

    const data = await resp.arrayBuffer();
    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=3600'); // 1 hour cache on edge

    return new Response(data, {
      status: resp.status,
      headers,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Search failed', details: err.message }), {
      status: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handlePdf(request, url) {
  const id = url.searchParams.get('id') || url.pathname.split('/').pop();
  if (!id) {
    return new Response(JSON.stringify({ error: 'Missing recommendation id' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const targetUrl = `${UPSTREAM_API}/api.ashx?op=GetClinrecPdf&id=${encodeURIComponent(id)}`;
  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GemRefWorker/1.0)',
      },
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: 'Failed to fetch PDF from Minzdrav', status: resp.status }), {
        status: resp.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', 'application/pdf');
    headers.set('Content-Disposition', `attachment; filename="CR_${id}.pdf"`);
    headers.set('Cache-Control', 'public, max-age=86400'); // 24 hours edge cache for PDFs

    return new Response(resp.body, {
      status: 200,
      headers,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'PDF proxy error', details: err.message }), {
      status: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleRec(request, url) {
  const id = url.searchParams.get('id') || url.pathname.split('/').pop();
  const targetUrl = `${UPSTREAM_API}/api.ashx?op=GetClinrec2&id=${encodeURIComponent(id)}`;
  try {
    const resp = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GemRefWorker/1.0)' },
    });
    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=3600');
    return new Response(resp.body, { status: resp.status, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Rec proxy error', details: err.message }), {
      status: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}
