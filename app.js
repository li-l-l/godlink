const API_BASE = (() => {
    const saved = localStorage.getItem('rx-api');
    if (saved) return saved.replace(/\/$/, '');
    if (location.protocol !== 'file:') return location.origin;
    return 'http://127.0.0.1:5000';
})();

function refreshApiUrls() {
    const base = (() => {
        const saved = localStorage.getItem('rx-api');
        if (saved) return saved.replace(/\/$/, '');
        if (location.protocol !== 'file:') return location.origin;
        return 'http://127.0.0.1:5000';
    })();
    RELAY = `${base}/relay`;
    PROXY = `${base}/proxy`;
    return base;
}

let RELAY = `${API_BASE}/relay`;
let PROXY = `${API_BASE}/proxy`;
let RX_CONFIG = { mode: 'client-direct', cfWorker: localStorage.getItem('rx-cf-worker') || '' };

const STORE_VER = 'rx-v8';
const INDEX_BATCH = 60;

const SITE_UA = (
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
);

const IMG_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'src', 'data-url', 'data-lazy', 'data-echo'];
const PLACEHOLDER_HINTS = ['lazy.jpg', 'mangaraw-lazy', 'placeholder', '1x1.gif', 'blank.gif', 'loading.gif', 'spacer.gif', 'pixel.gif'];
const SKIP_IMG = ['avatar', 'logo', 'emoji', 'icon', 'banner', 'adservice', 'doubleclick', 'popads', 'exoclick', 'juicyads', 'clickadu'];
const JUNK_MEDIA = ['adservice', 'doubleclick', 'popads', 'exoclick', 'juicyads', 'clickadu', 'banner', 'affiliate', '/ad/', '/ads/'];
const BLOCK_PATTERNS = [
    '<title>just a moment', 'cf-browser-verification', 'checking your browser before accessing',
    'checking your browser', 'access denied', 'enable javascript and cookies to continue',
    'attention required! | cloudflare',
];
const VALID_HINTS = ['manga-vertical', 'manga-list', 'mgcdn', 'mangaraw', 'di-1hua', 'art_li', 'twivideo', 'video.twimg.com'];
const AD_SELECTORS = [
    'script', 'iframe', 'noscript', 'embed', 'object', 'ins', 'aside',
    '.ads', '.ad', '.advert', '.banner-ad', '[class*="ad-"]', '[id*="ad-"]',
    '[class*="popup"]', '[class*="popunder"]',
];

const BUILTIN = [
    {
        id: 'mangaraw',
        name: '[COMIC] 漫画me',
        urlPattern: 'mangaraw.best',
        listUrl: 'https://mangaraw.best/manga-list',
        paginate: true,
        selectorCard: '.manga-vertical',
        selectorImg: 'img.cover',
        selectorLink: '.cover-frame a, a[href^="/raw/"]:not([href*="di-"])',
        selectorChapter: 'main a[href*="di-"][href*="hua"]',
        selectorMedia: 'main img[src*="mgcdn"]',
        icon: '🇯🇵',
        premium: true,
    },
    {
        id: 'twivideo',
        name: '[VIDEO] TWIVIDEO',
        urlPattern: 'twivideo.net',
        listUrl: 'https://twivideo.net/?ranking',
        indexApi: 'twivideo',
        paginate: true,
        paginateLimit: 50,
        directPlay: true,
        selectorCard: '.art_li:not(.item_add)',
        selectorImg: 'img',
        selectorLink: 'a.item_link',
        selectorChapter: '',
        selectorMedia: '',
        icon: '🎬',
        premium: true,
    },
];

const SEGS = [
    { id: 'all', label: 'すべて' },
    { id: 'new', label: '最新更新' },
    { id: 'pop', label: '人気' },
];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const screen = $('#screen');
let tab = 'projects';
let nav = [];
let editId = null;
let searchQ = '';
let indexQ = '';
let chapterQ = '';
let indexVisible = INDEX_BATCH;
let indexLoadToken = 0;
let indexView = null;
let favs = JSON.parse(localStorage.getItem('rx-fav') || '[]');
let hist = JSON.parse(localStorage.getItem('rx-hist') || '[]');
let useProxy = localStorage.getItem('rx-proxy') === '1';

function initProjects() {
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('rx-proj') || '[]'); } catch { stored = []; }
    if (localStorage.getItem('rx-ver') !== STORE_VER) {
        localStorage.setItem('rx-ver', STORE_VER);
        for (const b of BUILTIN) {
            if (!stored.some(p => p.id === b.id)) stored.unshift(b);
        }
        if (!stored.length) stored = [...BUILTIN];
        localStorage.setItem('rx-proj', JSON.stringify(stored));
    }
    return JSON.parse(localStorage.getItem('rx-proj') || '[]');
}
let projects = initProjects();

function saveProj() { localStorage.setItem('rx-proj', JSON.stringify(projects)); }
function saveFav() { localStorage.setItem('rx-fav', JSON.stringify(favs.slice(0, 100))); }
function saveHist() { localStorage.setItem('rx-hist', JSON.stringify(hist.slice(0, 50))); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── クライアント側 HTML 取得（Safari 直撃 → CF Worker → /relay） ── */
function cfWorkerUrl() {
    return (localStorage.getItem('rx-cf-worker') || RX_CONFIG.cfWorker || '').replace(/\/$/, '');
}

async function loadRemoteConfig() {
    try {
        const r = await fetch(`${refreshApiUrls()}/config`);
        if (!r.ok) return;
        RX_CONFIG = await r.json();
        if (RX_CONFIG.cfWorker && !localStorage.getItem('rx-cf-worker')) {
            localStorage.setItem('rx-cf-worker', RX_CONFIG.cfWorker);
        }
    } catch { /* offline / local */ }
}

function looksBlocked(status, html) {
    if (status === 403 || status === 429 || status === 503) return true;
    if (!html || html.trim().length < 300) return true;
    const lower = html.toLowerCase();
    if (BLOCK_PATTERNS.some(p => lower.includes(p))) return true;
    if (status === 200 && VALID_HINTS.some(h => lower.includes(h))) return false;
    return lower.includes('just a moment') && lower.includes('cloudflare');
}

async function fetchPage(url) {
    const htmlHeaders = {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    };

    // ① Safari 直撃（iPhone 回線 IP — CORS 許可サイトのみ成功）
    try {
        const r = await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow', headers: htmlHeaders });
        if (r.ok) {
            const html = await r.text();
            if (!looksBlocked(r.status, html)) return { html, route: 'safari-direct' };
        }
    } catch { /* mangaraw 等は CORS 拒否が通常 */ }

    // ② Cloudflare Worker（クライアント → Worker、Render 帯域ゼロ・無料 API 不使用）
    const cf = cfWorkerUrl();
    if (cf) {
        const r = await fetch(`${cf}?url=${encodeURIComponent(url)}`, { credentials: 'omit' });
        if (r.ok) {
            const html = await r.text();
            if (!looksBlocked(r.status, html)) return { html, route: 'cf-worker' };
        }
    }

    // ③ 自宅 PC /relay（一般回線 IP + CORS 付与）
    try {
        const r = await fetch(`${RELAY}?url=${encodeURIComponent(url)}`, { credentials: 'omit' });
        if (r.ok) {
            const html = await r.text();
            if (!looksBlocked(r.status, html)) return { html, route: 'relay' };
        }
    } catch { /* ignore */ }

    throw new Error(
        'ページを取得できませんでした。\n\n' +
        'Settings → Cloudflare Worker URL を設定するか、\n' +
        '自宅 PC で python extractor.py を起動してください。'
    );
}

async function fetchPostPage(targetUrl, formData, refererUrl = targetUrl) {
    const body = new URLSearchParams(formData).toString();
    const postHeaders = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,*/*',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    };

    const cf = cfWorkerUrl();
    if (cf) {
        try {
            const r = await fetch(`${cf}?url=${encodeURIComponent(targetUrl)}`, {
                method: 'POST',
                headers: postHeaders,
                body,
            });
            if (r.ok) {
                const html = await r.text();
                if (!looksBlocked(r.status, html)) return { html, route: 'cf-worker-post' };
            }
        } catch { /* next */ }
    }

    try {
        const r = await fetch(`${RELAY}?url=${encodeURIComponent(targetUrl)}`, {
            method: 'POST',
            headers: postHeaders,
            body,
        });
        if (r.ok) {
            const html = await r.text();
            if (!looksBlocked(r.status, html)) return { html, route: 'relay-post' };
        }
    } catch { /* ignore */ }

    throw new Error(
        'API を取得できませんでした。\n\n' +
        'Settings → Cloudflare Worker URL を設定してください。'
    );
}

