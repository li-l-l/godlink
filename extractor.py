import os
import re
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
ROOT = os.path.dirname(os.path.abspath(__file__))

UA = (
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
)
# lazy-load 突破: プレースホルダ src より data-* を優先
IMG_ATTRS = (
    'data-src', 'data-lazy-src', 'data-original',
    'src', 'data-url', 'data-lazy', 'data-echo',
)
PLACEHOLDER_HINTS = (
    'lazy.jpg', 'mangaraw-lazy', 'placeholder', '1x1.gif',
    'blank.gif', 'loading.gif', 'spacer.gif', 'pixel.gif',
)
SKIP_IMG = ('avatar', 'logo', 'emoji', 'icon', 'banner', 'adservice', 'doubleclick')
YEAR_RE = re.compile(r'\b(19|20)\d{2}\b')
CHAPTER_RE = re.compile(r'第?\s*(\d+)\s*話|di-(\d+)hua', re.I)
PAGE_RE = re.compile(r'[?&]page=(\d+)', re.I)
PAGE_WORKERS = 4


def fetch(url, retries=3):
    last_err = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers={'User-Agent': UA, 'Referer': url}, timeout=45)
            r.raise_for_status()
            r.encoding = r.apparent_encoding or 'utf-8'
            return BeautifulSoup(r.text, 'html.parser')
        except requests.RequestException as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(1 + attempt)
    raise last_err


def title_of(soup, url):
    h1 = soup.find('h1')
    if h1:
        return h1.get_text(strip=True)
    t = soup.find('title')
    return t.get_text(strip=True).split('-')[0].strip() if t else urlparse(url).path


def is_placeholder(url):
    if not url:
        return True
    s = url.strip().lower()
    if s.startswith('data:'):
        return True
    return any(h in s for h in PLACEHOLDER_HINTS)


def img_url(el, base):
    if not el:
        return None
    for attr in IMG_ATTRS:
        val = el.get(attr)
        if val and not is_placeholder(val):
            return urljoin(base, val.strip())
    for ss_attr in ('srcset', 'data-srcset'):
        ss = el.get(ss_attr)
        if ss:
            part = ss.split(',')[-1].strip().split()[0]
            if part and not is_placeholder(part):
                return urljoin(base, part)
    if el.name != 'img':
        return img_url(el.find('img'), base)
    return None


def link_of(el, base):
    if not el:
        return None, ''
    href = el.get('href')
    text = el.get_text(strip=True) or el.get('title', '') or el.get('aria-label', '')
    if not href or href.startswith('#') or href.lower().startswith('javascript:'):
        return None, text
    return urljoin(base, href.strip()), text


def clean(text):
    if not text:
        return '無題'
    t = YEAR_RE.sub('', text)
    return re.sub(r'\s+', ' ', t).strip(' -|·') or '無題'


def year_of(text):
    m = YEAR_RE.search(text or '')
    return m.group(0) if m else ''


def chapter_num(text, url=''):
    m = CHAPTER_RE.search(text or '')
    if m:
        return int(m.group(1) or m.group(2) or 0)
    m = re.search(r'di-(\d+)hua', url or '', re.I)
    return int(m.group(1)) if m else 0


def is_page_image(src):
    if not src:
        return False
    s = src.lower()
    if any(x in s for x in SKIP_IMG):
        return False
    if 'mgcdn' in s or re.search(r'/\d+\.(jpg|jpeg|png|webp)(\?|$)', s):
        return True
    if 'storage/images/covers' in s:
        return False
    return 'blogger.googleusercontent.com/img/' in s and 'avatar' not in s


def list_base_url(url):
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    qs.pop('page', None)
    query = urlencode({k: v[0] for k, v in qs.items()})
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, '', query, ''))


def page_url(base_url, page_num):
    parsed = urlparse(base_url)
    qs = parse_qs(parsed.query)
    qs['page'] = [str(page_num)]
    query = urlencode({k: v[0] for k, v in qs.items()})
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, '', query, ''))


