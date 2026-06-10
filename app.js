const API_BASE = (() => {
    const saved = localStorage.getItem('rx-api');
    if (saved) return saved.replace(/\/$/, '');
    if (location.protocol !== 'file:') return location.origin;
    return 'http://127.0.0.1:5000';
})();
let API = `${API_BASE}/extract`;
let PROXY = `${API_BASE}/proxy`;

function refreshApiUrls() {
    const base = (() => {
        const saved = localStorage.getItem('rx-api');
        if (saved) return saved.replace(/\/$/, '');
        if (location.protocol !== 'file:') return location.origin;
        return 'http://127.0.0.1:5000';
    })();
    API = `${base}/extract`;
    PROXY = `${base}/proxy`;
    return base;
}
const STORE_VER = 'rx-v6';
const INDEX_BATCH = 60;

const BUILTIN = [{
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
}];

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
let useProxy = localStorage.getItem('rx-proxy') !== '0';

function initProjects() {
    if (localStorage.getItem('rx-ver') !== STORE_VER) {
        localStorage.setItem('rx-ver', STORE_VER);
        localStorage.setItem('rx-proj', JSON.stringify(BUILTIN));
    }
    return JSON.parse(localStorage.getItem('rx-proj') || '[]');
}
let projects = initProjects();

function saveProj() { localStorage.setItem('rx-proj', JSON.stringify(projects)); }
function saveFav() { localStorage.setItem('rx-fav', JSON.stringify(favs.slice(0, 100))); }
function saveHist() { localStorage.setItem('rx-hist', JSON.stringify(hist.slice(0, 50))); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function noImg() {
    return '<div class="no-img"><i class="fa-regular fa-image"></i></div>';
}

function imgHtml(url, cls = '', alt = '') {
    if (!url) return noImg();
    const direct = esc(url);
    const src = esc(imgSrc(url));
    return `<img class="rx-img ${cls}" src="${src}" data-direct="${direct}" data-proxy="${esc(proxyUrl(url))}" alt="${esc(alt)}" loading="lazy">`;
}

function bindImages(root = screen) {
    $$('.rx-img', root).forEach(img => {
        img.onerror = () => {
            if (img.dataset.failed) {
                img.replaceWith(Object.assign(document.createElement('div'), {
                    className: 'no-img',
                    innerHTML: '<i class="fa-regular fa-image"></i>',
                }));
                return;
            }
            if (img.src !== img.dataset.direct && img.dataset.direct) {
                img.dataset.failed = 'retry';
                img.src = img.dataset.direct;
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

async function call(body) {
    let r;
    try {
        r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
        throw new Error('サーバーに接続できません。extractor.py を起動し、http://127.0.0.1:5000 を開いてください');
    }
    const d = await r.json();
    if (!r.ok || d.error) {
        let msg = d.message || d.error || '通信エラー';
        if (d.attempts?.length) {
            const failed = d.attempts.filter(a => !a.ok).map(a => a.route).join(' → ');
            if (failed) msg += `\n\n試行: ${failed}`;
        }
        if (d.hint) msg += `\n\n${d.hint}`;
        throw new Error(msg);
    }
    return d;
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
    return `<div class="srch"><div class="sbox"><i class="fa-solid fa-magnifying-glass"></i><input id="${id}" placeholder="${esc(placeholder)}" value="${esc(value)}"><button class="sclear ${value ? '' : 'hidden'}" type="button" data-for="${id}"><i class="fa-solid fa-xmark"></i></button></div></div>`;
}

function bindSearch(inputId, onChange) {
    const input = $(`#${inputId}`);
    if (!input) return;
    const clear = input.parentElement.querySelector('.sclear');
    input.oninput = () => {
        clear?.classList.toggle('hidden', !input.value);
        onChange(input.value.trim());
    };
    clear?.addEventListener('click', () => {
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
    return call(indexBody(proj, page));
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
        data = await call(indexBody(proj));
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
    loading('作品一覧を更新中...', '更新ボタンでのみネット取得します');
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
    loading(refresh ? '作品一覧を更新中...' : '初回取得中...', proj.paginate ? '全ページを順次取得します' : '');
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
            openChapters(proj, items[+el.dataset.i]);
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
        const data = await call({
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
    $('#read-latest')?.addEventListener('click', () => openReader(proj, manga, latest));
    $$('.chrow').forEach(r => r.onclick = () => openReader(proj, manga, filtered[+r.dataset.i]));
}

/* ── ③ 縦読み ── */
async function openReader(proj, manga, chapter) {
    loading(`「${chapter.title}」を読み込み...`);
    try {
        const data = await call({
            url: chapter.url,
            mode: 'media',
            selector_media: proj.selectorMedia,
        });
        pushNav(() => showReader(data, manga, chapter, () => popNav()));
        showReader(data, manga, chapter, () => popNav());
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

function showReader(data, manga, chapter, back) {
    screen.className = 'black';
    const imgs = (data.images || []).map((s, i) =>
        `<figure class="page" data-p="${i + 1}">${imgHtml(s, 'page-img', `P${i + 1}`)}<figcaption>P${i + 1}</figcaption></figure>`
    ).join('');

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
            <div class="vscroll" id="vscroll">${imgs}</div>
        </div>`;

    $('#vb').onclick = back;
    bindImages();

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
        if (e.target.closest('.back') || e.target.closest('a')) return;
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
        if (f.url && p) openChapters(p, f);
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
        if (h.type === 'read' && h.mangaUrl) {
            openChapters(p, { url: h.mangaUrl, title: h.mangaTitle || h.title, thumbnail: null });
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
            <p class="sec-label">表示</p>
            <div class="sgrp">
                <div class="srow"><div><strong>画像プロキシ</strong><small>CORS・表示エラー時に中継（推奨ON）</small></div><button class="toggle ${useProxy ? 'on' : ''}" id="t-proxy"></button></div>
            </div>
            <p class="sec-label">サブスクリプション</p>
            <div class="sgrp">
                <div class="srow"><div><strong>無料プラン</strong><small>広告が表示されます</small></div><span>👑</span></div>
            </div>
            <p class="sec-label">セキュリティ</p>
            <div class="sgrp">
                <div class="srow"><div>アプリロックを有効にする</div><button class="toggle" id="t-lock"></button></div>
            </div>
            <p class="sec-label">サーバー</p>
            <div class="sgrp">
                <label class="fld"><span>サーバーURL（空欄=自動）</span><input id="s-api" placeholder="https://example.com"></label>
                <div class="srow"><button class="btn-sm" id="s-api-save">URLを保存</button><button class="btn-sm ghost" id="s-api-reset">自動</button></div>
                <div class="srow"><div><small id="s-api-show">${esc(refreshApiUrls())}</small><small>/extract · /proxy</small></div></div>
                <div class="srow"><button class="btn-sm" id="ping-srv"><i class="fa-solid fa-signal"></i> 接続確認</button><span id="ping-st"></span></div>
            </div>
            <p class="sec-label">スマホに追加</p>
            <div class="sgrp pwa-hint" id="pwa-hint">
                <div class="srow"><div><strong>ホーム画面に追加</strong><small id="pwa-steps">サーバーURLをスマホのブラウザで開き、メニューから「ホーム画面に追加」</small></div><span>📱</span></div>
            </div>
        </div>`;
    $('#t-proxy').onclick = function () {
        useProxy = !useProxy;
        localStorage.setItem('rx-proxy', useProxy ? '1' : '0');
        this.classList.toggle('on', useProxy);
        toast(useProxy ? '画像プロキシ ON' : '画像プロキシ OFF');
    };
    $('#t-lock').onclick = function () { this.classList.toggle('on'); toast('アプリロック（デモ）'); };
    $('#s-api').value = localStorage.getItem('rx-api') || '';
    $('#s-api-save').onclick = () => {
        const v = $('#s-api').value.trim().replace(/\/$/, '');
        if (v) localStorage.setItem('rx-api', v);
        else localStorage.removeItem('rx-api');
        $('#s-api-show').textContent = refreshApiUrls();
        toast('サーバーURLを保存しました', 'ok');
    };
    $('#s-api-reset').onclick = () => {
        localStorage.removeItem('rx-api');
        $('#s-api').value = '';
        $('#s-api-show').textContent = refreshApiUrls();
        toast('自動検出に戻しました');
    };
    $('#ping-srv').onclick = async () => {
        const st = $('#ping-st');
        const base = refreshApiUrls();
        st.textContent = '確認中...';
        try {
            const r = await fetch(`${base}/health`);
            const d = await r.json();
            st.textContent = d.ok ? '✓ 接続OK' : '✗ エラー';
            st.className = d.ok ? 'ok' : 'ng';
            toast(d.ok ? 'サーバー接続 OK' : 'サーバー応答異常', d.ok ? 'ok' : 'warn');
        } catch {
            st.textContent = '✗ 未接続';
            st.className = 'ng';
            toast('extractor.py を起動してください', 'warn');
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

switchTab('projects');