function twivideoOrder(listUrl) {
    const sort = new URL(listUrl).searchParams.get('sort');
    if (sort === '3days') return '72';
    if (sort === 'week') return '168';
    return '24';
}

async function fetchTwivideoList(listUrl, offset, limit) {
    const apiUrl = 'https://twivideo.net/templates/view_lists.php';
    const { html } = await fetchPostPage(apiUrl, {
        offset: String(offset),
        limit: String(limit),
        tag: 'null',
        type: 'ranking',
        order: twivideoOrder(listUrl),
        le: '1000',
        ty: 'p6',
        myarray: '[]',
        offset_int: String(offset),
    }, listUrl);
    return html;
}

/* ── クライアント側 DOM 解析（広告除去 → 純粋 URL 抽出） ── */
function stripAds(doc) {
    AD_SELECTORS.forEach(sel => doc.querySelectorAll(sel).forEach(el => el.remove()));
}

function parseDoc(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    stripAds(doc);
    return doc;
}

function absUrl(base, href) {
    if (!href) return null;
    try { return new URL(href, base).href; } catch { return null; }
}

function isPlaceholder(url) {
    if (!url) return true;
    const s = url.trim().toLowerCase();
    if (s.startsWith('data:')) return true;
    return PLACEHOLDER_HINTS.some(h => s.includes(h));
}

function isJunkMedia(url) {
    if (!url) return true;
    const s = url.toLowerCase();
    return JUNK_MEDIA.some(j => s.includes(j));
}

function imgUrl(el, base) {
    if (!el) return null;
    for (const attr of IMG_ATTRS) {
        const val = el.getAttribute(attr);
        if (val && !isPlaceholder(val)) return absUrl(base, val.trim());
    }
    for (const attr of ['srcset', 'data-srcset']) {
        const ss = el.getAttribute(attr);
        if (ss) {
            const part = ss.split(',').pop().trim().split(/\s+/)[0];
            if (part && !isPlaceholder(part)) return absUrl(base, part);
        }
    }
    if (el.tagName !== 'IMG') return imgUrl(el.querySelector('img'), base);
    return null;
}

function linkOf(el, base) {
    if (!el) return { href: null, text: '' };
    const href = el.getAttribute('href');
    const text = (el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) {
        return { href: null, text };
    }
    return { href: absUrl(base, href.trim()), text };
}

function cleanTitle(text) {
    if (!text) return '無題';
    return text.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim().replace(/^[\s\-|·]+|[\s\-|·]+$/g, '') || '無題';
}

function yearOf(text) {
    const m = (text || '').match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : '';
}

function chapterNum(text, url = '') {
    let m = (text || '').match(/第?\s*(\d+)\s*話|di-(\d+)hua/i);
    if (m) return parseInt(m[1] || m[2] || '0', 10);
    m = (url || '').match(/di-(\d+)hua/i);
    return m ? parseInt(m[1], 10) : 0;
}

function titleOf(doc, url) {
    const h1 = doc.querySelector('h1');
    if (h1) return h1.textContent.trim();
    const t = doc.querySelector('title');
    if (t) return t.textContent.split('-')[0].trim();
    try { return new URL(url).pathname; } catch { return ''; }
}

function isPageImage(src) {
    if (!src || isJunkMedia(src)) return false;
    const s = src.toLowerCase();
    if (SKIP_IMG.some(x => s.includes(x))) return false;
    if (s.includes('mgcdn') || /\/\d+\.(jpg|jpeg|png|webp)(\?|$)/i.test(s)) return true;
    if (s.includes('storage/images/covers')) return false;
    return s.includes('blogger.googleusercontent.com/img/') && !s.includes('avatar');
}

function isPageVideo(src) {
    if (!src || isJunkMedia(src)) return false;
    const s = src.toLowerCase();
    return /\.(m3u8|mp4|webm)(\?|$)/i.test(s)
        || s.includes('video.twimg.com')
        || (s.includes('/video/') && !s.includes('ad'));
}

function listBaseUrl(url) {
    const u = new URL(url);
    u.searchParams.delete('page');
    return u.href;
}

function pageUrl(baseUrl, pageNum) {
    const u = new URL(baseUrl);
    u.searchParams.set('page', String(pageNum));
    return u.href;
}

function detectMaxPage(doc) {
    let maxP = 1;
    doc.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href') || '';
        if (!href.toLowerCase().includes('page=')) return;
        for (const m of href.matchAll(/[?&]page=(\d+)/gi)) {
            maxP = Math.max(maxP, parseInt(m[1], 10));
        }
    });
    return maxP;
}

function parseCard(card, base, imgSel, linkSel) {
    const imgEl = imgSel ? card.querySelector(imgSel) : card.querySelector('img');
    const thumb = imgUrl(imgEl, base);
    let name = imgEl?.getAttribute('alt') || '';

    let linkEl = linkSel ? card.querySelector(linkSel) : null;
    if (!linkEl) linkEl = card.querySelector('a[href^="/raw/"]') || card.querySelector('a[href]');
    let { href: detail, text: linkText } = linkOf(linkEl, base);
    if (!name) name = linkText || (card.textContent || '').trim().slice(0, 80);

    const rankEl = card.querySelector('.item_ranking');
    if (rankEl?.textContent?.trim()) name = rankEl.textContent.trim();

    const tEl = card.querySelector('.latest-chapter a, h2 a');
    if (tEl) {
        const { text: t2 } = linkOf(tEl, base);
        if (t2) name = name || t2;
    }
    if (!detail) {
        for (const a of card.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (href.startsWith('/raw/') && !href.includes('di-')) {
                ({ href: detail } = linkOf(a, base));
                break;
            }
        }
    }
    if (!detail && !thumb) return null;
    return { title: cleanTitle(name), url: detail, thumbnail: thumb, year: yearOf(name) };
}

function parseCards(doc, base, cardSel, imgSel, linkSel) {
    return [...doc.querySelectorAll(cardSel)]
        .map(card => parseCard(card, base, imgSel, linkSel))
        .filter(Boolean);
}

