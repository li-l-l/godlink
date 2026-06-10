import logging
import os
import re
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
ROOT = os.path.dirname(os.path.abspath(__file__))
log = logging.getLogger(__name__)

UA_SAFARI_IOS = (
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
)
UA_CHROME = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
)
UA = UA_SAFARI_IOS

# CDN 由来の "cloudflare" / "challenge-platform" は正常ページにも出るため除外
BLOCK_PATTERNS = (
    '<title>just a moment',
    'cf-browser-verification',
    'checking your browser before accessing',
    'checking your browser',
    'access denied',
    'enable javascript and cookies to continue',
    'attention required! | cloudflare',
)
VALID_PAGE_HINTS = (
    'manga-vertical', 'manga-list', 'mgcdn', 'mangaraw', 'di-1hua',
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
FETCH_TIMEOUT = 45
BROWSER_TIMEOUT_MS = 90000


class FetchBlockedError(Exception):
    """すべての回避ルートが失敗した場合に送出する。"""

    def __init__(self, message='すべての回避ルートがブロックされました', status=403, attempts=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.attempts = attempts or []


def _referer(url):
    parsed = urlparse(url)
    return f'{parsed.scheme}://{parsed.netloc}/'


def _looks_blocked(status_code, html):
    if status_code in (403, 429, 503):
        return True
    if not html or len(html.strip()) < 300:
        return True
    lower = html.lower()
    if any(p in lower for p in BLOCK_PATTERNS):
        return True
    # 200 かつ漫画サイトの実コンテンツがあれば CDN 文字列による誤検知を避ける
    if status_code == 200 and any(h in lower for h in VALID_PAGE_HINTS):
        return False
    if 'just a moment' in lower and 'cloudflare' in lower:
        return True
    return False


def _decode_response(r):
    r.encoding = r.apparent_encoding or 'utf-8'
    return r.text


def _attempt_record(route, ok, detail=''):
    return {'route': route, 'ok': ok, 'detail': detail}


def _fetch_requests(url):
    headers = {'User-Agent': UA, 'Referer': _referer(url), 'Accept-Language': 'ja,en;q=0.9'}
    r = requests.get(url, headers=headers, timeout=FETCH_TIMEOUT)
    html = _decode_response(r)
    if _looks_blocked(r.status_code, html):
        raise requests.HTTPError(f'blocked ({r.status_code})', response=r)
    r.raise_for_status()
    return html


def _get_cloudscraper(variant='safari_ios'):
    import cloudscraper

    if variant == 'chrome':
        return cloudscraper.create_scraper(
            browser={'browser': 'chrome', 'platform': 'windows', 'desktop': True},
        )
    return cloudscraper.create_scraper(
        browser={'browser': 'safari', 'platform': 'ios', 'mobile': True},
    )


def _fetch_cloudscraper(url):
    last_err = None
    for variant in ('safari_ios', 'chrome'):
        try:
            scraper = _get_cloudscraper(variant)
            headers = {'Referer': _referer(url), 'Accept-Language': 'ja,en;q=0.9'}
            ua = UA_SAFARI_IOS if variant == 'safari_ios' else UA_CHROME
            headers['User-Agent'] = ua
            r = scraper.get(url, headers=headers, timeout=FETCH_TIMEOUT)
            html = _decode_response(r)
            if _looks_blocked(r.status_code, html):
                raise requests.HTTPError(f'blocked ({r.status_code})', response=r)
            r.raise_for_status()
            return html
        except Exception as e:
            last_err = e
            log.warning('cloudscraper/%s failed for %s: %s', variant, url, e)
    raise last_err


def _is_render_host():
    return bool(os.environ.get('RENDER') or os.environ.get('RENDER_SERVICE_ID'))


def _cf_fetch_base():
    return os.environ.get('CF_FETCH_URL', '').strip().rstrip('/')


def _fetch_cf_worker(url):
    base = _cf_fetch_base()
    if not base:
        raise RuntimeError('CF_FETCH_URL が未設定です')
    proxy_url = f'{base}?url={quote(url, safe="")}'
    headers = {'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ja,en;q=0.9'}
    r = requests.get(proxy_url, headers=headers, timeout=FETCH_TIMEOUT + 30)
    html = _decode_response(r)
    if _looks_blocked(r.status_code, html):
        raise requests.HTTPError(f'cf-worker blocked ({r.status_code})', response=r)
    r.raise_for_status()
    return html


def _proxy_routes(target_url):
    encoded = quote(target_url, safe='')
    routes = [
        ('allorigins-raw', f'https://api.allorigins.win/raw?url={encoded}', 'raw'),
        ('allorigins-get', f'https://api.allorigins.win/get?url={encoded}', 'json'),
        ('corsproxy', f'https://corsproxy.io/?{encoded}', 'raw'),
        ('codetabs', f'https://api.codetabs.com/v1/proxy?quest={encoded}', 'raw'),
        ('corslol', f'https://api.cors.lol/?url={encoded}', 'raw'),
    ]

    scraper_key = os.environ.get('SCRAPER_API_KEY', '').strip()
    if scraper_key:
        routes.append((
            'scraperapi',
            f'http://api.scraperapi.com?api_key={scraper_key}&url={encoded}',
            'raw',
        ))

    crawlbase_token = os.environ.get('CRAWLBASE_TOKEN', '').strip()
    if crawlbase_token:
        routes.append((
            'crawlbase',
            f'https://api.crawlbase.com/?token={crawlbase_token}&url={encoded}',
            'raw',
        ))

    return routes


def _parse_proxy_response(proxy_name, mode, r, target_url):
    if mode == 'json':
        data = r.json()
        html = data.get('contents') or ''
        status_code = (data.get('status') or {}).get('http_code') or r.status_code
        if not html:
            raise requests.HTTPError(f'empty proxy json via {proxy_name}', response=r)
        if _looks_blocked(status_code, html):
            raise requests.HTTPError(f'proxy blocked ({status_code}) via {proxy_name}', response=r)
        return html

    html = _decode_response(r)
    if _looks_blocked(r.status_code, html):
        raise requests.HTTPError(f'proxy blocked ({r.status_code}) via {proxy_name}', response=r)
    r.raise_for_status()
    return html


def _fetch_via_proxy(proxy_name, proxy_url, target_url, mode='raw'):
    headers = {
        'User-Agent': UA,
        'Referer': _referer(target_url),
        'Accept-Language': 'ja,en;q=0.9',
    }
    r = requests.get(proxy_url, headers=headers, timeout=FETCH_TIMEOUT + 30)
    return _parse_proxy_response(proxy_name, mode, r, target_url)


def _fetch_proxies(target_url):
    routes = _proxy_routes(target_url)
    if not routes:
        raise RuntimeError('利用可能なプロキシがありません')

    errors = []
    if _is_render_host() and len(routes) > 1:
        with ThreadPoolExecutor(max_workers=min(5, len(routes))) as pool:
            futures = {
                pool.submit(_fetch_via_proxy, name, proxy_url, target_url, mode): name
                for name, proxy_url, mode in routes
            }
            for fut in as_completed(futures):
                name = futures[fut]
                try:
                    return fut.result()
                except Exception as e:
                    errors.append(f'{name}: {e}')
                    log.warning('proxy/%s failed for %s: %s', name, target_url, e)
        raise RuntimeError(errors[-1] if errors else 'all proxies failed')

    last_err = None
    for name, proxy_url, mode in routes:
        try:
            return _fetch_via_proxy(name, proxy_url, target_url, mode)
        except Exception as e:
            last_err = e
            log.warning('proxy/%s failed for %s: %s', name, target_url, e)
    raise last_err


def _fetch_playwright(url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        )
        try:
            context = browser.new_context(
                user_agent=UA,
                viewport={'width': 390, 'height': 844},
                is_mobile=True,
                locale='ja-JP',
            )
            page = context.new_page()
            page.goto(url, wait_until='domcontentloaded', timeout=BROWSER_TIMEOUT_MS)
            try:
                page.wait_for_selector(
                    '.manga-vertical, main img[src*="mgcdn"], a[href*="di-"][href*="hua"]',
                    timeout=30000,
                )
            except Exception:
                page.wait_for_timeout(4000)
            html = page.content()
            if _looks_blocked(200, html):
                raise RuntimeError('playwright: challenge page detected')
            return html
        finally:
            browser.close()


def _fetch_undetected_chrome(url):
    import undetected_chromedriver as uc

    options = uc.ChromeOptions()
    options.add_argument('--headless=new')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument(f'--user-agent={UA}')
    driver = uc.Chrome(options=options, use_subprocess=True)
    try:
        driver.set_page_load_timeout(60)
        driver.get(url)
        time.sleep(3)
        html = driver.page_source
        if _looks_blocked(200, html):
            raise RuntimeError('undetected-chromedriver: challenge page detected')
        return html
    finally:
        driver.quit()


def _fetch_browser(url):
    errors = []
    try:
        return _fetch_playwright(url)
    except Exception as e:
        errors.append(f'playwright: {e}')
        log.warning('playwright failed for %s: %s', url, e)

    if not _is_render_host():
        try:
            return _fetch_undetected_chrome(url)
        except Exception as e:
            errors.append(f'undetected-chromedriver: {e}')
            log.warning('undetected-chromedriver failed for %s: %s', url, e)

    raise RuntimeError('; '.join(errors) or 'browser fallback unavailable')


def _fetch_route_steps():
    steps = [
        ('requests', _fetch_requests),
        ('cloudscraper', _fetch_cloudscraper),
        ('proxy', _fetch_proxies),
        ('browser', _fetch_browser),
    ]
    if _is_render_host():
        # Render の DC IP は直接叩いてもほぼ弾かれる → 外部経由のみ
        render_steps = []
        if _cf_fetch_base():
            render_steps.append(('cf-worker', _fetch_cf_worker))
        render_steps.extend([steps[2], steps[3]])
        return render_steps
    if _cf_fetch_base():
        return [
            ('cf-worker', _fetch_cf_worker),
            steps[0], steps[1], steps[2], steps[3],
        ]
    return steps


def fetch_html(url):
    """
    条件分岐型突破エンジン:
      1. requests → 403等なら cloudscraper へ
      2. データセンターIPブロックなら CORS/スクレイピングAPI プロキシへ
      3. 最終手段: Playwright / undetected-chromedriver ヘッドレス
    Render 上ではプロキシ経由を最優先する。
    """
    attempts = []
    status_hint = 403

    for route_name, fetcher in _fetch_route_steps():
        try:
            html = fetcher(url)
            attempts.append(_attempt_record(route_name, True))
            return html, route_name
        except Exception as e:
            detail = str(e)
            attempts.append(_attempt_record(route_name, False, detail))
            resp = getattr(e, 'response', None)
            if resp is not None:
                status_hint = getattr(resp, 'status_code', status_hint)
            log.info('%s failed for %s: %s', route_name, url, detail)

    raise FetchBlockedError(status=status_hint, attempts=attempts)


def fetch(url, retries=1):
    """HTML取得 → BeautifulSoup へ変換（既存パース処理へ引き渡し）。"""
    last_err = None
    for attempt in range(retries):
        try:
            html, route = fetch_html(url)
            if attempt == 0:
                log.debug('fetch OK via %s: %s', route, url)
            return BeautifulSoup(html, 'html.parser')
        except FetchBlockedError:
            raise
        except Exception as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(1 + attempt)
    if isinstance(last_err, FetchBlockedError):
        raise last_err
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
    except FetchBlockedError as e:
        hint = (
            '自宅PCで python extractor.py を起動し、'
            'Settings → サーバーURL に http://192.168.x.x:5000 を設定すると安定します。'
        )
        if _is_render_host():
            hint += ' Render無料枠では外部APIキー(SCRAPER_API_KEY)の設定も有効です。'
        return jsonify({
            'error': e.message,
            'status': e.status,
            'message': e.message,
            'attempts': e.attempts,
            'hint': hint,
        }), e.status
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _fetch_image_bytes(url):
    """画像プロキシ用: 突破エンジンでHTML取得ルートを簡略再利用。"""
    headers = {'User-Agent': UA, 'Referer': _referer(url)}
    try:
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code == 403:
            raise requests.HTTPError('403', response=r)
        r.raise_for_status()
        return r.content, r.headers.get('Content-Type', 'image/jpeg').split(';')[0]
    except requests.HTTPError as e:
        if e.response is not None and e.response.status_code == 403:
            scraper = _get_cloudscraper('safari_ios')
            r = scraper.get(url, headers=headers, timeout=30)
            r.raise_for_status()
            return r.content, r.headers.get('Content-Type', 'image/jpeg').split(';')[0]
        raise


@app.route('/proxy')
def proxy_image():
    raw = (request.args.get('url') or '').strip()
    if not raw.startswith(('http://', 'https://')):
        return jsonify({'error': '有効な url パラメータが必要です'}), 400
    try:
        content, ct = _fetch_image_bytes(raw)
        if not ct.startswith('image/'):
            ct = 'image/jpeg'
        return Response(
            content,
            status=200,
            content_type=ct,
            headers={'Cache-Control': 'public, max-age=86400'},
        )
    except requests.RequestException as e:
        return jsonify({'error': str(e)}), 502


@app.route('/health')
def health():
    return jsonify({
        'ok': True,
        'host': 'render' if _is_render_host() else 'local',
        'cf_worker': bool(_cf_fetch_base()),
        'scraper_api': bool(os.environ.get('SCRAPER_API_KEY', '').strip()),
        'proxy_routes': [name for name, _, _ in _proxy_routes('https://example.com')],
        'render_strategy': 'cf-worker→proxy(parallel)→browser' if _is_render_host() else 'direct-first',
    })


@app.route('/diagnose')
def diagnose():
    """どの突破ルートが通るか簡易診断（Render ログ確認用）。"""
    target = (request.args.get('url') or 'https://mangaraw.best/manga-list').strip()
    try:
        html, route = fetch_html(target)
        return jsonify({
            'ok': True,
            'route': route,
            'length': len(html),
            'host': 'render' if _is_render_host() else 'local',
        })
    except FetchBlockedError as e:
        return jsonify({
            'ok': False,
            'status': e.status,
            'message': e.message,
            'attempts': e.attempts,
            'host': 'render' if _is_render_host() else 'local',
        }), e.status


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