def detect_max_page(soup):
    max_p = 1
    for a in soup.find_all('a', href=True):
        href = a.get('href', '')
        if 'page=' not in href.lower():
            continue
        for m in PAGE_RE.finditer(href):
            max_p = max(max_p, int(m.group(1)))
    return max_p


def parse_card(card, base_url, img_sel, link_sel):
    img_el = card.select_one(img_sel) if img_sel else card.find('img')
    thumb = img_url(img_el, base_url)
    name = (img_el.get('alt') if img_el else '') or ''

    link_el = card.select_one(link_sel) if link_sel else None
    if not link_el:
        link_el = card.select_one('a[href^="/raw/"]') or card.find('a', href=True)
    detail, link_text = link_of(link_el, base_url)
    if not name:
        name = link_text or card.get_text(' ', strip=True)[:80]

    t_el = card.select_one('.latest-chapter a, h2 a')
    if t_el:
        _, t2 = link_of(t_el, base_url)
        if t2:
            name = name or t2

    if not detail:
        for a in card.find_all('a', href=True):
            href = a.get('href', '')
            if href.startswith('/raw/') and 'di-' not in href:
                detail, link_text = link_of(a, base_url)
                break

    if not detail and not thumb:
        return None

    return {
        'title': clean(name),
        'url': detail,
        'thumbnail': thumb,
        'year': year_of(name),
    }


def parse_cards(soup, base_url, card_sel, img_sel, link_sel):
    cards = soup.select(card_sel)
    if not cards:
        return []
    return [item for card in cards if (item := parse_card(card, base_url, img_sel, link_sel))]


def merge_items(seen, items, new_items):
    for item in new_items:
        key = item.get('url') or item.get('title')
        if not key or key in seen:
            continue
        seen.add(key)
        items.append(item)


def fetch_index_page(base_url, page_num, card_sel, img_sel, link_sel):
    page_link = page_url(base_url, page_num)
    soup = fetch(page_link)
    return parse_cards(soup, page_link, card_sel, img_sel, link_sel)


def extract_index(url, card_sel, img_sel, link_sel, paginate=False, page=None):
    base = list_base_url(url)

    if paginate and page is not None:
        page_num = max(1, int(page))
        page_link = page_url(base, page_num)
        soup = fetch(page_link)
        cards = soup.select(card_sel)
        if not cards:
            raise ValueError(f'ページ {page_num} に作品がありません')
        items = parse_cards(soup, page_link, card_sel, img_sel, link_sel)
        total_pages = detect_max_page(soup) if page_num == 1 else None
        return {
            'mode': 'index',
            'title': title_of(soup, page_link),
            'source_url': base,
            'items': items,
            'count': len(items),
            'page': page_num,
            'total_pages': total_pages,
        }

    first_url = page_url(base, 1)
    soup = fetch(first_url)
    cards = soup.select(card_sel)
    if not cards:
        raise ValueError(f'作品が見つかりません: {card_sel}')

    seen, items = set(), []
    merge_items(seen, items, parse_cards(soup, first_url, card_sel, img_sel, link_sel))

    total_pages = 1
    if paginate:
        total_pages = detect_max_page(soup)
        if total_pages > 1:
            print(f'Paginating {base} → {total_pages} pages')
            pending = list(range(2, total_pages + 1))
            for round_no in range(3):
                if not pending:
                    break
                failed = []
                with ThreadPoolExecutor(max_workers=PAGE_WORKERS) as pool:
                    futures = {
                        pool.submit(fetch_index_page, base, p, card_sel, img_sel, link_sel): p
                        for p in pending
                    }
                    for fut in as_completed(futures):
                        pnum = futures[fut]
                        try:
                            merge_items(seen, items, fut.result())
                        except Exception as e:
                            failed.append(pnum)
                            print(f'Page {pnum} failed (round {round_no + 1}): {e}')
                pending = failed

    if not items:
        raise ValueError('有効な作品データがありません')
    return {
        'mode': 'index',
        'title': title_of(soup, first_url),
        'source_url': base,
        'items': items,
        'count': len(items),
        'total_pages': total_pages,
    }