async function extractTwivideoIndex(proj, page) {
    const limit = proj.paginateLimit || 50;
    const pageNum = page != null ? Math.max(1, parseInt(page, 10)) : 1;
    const offset = (pageNum - 1) * limit;
    const listUrl = proj.listUrl || 'https://twivideo.net/?ranking';
    const html = await fetchTwivideoList(listUrl, offset, limit);
    const doc = parseDoc(html);
    const cardSel = proj.selectorCard || '.art_li:not(.item_add)';
    if (!doc.querySelector(cardSel)) {
        throw new Error(pageNum > 1 ? `ページ ${pageNum} に動画がありません` : '動画が見つかりません');
    }
    const items = parseCards(doc, listUrl, cardSel, proj.selectorImg, proj.selectorLink);
    items.forEach((it, i) => {
        if (!it.title || it.title === '無題') it.title = `No.${offset + i + 1}`;
    });
    if (!items.length) throw new Error('有効な動画データがありません');
    const hasMore = items.length >= limit && offset + limit < 1000;
    return {
        mode: 'index',
        title: 'TWIVIDEO ランキング',
        source_url: listUrl,
        items,
        count: items.length,
        page: pageNum,
        total_pages: pageNum === 1 ? (hasMore ? Math.ceil(1000 / limit) : 1) : null,
    };
}

async function extractIndex(req) {
    const { url, selector_card: cardSel, selector_img: imgSel, selector_link: linkSel, paginate, page } = req;
    const base = listBaseUrl(url);

    if (paginate && page != null) {
        const pageLink = pageUrl(base, Math.max(1, parseInt(page, 10)));
        const { html } = await fetchPage(pageLink);
        const doc = parseDoc(html);
        if (!doc.querySelector(cardSel)) throw new Error(`ページ ${page} に作品がありません`);
        const items = parseCards(doc, pageLink, cardSel, imgSel, linkSel);
        return {
            mode: 'index',
            title: titleOf(doc, pageLink),
            source_url: base,
            items,
            count: items.length,
            page: parseInt(page, 10),
            total_pages: parseInt(page, 10) === 1 ? detectMaxPage(doc) : null,
        };
    }

    const firstUrl = pageUrl(base, 1);
    const { html } = await fetchPage(firstUrl);
    const doc = parseDoc(html);
    if (!doc.querySelector(cardSel)) throw new Error(`作品が見つかりません: ${cardSel}`);

    const items = parseCards(doc, firstUrl, cardSel, imgSel, linkSel);
    const totalPages = paginate ? detectMaxPage(doc) : 1;
    if (!items.length) throw new Error('有効な作品データがありません');

    return {
        mode: 'index',
        title: titleOf(doc, firstUrl),
        source_url: base,
        items,
        count: items.length,
        total_pages: totalPages,
    };
}

async function extractChapters(req) {
    const { url, selector_chapter: linkSel } = req;
    const { html } = await fetchPage(url);
    const doc = parseDoc(html);
    const selector = linkSel || 'main a[href*="di-"][href*="hua"]';
    const anchors = doc.querySelectorAll(selector);
    if (!anchors.length) throw new Error('話数リンクが見つかりません');

    const mangaPath = new URL(url).pathname.replace(/\/$/, '');
    const seen = new Set();
    const items = [];

    anchors.forEach(a => {
        const { href, text } = linkOf(a, url);
        if (!href || seen.has(href)) return;
        if (mangaPath && !new URL(href).pathname.includes(mangaPath)) return;
        seen.add(href);
        const num = chapterNum(text, href);
        items.push({ title: cleanTitle(text) || `第${num}話`, url: href, thumbnail: null, year: '', number: num });
    });

    items.sort((a, b) => b.number - a.number);
    if (!items.length) throw new Error('話数を抽出できませんでした');
    return { mode: 'chapters', title: titleOf(doc, url), source_url: url, items };
}

async function extractMedia(req) {
    const { url, selector_media: mediaSel } = req;
    const { html } = await fetchPage(url);
    const doc = parseDoc(html);
    const selector = mediaSel || 'main img';
    const elements = doc.querySelectorAll(selector);

    const seen = new Set();
    const images = [];
    const videos = [];

    elements.forEach(el => {
        const u = imgUrl(el, url);
        if (!u || seen.has(u)) return;
        if (!isPageImage(u)) return;
        seen.add(u);
        images.push(u);
    });

    doc.querySelectorAll('video source[src], video[src]').forEach(el => {
        const u = absUrl(url, el.getAttribute('src'));
        if (!u || seen.has(u) || !isPageVideo(u)) return;
        seen.add(u);
        videos.push(u);
    });

    if (!images.length && !videos.length) throw new Error('本編メディアを取得できませんでした（広告除外後0件）');

    images.sort((a, b) => {
        const ma = a.match(/\/(\d+)\.(jpg|jpeg|png|webp)/i);
        const mb = b.match(/\/(\d+)\.(jpg|jpeg|png|webp)/i);
        return (ma ? parseInt(ma[1], 10) : 0) - (mb ? parseInt(mb[1], 10) : 0);
    });

    return {
        mode: 'media',
        type: videos.length && !images.length ? 'video' : 'gallery',
        title: titleOf(doc, url),
        source_url: url,
        images,
        videos,
        count: images.length || videos.length,
    };
}

async function extract(req) {
    const mode = (req.mode || '').toLowerCase();
    if (mode === 'index') return extractIndex(req);
    if (mode === 'chapters') return extractChapters(req);
    if (mode === 'media') return extractMedia(req);
    throw new Error('mode は index / chapters / media');
}

