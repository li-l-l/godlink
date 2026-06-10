/**
 * Cloudflare Worker — mangaraw HTML 取得用リレー
 *
 * デプロイ手順:
 * 1. https://dash.cloudflare.com → Workers → Create Worker
 * 2. このコードを貼り付けて Deploy
 * 3. 発行された URL (例: https://godlink-fetch.xxxx.workers.dev) をコピー
 * 4. Render → Environment → CF_FETCH_URL にその URL を設定 → 再デプロイ
 *
 * Render は Python を動かし続け、HTML 取得だけ Cloudflare エッジ経由にする構成。
 */
export default {
  async fetch(request) {
    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');

    if (!target || !target.startsWith('https://')) {
      return Response.json({ error: 'url パラメータ (https://...) が必要です' }, { status: 400 });
    }

    const origin = new URL(target).origin + '/';
    const res = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
          'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Referer': origin,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
      },
      cf: { cacheTtl: 300 },
    });

    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};
