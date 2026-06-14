"""RetrieverX — 軽量ホスト + CORS リレー（スクレイピングは app.js / Safari 側）"""
import os
import socket
from urllib.parse import urlparse

import requests
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__)
CORS(app, resources={r'/*': {'origins': '*'}})
ROOT = os.path.dirname(os.path.abspath(__file__))

UA = (
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
)
FETCH_TIMEOUT = 45

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Accept-Language, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
}


def _cf_fetch_base():
    return os.environ.get('CF_FETCH_URL', '').strip().rstrip('/')


def _is_render_host():
    return bool(os.environ.get('RENDER') or os.environ.get('RENDER_SERVICE_ID'))


def _referer(url):
    parsed = urlparse(url)
    return f'{parsed.scheme}://{parsed.netloc}/'


def _safari_headers(url, accept='text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'):
    return {
        'User-Agent': UA,
        'Referer': _referer(url),
        'Accept': accept,
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    }


def _cors_response(body, status=200, content_type='text/html; charset=utf-8', extra=None):
    headers = {**CORS_HEADERS, 'Content-Type': content_type, 'Cache-Control': 'no-store'}
    if extra:
        headers.update(extra)
    return Response(body, status=status, headers=headers)


def _validate_target(url):
    url = (url or '').strip()
    if not url.startswith(('http://', 'https://')):
        return None, jsonify({'error': 'https:// で始まる url が必要です'}), 400
    return url, None, None


@app.route('/config')
def client_config():
    return jsonify({
        'mode': 'client-direct',
        'version': 2,
        'cfWorker': _cf_fetch_base(),
        'host': 'render' if _is_render_host() else 'local',
    })


@app.route('/health')
def health():
    return jsonify({
        'ok': True,
        'mode': 'client-direct',
        'host': 'render' if _is_render_host() else 'local',
        'cfWorker': bool(_cf_fetch_base()),
    })


@app.route('/relay', methods=['GET', 'POST', 'OPTIONS'])
def relay():
    """CORS 付与リレー — GET/POST 転送（twivideo API 等）。"""
    if request.method == 'OPTIONS':
        return _cors_response('', 204, 'text/plain')

    url, err, code = _validate_target(request.args.get('url'))
    if err:
        return err, code

    try:
        headers = _safari_headers(url)
        if request.method == 'POST':
            headers['Content-Type'] = request.headers.get(
                'Content-Type', 'application/x-www-form-urlencoded'
            )
            headers['X-Requested-With'] = 'XMLHttpRequest'
            r = requests.post(
                url,
                headers=headers,
                data=request.get_data(),
                timeout=FETCH_TIMEOUT,
            )
        else:
            r = requests.get(url, headers=headers, timeout=FETCH_TIMEOUT)
        ct = r.headers.get('Content-Type', 'text/html; charset=utf-8').split(';')[0]
        return _cors_response(r.content, r.status_code, ct)
    except requests.RequestException as e:
        return _cors_response(str(e), 502, 'text/plain; charset=utf-8')


def _media_referer(url):
    lower = (url or '').lower()
    if 'twimg.com' in lower or 'twitter.com' in lower or 'x.com' in lower:
        return 'https://twitter.com/'
    return _referer(url)


def _is_video_url(url):
    lower = (url or '').lower()
    return (
        'video.twimg.com' in lower
        or '.m3u8' in lower
        or '.mp4' in lower
        or '.webm' in lower
    )


def _proxy_upstream(url):
    is_video = _is_video_url(url)
    headers = _safari_headers(
        url,
        'video/mp4,video/*,*/*;q=0.8' if is_video else 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    )
    headers['Referer'] = _media_referer(url)
    range_hdr = request.headers.get('Range')
    if range_hdr:
        headers['Range'] = range_hdr

    r = requests.get(url, headers=headers, timeout=60, stream=True)
    r.raise_for_status()

    skip = {'content-encoding', 'transfer-encoding', 'connection'}
    passthrough = {
        k: v for k, v in r.headers.items()
        if k.lower() not in skip
    }
    ct = passthrough.get('Content-Type', '').split(';')[0]
    if is_video and not ct.startswith('video/'):
        passthrough['Content-Type'] = 'video/mp4'
    elif not is_video and not ct.startswith('image/'):
        passthrough['Content-Type'] = 'image/jpeg'

    extra = {'Cache-Control': 'public, max-age=86400'}
    extra.update(passthrough)

    def generate():
        for chunk in r.iter_content(chunk_size=65536):
            if chunk:
                yield chunk

    return Response(generate(), status=r.status_code, headers={**CORS_HEADERS, **extra})


@app.route('/proxy', methods=['GET', 'HEAD', 'OPTIONS'])
def proxy_media():
    """画像・動画リレー（Twitter CDN の Referer / Range 対応）。"""
    if request.method == 'OPTIONS':
        return _cors_response('', 204, 'text/plain')

    url, err, code = _validate_target(request.args.get('url'))
    if err:
        return err, code

    try:
        if request.method == 'HEAD':
            is_video = _is_video_url(url)
            headers = _safari_headers(
                url,
                'video/mp4,video/*,*/*;q=0.8' if is_video else 'image/*,*/*;q=0.8',
            )
            headers['Referer'] = _media_referer(url)
            r = requests.head(url, headers=headers, timeout=30, allow_redirects=True)
            r.raise_for_status()
            extra = {
                k: v for k, v in r.headers.items()
                if k.lower() not in {'content-encoding', 'transfer-encoding', 'connection'}
            }
            return Response('', status=r.status_code, headers={**CORS_HEADERS, **extra})
        return _proxy_upstream(url)
    except requests.RequestException as e:
        return jsonify({'error': str(e)}), 502


@app.route('/')
def root():
    return send_from_directory(ROOT, 'index.html')


@app.route('/manifest.json')
def web_manifest():
    return send_from_directory(ROOT, 'manifest.json', mimetype='application/manifest+json')


@app.route('/<path:name>')
def static_assets(name):
    if name in ('app.js', 'style.css', 'icon.svg'):
        return send_from_directory(ROOT, name)
    return '', 404


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return '127.0.0.1'


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    ip = local_ip()
    print('RetrieverX (client-direct)')
    print(f'  PC:     http://127.0.0.1:{port}')
    print(f'  スマホ: http://{ip}:{port}  （同じWi-Fi）')
    print('  → 取得は Safari 側 / HTML は CF Worker または /relay')
    app.run(host='0.0.0.0', port=port, debug=True)