/* ── キャッシュ ── */
function cacheId(s) {
    let h = 0;
    for (let i = 0; i < (s || '').length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
}

function loadIndexCache(projId) {
    try {
        const raw = localStorage.getItem(`rx-cache-${projId}`);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveIndexCache(projId, data) {
    try {
        const payload = {
            title: data.title,
            source_url: data.source_url,
            items: data.items,
            count: data.items.length,
            total_pages: data.total_pages || 1,
            pagesLoaded: data.pagesLoaded || 1,
            complete: !!data.complete,
            cachedAt: data.cachedAt || Date.now(),
            loading: false,
        };
        localStorage.setItem(`rx-cache-${projId}`, JSON.stringify(payload));
    } catch {
        toast('キャッシュ保存に失敗しました（容量不足の可能性）', 'warn');
    }
}

function loadChapterCache(url) {
    try {
        const raw = localStorage.getItem(`rx-ch-${cacheId(url)}`);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveChapterCache(url, data) {
    try {
        localStorage.setItem(`rx-ch-${cacheId(url)}`, JSON.stringify({
            title: data.title,
            items: data.items,
            cachedAt: Date.now(),
        }));
    } catch { /* ignore */ }
}

function formatCacheTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function esc(t) { const d = document.createElement('div'); d.textContent = t ?? ''; return d.innerHTML; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

function toast(msg, type = 'info') {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `toast show ${type}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

function proxyUrl(url) {
    if (!url) return '';
    return `${PROXY}?url=${encodeURIComponent(url)}`;
}

function imgSrc(url) {
    if (!url) return '';
    return useProxy ? proxyUrl(url) : url;
}

function mediaSrc(url) {
    return imgSrc(url);
}

function noImg() {
    return '<div class="no-img"><i class="fa-regular fa-image"></i></div>';
}

function imgHtml(url, cls = '', alt = '') {
    if (!url) return noImg();
    const direct = esc(url);
    const src = esc(mediaSrc(url));
    return `<img class="rx-img ${cls}" src="${src}" data-direct="${direct}" data-proxy="${esc(proxyUrl(url))}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
}

function bindImages(root = screen) {
    $$('.rx-img', root).forEach(img => {
        img.onerror = () => {
            if (img.dataset.failed === '1') {
                img.replaceWith(Object.assign(document.createElement('div'), {
                    className: 'no-img',
                    innerHTML: '<i class="fa-regular fa-image"></i>',
                }));
                return;
            }
            if (img.dataset.proxy && img.src !== img.dataset.proxy) {
                img.dataset.failed = '1';
                img.src = img.dataset.proxy;
                return;
            }
            img.dataset.failed = '1';
            img.replaceWith(Object.assign(document.createElement('div'), {
                className: 'no-img',
                innerHTML: '<i class="fa-regular fa-image"></i>',
            }));
        };
    });
}

function isFav(url) { return favs.some(f => f.url === url); }
function toggleFav(item, proj) {
    const i = favs.findIndex(f => f.url === item.url);
    if (i >= 0) {
        favs.splice(i, 1);
        toast('お気に入りから削除しました');
    } else {
        favs.unshift({ ...item, projectId: proj.id, projectName: proj.name, ts: Date.now() });
        toast('お気に入りに追加しました', 'ok');
    }
    saveFav();
}

function loading(msg = '読み込み中...', sub = '') {
    screen.className = '';
    screen.innerHTML = `
        <div class="loading">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>${esc(msg)}</span>
            ${sub ? `<small class="load-sub">${esc(sub)}</small>` : ''}
            <div class="skel-row">${'<div class="skel"></div>'.repeat(3)}</div>
        </div>`;
}

function err(msg) {
    screen.className = 'scroll';
    screen.innerHTML = `
        <div class="hdr">
            <button class="back" id="eb"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="t center">Error</span>
            <span style="width:34px"></span>
        </div>
        <div class="err-box">
            <i class="fa-solid fa-circle-exclamation"></i>
            <p class="err" style="white-space:pre-wrap">${esc(msg)}</p>
            <button class="btn-sm" id="retry-btn">再試行</button>
        </div>`;
    $('#eb').onclick = popNav;
    $('#retry-btn')?.addEventListener('click', popNav);
}

function hdr(title, opts = {}) {
    const right = opts.right || '<span style="width:34px"></span>';
    if (opts.back) {
        return `<div class="hdr"><button class="back" id="nav-back"><i class="fa-solid fa-chevron-left"></i></button><span class="t center">${esc(title)}</span>${right}</div>`;
    }
    if (opts.tools) {
        return `<div class="hdr"><span class="t">${esc(title)}</span><div class="acts"><button class="hbtn" id="h-add" title="追加"><i class="fa-solid fa-plus"></i></button><button class="hbtn" id="h-edit" title="編集"><i class="fa-solid fa-pen"></i></button><button class="hbtn" id="h-lock" title="ロック"><i class="fa-solid fa-lock-open"></i></button></div></div>`;
    }
    return `<div class="hdr"><span class="t center" style="flex:1">${esc(title)}</span></div>`;
}

function searchBar(id, placeholder, value = '') {
    return `<div class="srch"><div class="sbox"><i class="fa-solid fa-magnifying-glass"></i><input id="${id}" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" placeholder="${esc(placeholder)}" value="${esc(value)}"><button class="sclear ${value ? '' : 'hidden'}" type="button" data-for="${id}"><i class="fa-solid fa-xmark"></i></button></div></div>`;
}

function bindSearch(inputId, onChange) {
    const input = $(`#${inputId}`);
    if (!input) return;
    const clear = input.parentElement.querySelector('.sclear');
    let composing = false;
    let debounceTimer = null;

    const apply = () => {
        clearTimeout(debounceTimer);
        const pos = input.selectionStart;
        clear?.classList.toggle('hidden', !input.value);
        onChange(input.value.trim());
        requestAnimationFrame(() => {
            const el = $(`#${inputId}`);
            if (!el) return;
            el.focus({ preventScroll: true });
            try {
                const p = Math.min(pos ?? el.value.length, el.value.length);
                el.setSelectionRange(p, p);
            } catch { /* mobile */ }
        });
    };

    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
        composing = false;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(apply, 300);
    });
    input.addEventListener('input', () => {
        clear?.classList.toggle('hidden', !input.value);
        if (composing) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(apply, 450);
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            apply();
        }
    });
    input.addEventListener('search', () => {
        if (!input.value) apply();
    });
    clear?.addEventListener('click', () => {
        clearTimeout(debounceTimer);
        input.value = '';
        clear.classList.add('hidden');
        onChange('');
        input.focus();
    });
}

function filterItems(items, q) {
    if (!q) return items;
    const lq = q.toLowerCase();
    return items.filter(it => (it.title || '').toLowerCase().includes(lq));
}

function pushNav(fn) { nav.push(fn); fn(); }
function popNav() { nav.pop(); (nav[nav.length - 1] || renderProjects)(); }

function applySeg(items, seg) {
    if (seg === 'pop') return [...items].reverse();
    return [...items];
}

/* ── ① 作品グリッド ── */
function indexBody(proj, page) {
    const body = {
        url: proj.listUrl || `https://${proj.urlPattern}/`,
        mode: 'index',
        selector_card: proj.selectorCard,
        selector_img: proj.selectorImg,
        selector_link: proj.selectorLink,
        paginate: !!proj.paginate,
    };
    if (page != null) body.page = page;
    return body;
}

async function fetchIndexPage(proj, page) {
    if (proj.indexApi === 'twivideo') return extractTwivideoIndex(proj, page);
    return extract(indexBody(proj, page));
}

function mergeIndexItems(data, incoming) {
    const seen = new Set(data.items.map(it => it.url || it.title));
    for (const it of incoming) {
        const key = it.url || it.title;
        if (key && !seen.has(key)) {
            seen.add(key);
            data.items.push(it);
        }
    }
    data.count = data.items.length;
}

async function loadRemainingPages(proj, data, token, startPage = 2) {
    const total = data.total_pages || 1;
    if (total <= 1) {
        data.loading = false;
        data.complete = true;
        saveIndexCache(proj.id, data);
        return;
    }
    const BATCH = 2;
    let failed = [];

    for (let start = startPage; start <= total; start += BATCH) {
        if (token !== indexLoadToken) {
            saveIndexCache(proj.id, data);
            return;
        }
        const end = Math.min(start + BATCH - 1, total);
        const pages = [];
        for (let p = start; p <= end; p++) pages.push(p);
        const results = await Promise.allSettled(pages.map(p => fetchIndexPage(proj, p)));
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'fulfilled') mergeIndexItems(data, results[i].value.items);
            else failed.push(pages[i]);
        }
        data.pagesLoaded = end;
        data.complete = false;
        saveIndexCache(proj.id, data);
        if (indexView && indexView.data === data) refreshIndexProgress(proj, data, indexView.seg);
        await sleep(350);
    }

    for (let round = 0; round < 3 && failed.length; round++) {
        if (token !== indexLoadToken) {
            saveIndexCache(proj.id, data);
            return;
        }
        const retry = [...failed];
        failed = [];
        for (const p of retry) {
            await sleep(600);
            try {
                const res = await fetchIndexPage(proj, p);
                mergeIndexItems(data, res.items);
            } catch {
                failed.push(p);
            }
        }
        data.pagesLoaded = Math.max(data.pagesLoaded || 1, total - failed.length);
        saveIndexCache(proj.id, data);
        if (indexView && indexView.data === data) refreshIndexProgress(proj, data, indexView.seg);
    }

    data.loading = false;
    data.complete = failed.length === 0;
    data.cachedAt = Date.now();
    saveIndexCache(proj.id, data);
    if (token !== indexLoadToken) return;
    if (indexView && indexView.data === data) {
        refreshIndexProgress(proj, data, indexView.seg);
        showIndex(proj, data, indexView.seg);
    }
    if (failed.length) {
        toast(`${data.items.length} 作品を保存（${failed.length} ページ取得失敗）`, 'warn');
    } else {
        toast(`${data.items.length} 作品の取得が完了しました`, 'ok');
    }
}

function refreshIndexProgress(proj, data, seg) {
    const el = $('#idx-load-prog');
    if (!el) return;
    if (data.loading) {
        el.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${data.pagesLoaded || 1} / ${data.total_pages} ページ · ${data.items.length} 作品`;
    } else {
        el.remove();
    }
    const badge = $('.hdr .badge');
    if (badge) badge.textContent = String(data.items.length);
}

async function fetchIndexFresh(proj, token) {
    let data;
    if (proj.paginate) {
        data = await fetchIndexPage(proj, 1);
        data.loading = (data.total_pages || 1) > 1;
        data.pagesLoaded = 1;
        data.complete = !data.loading;
    } else {
        data = await extract(indexBody(proj));
        data.loading = false;
        data.complete = true;
    }
    data.cachedAt = Date.now();
    saveIndexCache(proj.id, data);
    nav[nav.length - 1] = () => showIndex(proj, data, 'all');
    showIndex(proj, data, 'all');
    if (proj.paginate && data.loading) {
        await loadRemainingPages(proj, data, token, 2);
    } else {
        toast(`${data.items.length} 作品を更新しました`, 'ok');
    }
}

async function refreshProject(proj) {
    if (!nav.length) pushNav(() => {});
    indexQ = '';
    indexVisible = INDEX_BATCH;
    indexLoadToken += 1;
    loading('作品一覧を更新中...', 'Safari / CF Worker 経由で取得');
    try {
        await fetchIndexFresh(proj, indexLoadToken);
    } catch (e) { err(e.message); }
}

async function openProject(proj, opts = {}) {
    const refresh = opts.refresh === true;
    pushNav(() => {});
    indexQ = '';
    indexVisible = INDEX_BATCH;

    if (!refresh) {
        const cached = loadIndexCache(proj.id);
        if (cached?.items?.length) {
            cached.loading = false;
            nav[nav.length - 1] = () => showIndex(proj, cached, 'all');
            showIndex(proj, cached, 'all');
            return;
        }
    }

    indexLoadToken += 1;
    loading(refresh ? '作品一覧を更新中...' : '初回取得中...', 'Safari 直撃 → CF Worker 順');
    try {
        await fetchIndexFresh(proj, indexLoadToken);
    } catch (e) { err(e.message); nav.pop(); }
}

function renderIndexCards(items, start, end) {
    return items.slice(start, end).map((it, i) => {
        const idx = start + i;
        const liked = isFav(it.url);
        const thumb = it.thumbnail ? imgHtml(it.thumbnail, '', it.title) : noImg();
        return `<div class="card" data-i="${idx}"><div class="pframe">${thumb}${it.year ? `<span class="pyear">${esc(it.year)}</span>` : ''}<button class="pheart ${liked ? 'on' : ''}" data-i="${idx}" aria-label="お気に入り"><i class="fa-${liked ? 'solid' : 'regular'} fa-heart"></i></button></div><p class="cname">${esc(it.title)}</p></div>`;
    }).join('');
}

function bindIndexCards(proj, items) {
    $$('.card').forEach(el => {
        el.onclick = e => {
            if (e.target.closest('.pheart')) return;
            const item = items[+el.dataset.i];
            if (proj.directPlay) {
                openReader(proj, item, { title: item.title, url: item.url }, {
                    chapters: items,
                    chapterIndex: +el.dataset.i,
                });
            } else {
                openChapters(proj, item);
            }
        };
    });
    $$('.pheart').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            const it = items[+btn.dataset.i];
            toggleFav(it, proj);
            btn.classList.toggle('on', isFav(it.url));
            btn.innerHTML = `<i class="fa-${isFav(it.url) ? 'solid' : 'regular'} fa-heart"></i>`;
        };
    });
    bindImages();
}

function showIndex(proj, data, seg) {
    screen.className = '';
    const allItems = applySeg(data.items, seg);
    const items = filterItems(allItems, indexQ);
    const visible = Math.min(indexVisible, items.length);
    const hasMore = visible < items.length;

    const segs = SEGS.map(s => `<button class="seg ${seg === s.id ? 'on' : ''}" data-s="${s.id}">${s.label}</button>`).join('');
    const cards = items.length
        ? renderIndexCards(items, 0, visible)
        : `<div class="empty-grid"><i class="fa-solid fa-magnifying-glass"></i><p>「${esc(indexQ)}」に一致する作品がありません</p></div>`;

    const footer = hasMore
        ? `<div class="grid-foot" id="idx-more"><i class="fa-solid fa-chevron-down"></i> スクロールで続きを表示（${visible} / ${items.length}）</div>`
        : items.length > INDEX_BATCH
            ? `<div class="grid-foot done">${items.length} 作品をすべて表示</div>`
            : '';

    const loadBar = data.loading
        ? `<div class="idx-prog" id="idx-load-prog"><i class="fa-solid fa-spinner fa-spin"></i> ${data.pagesLoaded || 1} / ${data.total_pages} ページ · ${data.items.length} 作品</div>`
        : data.cachedAt
            ? `<div class="idx-prog muted">${data.complete ? '保存済み' : '一部保存'} · ${formatCacheTime(data.cachedAt)} · 更新は ↻ ボタン</div>`
            : '';

    screen.innerHTML = `
        ${hdr(proj.name, { back: true, right: `<button class="hbtn" id="idx-refresh" title="一覧を更新"><i class="fa-solid fa-rotate"></i></button><span class="badge">${allItems.length}</span>` })}
        ${searchBar('idx-q', '作品名で検索', indexQ)}
        <div class="segs">${segs}</div>
        ${loadBar}
        <div class="grid" id="idx-grid">${cards}${footer}</div>`;

    indexView = { proj, data, seg };
    $('#nav-back').onclick = () => { indexLoadToken += 1; indexView = null; nav = []; renderProjects(); switchTab('projects'); };
    $('#idx-refresh')?.addEventListener('click', () => refreshProject(proj));
    bindSearch('idx-q', q => { indexQ = q; indexVisible = INDEX_BATCH; showIndex(proj, data, seg); });
    $$('.seg').forEach(b => b.onclick = () => { indexQ = ''; indexVisible = INDEX_BATCH; showIndex(proj, data, b.dataset.s); });
    bindIndexCards(proj, items);

    const grid = $('#idx-grid');
    if (hasMore && grid) {
        const loadMore = () => {
            if (indexVisible >= items.length) return;
            const prev = indexVisible;
            indexVisible = Math.min(indexVisible + INDEX_BATCH, items.length);
            const more = renderIndexCards(items, prev, indexVisible);
            const foot = $('#idx-more');
            if (foot) foot.insertAdjacentHTML('beforebegin', more);
            bindIndexCards(proj, items);
            if (indexVisible >= items.length) {
                foot?.replaceWith(Object.assign(document.createElement('div'), {
                    className: 'grid-foot done',
                    textContent: `${items.length} 作品をすべて表示`,
                }));
            } else if (foot) {
                foot.innerHTML = `<i class="fa-solid fa-chevron-down"></i> スクロールで続きを表示（${indexVisible} / ${items.length}）`;
            }
        };
        grid.onscroll = () => {
            if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 120) loadMore();
        };
    }
}

/* ── ② 話数リスト ── */
async function openChapters(proj, manga, opts = {}) {
    if (!manga.url) { toast('URLがありません', 'warn'); return; }
    chapterQ = '';
    if (!opts.refresh) {
        const cached = loadChapterCache(manga.url);
        if (cached?.items?.length) {
            pushNav(() => showChapters(proj, manga, cached));
            showChapters(proj, manga, cached);
            return;
        }
    }
    loading(`「${manga.title}」の話数を取得...`);
    try {
        const data = await extract({
            url: manga.url,
            mode: 'chapters',
            selector_chapter: proj.selectorChapter,
        });
        saveChapterCache(manga.url, data);
        toast(`${data.items.length} 話を取得しました`, 'ok');
        pushNav(() => showChapters(proj, manga, data));
        showChapters(proj, manga, data);
    } catch (e) { err(e.message); }
}

function showChapters(proj, manga, data) {
    screen.className = 'scroll';
    const filtered = filterItems(data.items, chapterQ);
    const latest = data.items[0];

    const rows = filtered.length
        ? filtered.map((ch, i) =>
            `<div class="chrow" data-i="${i}"><span class="ch-title">${esc(ch.title)}</span><span class="chnum">${ch.number ? `#${ch.number}` : ''}<i class="fa-solid fa-chevron-right"></i></span></div>`
        ).join('')
        : `<p class="empty">「${esc(chapterQ)}」に一致する話がありません</p>`;

    screen.innerHTML = `
        ${hdr(manga.title, { back: true, right: `<span class="badge">${data.items.length}</span>` })}
        ${latest ? `<button class="quick-read" id="read-latest"><i class="fa-solid fa-book-open"></i> 最新話を読む <span>${esc(latest.title)}</span></button>` : ''}
        ${searchBar('ch-q', '話数・タイトルで検索', chapterQ)}
        <p class="sec-label">${filtered.length} / ${data.items.length} 話</p>
        <div class="chlist">${rows}</div>`;

    $('#nav-back').onclick = popNav;
    bindSearch('ch-q', q => { chapterQ = q; showChapters(proj, manga, data); });
    const openChapter = (ch) => {
        const idx = data.items.findIndex(c => c.url === ch.url);
        openReader(proj, manga, ch, { chapters: data.items, chapterIndex: idx >= 0 ? idx : 0 });
    };
    $('#read-latest')?.addEventListener('click', () => openChapter(latest));
    $$('.chrow').forEach(r => r.onclick = () => openChapter(filtered[+r.dataset.i]));
}

/* ── ③ 縦読み / 動画 ── */
async function openReader(proj, manga, chapter, ctx = {}) {
    const videoUrl = chapter.url || manga.url;
    const isDirectVideo = proj.directPlay || isPageVideo(videoUrl);

    if (isDirectVideo) {
        const data = {
            mode: 'media',
            type: 'video',
            title: chapter.title || manga.title,
            source_url: videoUrl,
            videos: [videoUrl],
            images: [],
            count: 1,
        };
        const readerCtx = { ...ctx, proj };
        const mount = () => showReader(data, manga, chapter, () => popNav(), readerCtx);
        if (ctx.replace) {
            nav[nav.length - 1] = mount;
            mount();
        } else {
            pushNav(mount);
        }
        hist.unshift({
            type: 'read',
            title: chapter.title || manga.title,
            url: videoUrl,
            mangaUrl: manga.url || videoUrl,
            mangaTitle: manga.title,
            projectId: proj.id,
            projectName: proj.name,
            pages: 1,
            ts: Date.now(),
        });
        saveHist();
        return;
    }

    loading(`「${chapter.title}」を読み込み...`, '漫画URLのみ取得 · 画像は CDN 直叩き');
    try {
        const data = await extract({
            url: chapter.url,
            mode: 'media',
            selector_media: proj.selectorMedia,
        });
        const readerCtx = { ...ctx, proj };
        const mount = () => showReader(data, manga, chapter, () => popNav(), readerCtx);
        if (ctx.replace) {
            nav[nav.length - 1] = mount;
            mount();
        } else {
            pushNav(mount);
        }
        hist.unshift({
            type: 'read',
            title: `${manga.title} ${chapter.title}`,
            url: chapter.url,
            mangaUrl: manga.url,
            mangaTitle: manga.title,
            projectId: proj.id,
            projectName: proj.name,
            pages: data.count,
            ts: Date.now(),
        });
        saveHist();
    } catch (e) { err(e.message); }
}

function showReader(data, manga, chapter, back, ctx = {}) {
    screen.className = 'black';
    const { chapters, chapterIndex, proj } = ctx;
    const idx = chapterIndex ?? -1;
    const prevCh = chapters && idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;
    const nextCh = chapters && idx > 0 ? chapters[idx - 1] : null;

    let body = '';
    if (data.videos?.length) {
        body = data.videos.map((src, i) =>
            `<figure class="page video-page" data-p="${i + 1}">
                <video class="page-video" controls playsinline preload="metadata" src="${esc(mediaSrc(src))}" data-direct="${esc(src)}"></video>
                <figcaption>Part ${i + 1}</figcaption>
            </figure>`
        ).join('');
    } else {
        body = (data.images || []).map((s, i) =>
            `<figure class="page" data-p="${i + 1}">${imgHtml(s, 'page-img', `P${i + 1}`)}<figcaption>P${i + 1}</figcaption></figure>`
        ).join('');
    }

    const chNav = chapters?.length ? `
            <div class="reader-ch-nav">
                <button type="button" class="rcnav-btn" id="ch-prev"${prevCh ? '' : ' disabled'}>
                    <i class="fa-solid fa-chevron-left"></i><span>${prevCh ? esc(prevCh.title) : '前の話'}</span>
                </button>
                <button type="button" class="rcnav-btn rcnav-mid" id="ch-list">
                    <i class="fa-solid fa-list"></i><span>一覧</span>
                </button>
                <button type="button" class="rcnav-btn" id="ch-next"${nextCh ? '' : ' disabled'}>
                    <span>${nextCh ? esc(nextCh.title) : '次の話'}</span><i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>` : '';

    screen.innerHTML = `
        <div class="reader-wrap">
            <div class="vhead" id="vhead">
                <button class="back" id="vb"><i class="fa-solid fa-chevron-left"></i></button>
                <div class="vtitle">
                    <h2>${esc(data.title || chapter.title)}</h2>
                    <small>${esc(manga.title)}</small>
                </div>
                <span id="page-ind">1 / ${data.count}P</span>
            </div>
            <div class="read-progress"><div class="read-progress-bar" id="rpbar"></div></div>
            <div class="vscroll" id="vscroll">${body}${chNav}</div>
        </div>`;

    $('#vb').onclick = back;
    $('#ch-list')?.addEventListener('click', back);
    $('#ch-prev')?.addEventListener('click', () => {
        if (!prevCh || !proj) return;
        openReader(proj, manga, prevCh, { chapters, chapterIndex: idx + 1, replace: true });
    });
    $('#ch-next')?.addEventListener('click', () => {
        if (!nextCh || !proj) return;
        openReader(proj, manga, nextCh, { chapters, chapterIndex: idx - 1, replace: true });
    });
    bindImages();
    $$('.page-video').forEach(v => {
        v.onerror = () => {
            if (v.dataset.retried) return;
            v.dataset.retried = '1';
            if (v.dataset.direct) v.src = v.dataset.direct;
        };
    });

    const scroll = $('#vscroll');
    const bar = $('#rpbar');
    const ind = $('#page-ind');
    const pages = $$('.page', scroll);
    let headVisible = true;

    function updateProgress() {
        const max = scroll.scrollHeight - scroll.clientHeight;
        const pct = max > 0 ? (scroll.scrollTop / max) * 100 : 0;
        bar.style.width = `${pct}%`;
        let current = 1;
        for (let i = 0; i < pages.length; i++) {
            if (pages[i].offsetTop - scroll.scrollTop < scroll.clientHeight * 0.35) current = i + 1;
        }
        ind.textContent = `${current} / ${data.count}P`;
    }

    scroll.addEventListener('scroll', updateProgress, { passive: true });
    updateProgress();

    scroll.addEventListener('click', e => {
        if (e.target.closest('.back') || e.target.closest('a') || e.target.closest('video') || e.target.closest('.reader-ch-nav')) return;
        headVisible = !headVisible;
        $('#vhead').classList.toggle('hidden-head', !headVisible);
        $('.read-progress')?.classList.toggle('hidden-head', !headVisible);
    });
}

/* ── Projects ── */
function renderProjects() {
    nav = [];
    screen.className = 'scroll';
    const q = searchQ.toLowerCase();
    const list = projects.filter(p => !q || p.name.toLowerCase().includes(q) || p.urlPattern.includes(q));

    const rows = list.map(p => {
        const ico = p.icon
            ? `<div class="pico-letter">${p.icon}</div>`
            : `<div class="pico-letter">${esc(p.name.charAt(1) || p.name.charAt(0))}</div>`;
        const cached = loadIndexCache(p.id);
        const cacheMark = cached?.items?.length ? `<span class="pcache" title="キャッシュあり">${cached.complete ? '✓' : '…'} ${cached.items.length}</span>` : '';
        return `<div class="prow" data-id="${p.id}">${ico}<div class="pinfo"><div class="n">${esc(p.name)}</div><div class="u">https://${esc(p.urlPattern)}</div></div>${cacheMark}${p.premium ? '<span class="crown">👑</span>' : ''}<button class="prefresh" data-id="${p.id}" title="一覧を更新"><i class="fa-solid fa-rotate"></i></button></div>`;
    }).join('');

    screen.innerHTML = `
        ${hdr('Projects', { tools: true })}
        ${searchBar('sq', 'Project名、URLで検索', searchQ)}
        <p class="sec-label">PROJECTS · ${list.length}</p>
        <div class="plist">${rows || '<p class="empty">プロジェクトがありません</p>'}</div>
        <div class="community" id="comm"><i class="fa-solid fa-users"></i>他のユーザーが公開したプロジェクト <i class="fa-solid fa-chevron-right chev"></i></div>`;

    $('#h-add').onclick = () => openModal();
    $('#h-edit').onclick = () => toast('長押しで削除は今後対応予定です');
    $('#h-lock').onclick = () => toast('Settings でアプリロックを設定できます');
    bindSearch('sq', v => { searchQ = v; renderProjects(); });
    $$('.prow').forEach(r => r.onclick = () => {
        const p = projects.find(x => x.id === r.dataset.id);
        if (p) openProject(p);
    });
    $$('.prefresh').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            const p = projects.find(x => x.id === btn.dataset.id);
            if (p) refreshProject(p);
        };
    });
    $('#comm').onclick = () => toast('公開プロジェクトは今後追加予定です');
}

