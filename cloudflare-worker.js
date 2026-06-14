/**
 * Cloudflare Worker — HTML / POST API 取得用リレー
 *
 * GET:  ?url=https://example.com/page
 * POST: ?url=https://example.com/api  + body（form-urlencoded 等）
 *
 * デプロイ後、Settings または Render の CF_FETCH_URL に Worker URL を設定。
 */
export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Accept-Language',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');

    if (!target || !target.startsWith('https://')) {
      return Response.json(
        { error: 'url パラメータ (https://...) が必要です' },
        { status: 400, headers: cors },
      );
    }

    const origin = new URL(target).origin + '/';
    const safariUa =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

    const headers = {
      'User-Agent': safariUa,
      Referer: origin,
      'Accept-Language': 'ja,en;q=0.9',
    };

    let fetchOpts = { headers, cf: { cacheTtl: 300 } };

    if (request.method === 'POST') {
      headers['Content-Type'] = request.headers.get('Content-Type') || 'application/x-www-form-urlencoded';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers.Accept = 'text/html,*/*';
      fetchOpts = { ...fetchOpts, method: 'POST', body: await request.arrayBuffer() };
    } else {
      headers.Accept = 'text/html,application/xhtml+xml';
    }

    const res = await fetch(target, fetchOpts);

    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'text/html; charset=utf-8',
        ...cors,
      },
    });
  },
};