def extract_chapters(url, link_sel):
    soup = fetch(url)
    selector = link_sel or 'main a[href*="di-"][href*="hua"]'
    anchors = soup.select(selector)
    if not anchors:
        raise ValueError('話数リンクが見つかりません')

    manga_path = urlparse(url).path.rstrip('/')
    seen, items = set(), []

    for a in anchors:
        href, text = link_of(a, url)
        if not href or href in seen:
            continue
        if manga_path and manga_path not in urlparse(href).path:
            continue
        seen.add(href)
        num = chapter_num(text, href)
        items.append({
            'title': clean(text) or f'第{num}話',
            'url': href,
            'thumbnail': None,
            'year': '',
            'number': num,
        })

    items.sort(key=lambda x: x['number'], reverse=True)
    if not items:
        raise ValueError('話数を抽出できませんでした')
    return {
        'mode': 'chapters',
        'title': title_of(soup, url),
        'source_url': url,
        'items': items,
    }


def extract_media(url, media_sel):
    soup = fetch(url)
    selector = media_sel or 'main img'
    elements = soup.select(selector)
    if not elements:
        raise ValueError('画像要素が見つかりません')

    seen, urls = set(), []
    for el in elements:
        u = img_url(el, url)
        if not u or u in seen:
            continue
        if not is_page_image(u):
            continue
        seen.add(u)
        urls.append(u)

    if not urls:
        raise ValueError('本編画像を取得できませんでした（広告除外後0件）')

    def sort_key(u):
        m = re.search(r'/(\d+)\.(jpg|jpeg|png|webp)', u, re.I)
        return int(m.group(1)) if m else 0

    urls.sort(key=sort_key)

    return {
        'mode': 'media',
        'type': 'gallery',
        'title': title_of(soup, url),
        'source_url': url,
        'images': urls,
        'count': len(urls),
    }


@app.route('/extract', methods=['POST'])
def extract():
    data = request.get_json(silent=True) or {}
    url = (data.get('url') or '').strip()
    mode = (data.get('mode') or '').lower()

    if not url:
        return jsonify({'error': 'url が必要です'}), 400

    try:
        if mode == 'index':
            page_raw = data.get('page')
            page_num = int(page_raw) if page_raw is not None and str(page_raw).isdigit() else None
            out = extract_index(
                url,
                data.get('selector_card', ''),
                data.get('selector_img', ''),
                data.get('selector_link', ''),
                paginate=bool(data.get('paginate')),
                page=page_num,
            )
        elif mode == 'chapters':
            out = extract_chapters(url, data.get('selector_chapter', ''))
        elif mode == 'media':
            out = extract_media(url, data.get('selector_media', ''))
        else:
            return jsonify({'error': "mode は index / chapters / media"}), 400

        print(f'OK [{mode}] {url} → {len(out.get("items") or out.get("images") or [])} items')
        return jsonify(out)
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/proxy')
def proxy_image():
    raw = (request.args.get('url') or '').strip()
    if not raw.startswith(('http://', 'https://')):
        return jsonify({'error': '有効な url パラメータが必要です'}), 400
    try:
        parsed = urlparse(raw)
        referer = f'{parsed.scheme}://{parsed.netloc}/'
        r = requests.get(
            raw,
            headers={'User-Agent': UA, 'Referer': referer},
            timeout=30,
        )
        r.raise_for_status()
        ct = r.headers.get('Content-Type', 'image/jpeg').split(';')[0]
        if not ct.startswith('image/'):
            ct = 'image/jpeg'
        return Response(
            r.content,
            status=200,
            content_type=ct,
            headers={'Cache-Control': 'public, max-age=86400'},
        )
    except requests.RequestException as e:
        return jsonify({'error': str(e)}), 502


@app.route('/health')
def health():
    return jsonify({'ok': True})


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
    print('RetrieverX')
    print(f'  PC:     http://127.0.0.1:{port}')
    print(f'  スマホ: http://{ip}:{port}  （同じWi-Fi）')
    print('  → ブラウザで開いて「ホーム画面に追加」')
    app.run(host='0.0.0.0', port=port, debug=True)