/* ── Favorites ── */
function renderFav() {
    nav = [];
    screen.className = 'scroll';
    if (!favs.length) {
        screen.innerHTML = `${hdr('Favorites')}<p class="empty"><i class="fa-regular fa-heart empty-icon"></i>お気に入りはありません</p>`;
        return;
    }
    const rows = favs.map((f, i) => `
        <div class="frow" data-i="${i}">
            ${f.thumbnail ? imgHtml(f.thumbnail, 'fthumb') : '<div class="fthumb no-img"><i class="fa-regular fa-image"></i></div>'}
            <div class="finfo"><div class="ft">${esc(f.title)}</div><div class="fs">${esc(f.projectName || '')}</div></div>
            <span class="crown">👑</span>
        </div>`).join('');
    screen.innerHTML = `${hdr('Favorites', { back: false })}${searchBar('fav-q', 'Contents名、Project名で検索')}${rows ? `<p class="sec-label">Favorites · ${favs.length}</p><div class="plist">${rows}</div>` : ''}`;
    bindSearch('fav-q', q => {
        $$('.frow').forEach(r => {
            const f = favs[+r.dataset.i];
            const hit = !q || (f.title + f.projectName).toLowerCase().includes(q.toLowerCase());
            r.classList.toggle('hidden', !hit);
        });
    });
    $$('.frow').forEach(r => r.onclick = () => {
        const f = favs[+r.dataset.i];
        const p = projects.find(x => x.id === f.projectId) || projects[0];
        if (f.url && p) {
            if (p.directPlay) {
                openReader(p, f, { title: f.title, url: f.url });
            } else {
                openChapters(p, f);
            }
        }
    });
    bindImages();
}

/* ── History ── */
function renderHist() {
    nav = [];
    screen.className = 'scroll';
    if (!hist.length) {
        screen.innerHTML = `${hdr('History')}<p class="empty">履歴はありません</p>`;
        return;
    }
    const rows = hist.map((h, i) => `
        <div class="frow hist-row" data-i="${i}">
            <div class="fthumb hist-ico"><i class="fa-solid fa-book"></i></div>
            <div class="finfo">
                <div class="ft">${esc(h.title)}</div>
                <div class="fs">${esc(h.projectName || '')}${h.pages ? `<span class="ftag">${h.pages}P</span>` : ''}</div>
                <div class="fd">${new Date(h.ts).toLocaleString('ja-JP')}</div>
            </div>
        </div>`).join('');
    screen.innerHTML = `
        ${hdr('History')}
        <div class="hist-actions">
            <button class="btn-sm ghost" id="clear-hist"><i class="fa-solid fa-trash"></i> 履歴を消去</button>
        </div>
        <div class="plist">${rows}</div>`;
    $$('.hist-row').forEach(r => r.onclick = () => {
        const h = hist[+r.dataset.i];
        const p = projects.find(x => x.id === h.projectId) || projects[0];
        if (!p) return;
        if (h.type === 'read' && h.url) {
            if (p.directPlay) {
                openReader(p, { title: h.mangaTitle || h.title, url: h.url }, { title: h.title, url: h.url });
            } else if (h.mangaUrl) {
                openChapters(p, { url: h.mangaUrl, title: h.mangaTitle || h.title, thumbnail: null });
            }
        } else if (h.url) {
            openProject(p);
        }
    });
    $('#clear-hist')?.addEventListener('click', () => {
        if (confirm('閲覧履歴をすべて削除しますか？')) {
            hist = [];
            saveHist();
            toast('履歴を消去しました');
            renderHist();
        }
    });
}

/* ── Settings ── */
function renderSettings() {
    nav = [];
    screen.className = 'scroll';
    screen.innerHTML = `
        ${hdr('Settings')}
        <div class="sbody">
            <p class="sec-label">取得モード</p>
            <div class="sgrp">
                <div class="srow"><div><strong>クライアント直撃型</strong><small>Safari → CF Worker → 自宅 relay。Render 帯域・API 不使用</small></div><span>📱</span></div>
            </div>
            <p class="sec-label">Cloudflare Worker</p>
            <div class="sgrp">
                <label class="fld"><span>Worker URL（HTML 取得用）</span><input id="s-cf" placeholder="https://xxx.workers.dev"></label>
                <div class="srow"><button class="btn-sm" id="s-cf-save">保存</button><small>Render の CF_FETCH_URL と同じ URL</small></div>
            </div>
            <p class="sec-label">表示</p>
            <div class="sgrp">
                <div class="srow"><div><strong>画像プロキシ</strong><small>通常 OFF（CDN 直叩き）。表示失敗時のみ ON</small></div><button class="toggle ${useProxy ? 'on' : ''}" id="t-proxy"></button></div>
            </div>
            <p class="sec-label">サーバー</p>
            <div class="sgrp">
                <label class="fld"><span>ホスト URL（空欄=自動）</span><input id="s-api" placeholder="https://example.com"></label>
                <div class="srow"><button class="btn-sm" id="s-api-save">URLを保存</button><button class="btn-sm ghost" id="s-api-reset">自動</button></div>
                <div class="srow"><div><small id="s-api-show">${esc(refreshApiUrls())}</small><small>/relay · /config</small></div></div>
                <div class="srow"><button class="btn-sm" id="ping-srv"><i class="fa-solid fa-signal"></i> 接続確認</button><span id="ping-st"></span></div>
            </div>
            <p class="sec-label">スマホに追加</p>
            <div class="sgrp pwa-hint" id="pwa-hint">
                <div class="srow"><div><strong>ホーム画面に追加</strong><small>Render URL を Safari で開き「ホーム画面に追加」</small></div><span>📱</span></div>
            </div>
        </div>`;
    $('#s-cf').value = localStorage.getItem('rx-cf-worker') || RX_CONFIG.cfWorker || '';
    $('#s-cf-save').onclick = () => {
        const v = $('#s-cf').value.trim().replace(/\/$/, '');
        if (v) localStorage.setItem('rx-cf-worker', v);
        else localStorage.removeItem('rx-cf-worker');
        toast(v ? 'Worker URL を保存しました' : 'Worker URL をクリアしました', 'ok');
    };
    $('#t-proxy').onclick = function () {
        useProxy = !useProxy;
        localStorage.setItem('rx-proxy', useProxy ? '1' : '0');
        this.classList.toggle('on', useProxy);
        toast(useProxy ? '画像プロキシ ON' : '画像プロキシ OFF（CDN 直叩き）');
    };
    $('#s-api').value = localStorage.getItem('rx-api') || '';
    $('#s-api-save').onclick = () => {
        const v = $('#s-api').value.trim().replace(/\/$/, '');
        if (v) localStorage.setItem('rx-api', v);
        else localStorage.removeItem('rx-api');
        $('#s-api-show').textContent = refreshApiUrls();
        loadRemoteConfig();
        toast('ホスト URL を保存しました', 'ok');
    };
    $('#s-api-reset').onclick = () => {
        localStorage.removeItem('rx-api');
        $('#s-api').value = '';
        $('#s-api-show').textContent = refreshApiUrls();
        loadRemoteConfig();
        toast('自動検出に戻しました');
    };
    $('#ping-srv').onclick = async () => {
        const st = $('#ping-st');
        const base = refreshApiUrls();
        st.textContent = '確認中...';
        try {
            const r = await fetch(`${base}/health`);
            const d = await r.json();
            st.textContent = d.ok ? `✓ ${d.mode}` : '✗ エラー';
            st.className = d.ok ? 'ok' : 'ng';
            toast(d.ok ? '接続 OK（client-direct）' : '応答異常', d.ok ? 'ok' : 'warn');
        } catch {
            st.textContent = '✗ 未接続';
            st.className = 'ng';
            toast('サーバーに接続できません', 'warn');
        }
    };
}

/* ── Browser ── */
function renderBrowser() {
    nav = [];
    const p = projects.find(x => x.id === 'mangaraw') || projects[0];
    if (p) { openProject(p); return; }
    screen.innerHTML = `${hdr('Browser')}<p class="empty">プロジェクトを追加してください</p>`;
}

/* ── Modal ── */
function openModal(p) {
    editId = p?.id || null;
    $('#modal-title').textContent = p ? '編集' : '新規プロジェクト';
    $('#f-name').value = p?.name || '';
    $('#f-pattern').value = p?.urlPattern || '';
    $('#f-list').value = p?.listUrl || '';
    $('#f-card').value = p?.selectorCard || '.manga-vertical';
    $('#f-img').value = p?.selectorImg || 'img.cover';
    $('#f-link').value = p?.selectorLink || '';
    $('#f-ch').value = p?.selectorChapter || '';
    $('#f-media').value = p?.selectorMedia || '';
    $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); editId = null; }
$$('#modal [data-close]').forEach(el => el.onclick = closeModal);
$('#f-save').onclick = () => {
    const existing = editId ? projects.find(x => x.id === editId) : null;
    const p = {
        name: $('#f-name').value.trim(),
        urlPattern: $('#f-pattern').value.trim(),
        listUrl: $('#f-list').value.trim(),
        selectorCard: $('#f-card').value.trim(),
        selectorImg: $('#f-img').value.trim(),
        selectorLink: $('#f-link').value.trim(),
        selectorChapter: $('#f-ch').value.trim(),
        selectorMedia: $('#f-media').value.trim(),
        paginate: existing?.paginate || false,
    };
    if (!p.name || !p.urlPattern) { toast('名前とURLパターンは必須です', 'warn'); return; }
    if (editId) projects = projects.map(x => x.id === editId ? { ...x, ...p } : x);
    else projects.unshift({ id: uid(), premium: false, icon: '📁', ...p });
    saveProj(); closeModal(); renderProjects();
    toast('プロジェクトを保存しました', 'ok');
};

/* ── Tabs ── */
function switchTab(name) {
    tab = name;
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    const tabbar = $('#tabbar');
    tabbar?.classList.toggle('hidden', name === 'browser' && nav.length > 1);
    ({ settings: renderSettings, projects: renderProjects, browser: renderBrowser, favorites: renderFav, history: renderHist })[name]();
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

loadRemoteConfig().then(() => switchTab('projects'));
