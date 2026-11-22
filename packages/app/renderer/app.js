/* eslint-env browser */
/**
 * PowerNukkitX desktop app — renderer.
 *
 * Every action talks to the main process through window.pnx; this file holds
 * what a launcher needs and nothing more: which server is active and what its
 * process is doing, which view is on screen, and how a console line, a
 * download or a language switch becomes pixels. Wrapped in an IIFE so a double
 * evaluation can never collide with top-level bindings.
 *
 * The look is the site's (powernukkitx.org 0.2.0, the dashboard's rules): a
 * page header ruled off from its content, one accent-lit card per view,
 * states said as a word with a dot, motion only as feedback.
 */
(() => {
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const api = window.pnx;
const i18n = window.i18n;
const icons = window.icons;
const t = (key) => i18n.t(key);
/** the one place a %s placeholder meets its argument */
const tr = (key, ...params) => {
    let text = t(key);
    for (const param of params) text = text.replace('%s', String(param));
    return text;
};

/* ── tiny DOM kit ──────────────────────────────────────────────────────── */

function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'html') el.innerHTML = value;
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key === 'style') el.style.cssText = value;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
        else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of kids.flat(Infinity)) {
        if (kid === null || kid === undefined || kid === false) continue;
        el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
}

function svg(name, cls) {
    const tpl = document.createElement('template');
    tpl.innerHTML = icons.svg(name, cls);
    return tpl.content.firstChild;
}

/** the site's Button, as a function: variant, size, icon, loading */
function btn({ label, icon, variant = 'outline', size, onClick, title, iconEnd, disabled, pressed, type = 'button', cls }) {
    const el = h('button', {
        class: ['btn', `btn-${variant}`, size ? `btn-${size}` : '', !label && icon ? 'btn-icon' : '', cls || ''].filter(Boolean).join(' '),
        type,
        title: title || (!label ? undefined : null),
        'aria-label': !label ? title : null,
        'aria-pressed': pressed === undefined ? null : String(pressed),
        disabled: disabled ? true : null,
        onclick: onClick,
    });
    if (icon) el.append(svg(icon));
    if (label) el.append(h('span', { text: label }));
    if (iconEnd) {
        const end = svg(iconEnd);
        end.setAttribute('data-icon', 'inline-end');
        el.append(end);
    }
    return el;
}

/** runs fn with the button showing a spinner and refusing presses */
async function busy(button, fn) {
    if (!button || button.dataset.loading !== undefined) return fn();
    button.dataset.loading = '';
    button.setAttribute('aria-busy', 'true');
    const spin = h('span', { class: 'spinner' });
    button.append(spin);
    try {
        return await fn();
    } finally {
        spin.remove();
        delete button.dataset.loading;
        button.removeAttribute('aria-busy');
    }
}

function pill(tone, label, { live = false, dot = true } = {}) {
    return h('span', { class: `pill pill-${tone}` },
        dot ? h('span', { class: `pill-dot${live ? ' ping' : ''}` }) : null,
        h('span', { text: label }));
}

function emptyState({ icon, title, body, actions = [], hero = false, compact = false }) {
    return h('div', { class: `empty${hero ? ' empty-hero' : ''}${compact ? ' compact' : ''}` },
        icon ? h('span', { class: 'empty-ic' }, svg(icon)) : null,
        h(hero ? 'h1' : 'h2', { class: hero ? 'empty-title headline' : 'empty-title', text: title }),
        body ? h('p', { class: 'empty-body', text: body }) : null,
        actions.length ? h('div', { class: 'btn-row' }, actions) : null);
}

/** initials on one of the seven accents, picked from the name */
const TILE_HUES = [148, 194, 85, 27, 256, 305, 45];
function tile(name, big) {
    const clean = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
    const words = clean.split(/\s+/).filter(Boolean);
    const initials = (words.length > 1 ? words[0][0] + words[1][0] : clean.slice(0, 2)).toUpperCase() || '?';
    let hash = 0;
    for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return h('span', { class: `tile${big ? ' lg' : ''}`, style: `--tile-h:${TILE_HUES[hash % TILE_HUES.length]}`, 'aria-hidden': 'true', text: initials });
}

/* ── formatting ────────────────────────────────────────────────────────── */

function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${Math.round(kb)} ${t('ui.unit.kb')}`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} ${t('size.day')}`;
    return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')} ${t('size.gb')}`;
}

function fmtMemory(mem) {
    const m = String(mem || '').match(/^(\d+)([MG])$/i);
    if (!m) return '—';
    return m[2].toUpperCase() === 'G' ? `${m[1]} ${t('size.gb')}` : `${m[1]} ${t('size.day')}`;
}

function memMb(mem) {
    const m = String(mem || '').match(/^(\d+)([MG])$/i);
    return m ? Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1024 : 1) : 0;
}

function fmtUptime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const hh = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `${d}${t('ui.unit.d')} ${hh}${t('uptime.h')}`;
    if (hh > 0) return `${hh}${t('uptime.h')} ${String(m).padStart(2, '0')}${t('uptime.m')}`;
    if (m > 0) return `${m}${t('uptime.m')} ${String(s).padStart(2, '0')}${t('uptime.s')}`;
    return `${s}${t('uptime.s')}`;
}

function relTime(date) {
    const then = new Date(date).getTime();
    if (!then) return '—';
    const diff = (then - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(i18n.get(), { numeric: 'auto' });
    const abs = Math.abs(diff);
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
    return rtf.format(Math.round(diff / (86400 * 30)), 'month');
}

const fmtDate = (date) => new Date(date).toLocaleString(i18n.get(), { dateStyle: 'medium', timeStyle: 'short' });
const fmtNum = (n) => new Intl.NumberFormat(i18n.get(), { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n || 0);
const bare = (tag) => String(tag || '').replace(/^v/i, '');
const sameDir = (a, b) => Boolean(a) && Boolean(b)
    && String(a).trim().replace(/[\\/]+$/, '').toLowerCase() === String(b).trim().replace(/[\\/]+$/, '').toLowerCase();

/* ── state ─────────────────────────────────────────────────────────────── */

const MEMORY_OPTIONS = ['1G', '2G', '3G', '4G', '6G', '8G', '12G', '16G'];
const ACCENTS = [
    { id: 'grass', h: 148, c: 0.21 }, { id: 'diamond', h: 194, c: 0.12 }, { id: 'gold', h: 85, c: 0.16 },
    { id: 'redstone', h: 27, c: 0.2 }, { id: 'lapis', h: 256, c: 0.15 }, { id: 'amethyst', h: 305, c: 0.16 },
    { id: 'copper', h: 45, c: 0.14 },
];
const VIEWS = ['overview', 'console', 'players', 'plugins', 'config', 'backups', 'servers', 'create', 'guide', 'settings'];
const SERVER_VIEWS = new Set(['overview', 'console', 'players', 'plugins', 'config', 'backups']);
const MAX_LINES = 2500;

const S = {
    view: 'overview',
    servers: [],
    activeId: null,
    /** what each server's process is doing, by dir key: local and VPS alike */
    runs: new Map(),
    /** console, players and counters, one buffer per server */
    bufs: new Map(),
    sysBy: new Map(),
    java: null,
    releases: [],
    stable: null,
    sys: null,
    about: null,
    prefs: {
        theme: 'system', density: 'comfortable', motionOff: false, accent: 'grass',
        confirmQuit: true, updateAuto: true, updateBg: false, autoRestart: false, memory: '2G',
    },
    tutorialDone: [],
    onboarded: true,
    onboardStep: 0,
    ports: new Map(),
    backups: new Map(),
    health: { port: null, checkedAt: 0 },
    cmdHistory: [],
    cmdIndex: -1,
    pg: { tab: 'catalog', sort: 'stars', q: '', page: 1, results: [], count: 0, installed: [], updates: {}, busy: new Set() },
    update: { kind: null, version: null, percent: null },
};

const active = () => S.servers.find((s) => s.id === S.activeId) || null;
const keyOf = (dir) => String(dir || '').trim().replace(/[\\/]+$/, '').toLowerCase();
const isRemote = (server) => server?.kind === 'remote';
const LIVE_STATES = new Set(['starting', 'online', 'stopping']);
/** the process state of one server; 'stopped' when nothing is known */
const runOf = (server) => (server ? S.runs.get(keyOf(server.dir)) : null) || { state: isRemote(server) ? (server.state || 'unknown') : 'stopped' };
const isLive = (server = active()) => Boolean(server) && LIVE_STATES.has(runOf(server).state);
/** the local server holding the one local process slot (a VPS never blocks it) */
const liveServer = () => S.servers.find((s) => !isRemote(s) && isLive(s)) || null;
const anyLive = () => S.servers.some((s) => isLive(s));

function bufOf(dir) {
    const key = keyOf(dir);
    let b = S.bufs.get(key);
    if (!b) {
        b = { dir, lines: [], warn: 0, err: 0, filter: 'all', query: '', autoscroll: true, players: new Map(), maxPlayers: null, expectList: false };
        S.bufs.set(key, b);
    }
    return b;
}
/* the views read the active server's buffer through these */
Object.defineProperty(S, 'con', { get: () => bufOf(active()?.dir || '') });
Object.defineProperty(S, 'players', { get: () => S.con.players, set: (value) => { S.con.players = value; } });
Object.defineProperty(S, 'maxPlayers', { get: () => S.con.maxPlayers, set: (value) => { S.con.maxPlayers = value; } });
Object.defineProperty(S, 'expectList', { get: () => S.con.expectList, set: (value) => { S.con.expectList = value; } });

function statusOf(server) {
    if (!server) return { tone: 'neutral', key: 'ui.state.none' };
    const run = runOf(server);
    if (isRemote(server)) {
        if (run.state === 'offline') return { tone: 'danger', key: 'ui.state.offline' };
        if (run.state === 'unknown') return { tone: 'neutral', key: 'ui.state.connecting', live: true };
    }
    if (!server.hasJar) return { tone: 'danger', key: 'ui.state.missing' };
    if (run.state === 'online') return { tone: 'success', key: 'ui.state.online', live: true };
    if (run.state === 'starting') return { tone: 'warning', key: 'ui.state.starting', live: true };
    if (run.state === 'stopping') return { tone: 'warning', key: 'ui.state.stopping', live: true };
    if (run.crashed) return { tone: 'danger', key: 'ui.state.crashed' };
    return { tone: 'neutral', key: 'ui.state.stopped' };
}
const statusPill = (server) => {
    const st = statusOf(server);
    return pill(st.tone, t(st.key), { live: st.live });
};

/* ── toasts ────────────────────────────────────────────────────────────── */

function toast(message, kind = 'ok', { action, duration } = {}) {
    const zone = $('#toasts');
    const el = h('div', { class: `toast${kind === 'err' ? ' err' : kind === 'info' ? ' info' : ''}`, role: kind === 'err' ? 'alert' : 'status' },
        svg(kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'check'),
        h('span', { class: 'grow', text: message }));
    if (action) {
        el.append(btn({
            label: action.label, variant: 'glow', size: 'xs',
            onClick: (event) => { event.stopPropagation(); leave(); action.run(); },
        }));
    }
    zone.append(el);
    while (zone.childElementCount > 4) zone.firstElementChild.remove();
    let gone = false;
    function leave() {
        if (gone) return;
        gone = true;
        el.classList.add('out');
        setTimeout(() => el.remove(), 180);
    }
    const timer = setTimeout(leave, duration || (action ? 8000 : kind === 'err' ? 6500 : 4200));
    el.addEventListener('click', () => { clearTimeout(timer); leave(); });
}

/** errors from main come back as codes; a person reads sentences */
function errorText(error) {
    const map = {
        'no-server': 'ui.err.noServer',
        running: 'servers.runningFirst',
        'not-running': 'console.notRunning',
        'no-jar': 'toast.noJar',
        'no-releases': 'toast.noVersions',
        invalid: 'ui.err.invalid',
        'not-found': 'ui.err.notFound',
        canceled: 'ui.err.canceled',
        'backup-busy': 'ui.err.backupBusy',
    };
    if (map[error]) return t(map[error]);
    const remoteKey = String(error || '').split(':')[0];
    if (/^(remote-|auth-failed|timeout|key-|hostkey-changed|ssh-missing|no-keychain|no-host)/.test(remoteKey)) {
        const text = t(`ui.rerr.${remoteKey}`);
        if (text !== `ui.rerr.${remoteKey}`) return remoteKey === 'hostkey-changed' ? `${text} ${String(error).split(':').slice(1).join(':')}` : text;
    }
    const text = String(error || '');
    if (/hash-mismatch/.test(text)) return t('ui.err.hash');
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed|EAI_AGAIN/i.test(text)) return t('ui.err.network');
    if (/EBUSY|EPERM|EACCES/i.test(text)) return t('ui.err.locked');
    return text || t('ui.err.unknown');
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast(t('ui.copied'));
    } catch {
        toast(t('ui.err.clipboard'), 'err');
    }
}

/* ── modal: confirm and prompt ─────────────────────────────────────────── */

function openModal({ title, message, input, value, placeholder, ok, danger }) {
    return new Promise((resolve) => {
        const veil = $('#modal');
        const okBtn = $('#modal-ok');
        const cancel = $('#modal-cancel');
        const field = $('#modal-input');
        $('#modal-title').textContent = title;
        $('#modal-text').textContent = message || '';
        field.hidden = !input;
        field.value = value ?? '';
        field.placeholder = placeholder ?? '';
        okBtn.textContent = ok || t('modal.confirm');
        okBtn.className = `btn ${danger ? 'btn-destructive' : 'btn-primary'}`;
        const previous = document.activeElement;
        veil.hidden = false;
        setTimeout(() => (input ? (field.focus(), field.select()) : okBtn.focus()), 20);
        const done = (answer) => {
            veil.hidden = true;
            okBtn.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey, true);
            veil.removeEventListener('mousedown', onVeil);
            previous?.focus?.();
            resolve(answer);
        };
        const onOk = () => {
            if (input && !field.value.trim()) { field.focus(); return; }
            done(input ? field.value.trim() : true);
        };
        const onCancel = () => done(null);
        const onVeil = (event) => { if (event.target === veil) done(null); };
        const onKey = (event) => {
            if (event.key === 'Escape') { event.stopPropagation(); done(null); }
            else if (event.key === 'Enter' && (input ? document.activeElement === field : true)) { event.preventDefault(); onOk(); }
            else if (event.key === 'Tab') {
                const items = [field, cancel, okBtn].filter((el) => !el.hidden);
                const at = items.indexOf(document.activeElement);
                event.preventDefault();
                items[(at + (event.shiftKey ? items.length - 1 : 1)) % items.length].focus();
            }
        };
        okBtn.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey, true);
        veil.addEventListener('mousedown', onVeil);
    });
}
const confirmAsk = (title, message, { ok, danger } = {}) => openModal({ title, message, ok, danger });
const promptAsk = (title, { value, placeholder, ok } = {}) => openModal({ title, input: true, value, placeholder, ok: ok || t('modal.save') });

/* ── popover menus (server switcher, language) ─────────────────────────── */

let openMenuEl = null;
function closeMenu() {
    if (!openMenuEl) return;
    openMenuEl.menu.hidden = true;
    openMenuEl.anchor.setAttribute('aria-expanded', 'false');
    openMenuEl = null;
}
function toggleMenu(anchor, menu, build) {
    if (openMenuEl && openMenuEl.menu === menu) { closeMenu(); return; }
    closeMenu();
    menu.textContent = '';
    build(menu);
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    openMenuEl = { anchor, menu };
    menu.querySelector('.menu-item')?.focus();
}
document.addEventListener('mousedown', (event) => {
    if (openMenuEl && !openMenuEl.menu.contains(event.target) && !openMenuEl.anchor.contains(event.target)) closeMenu();
});

function menuItem({ icon, label, right, on, onClick }) {
    return h('button', { class: `menu-item${on ? ' on' : ''}`, type: 'button', role: 'menuitem', onclick: () => { closeMenu(); onClick(); } },
        icon instanceof Node ? icon : icon ? svg(icon) : null,
        h('span', { class: 'grow', text: label }),
        right || null);
}

/* ── navigation ────────────────────────────────────────────────────────── */

function show(view) {
    if (!VIEWS.includes(view)) view = 'overview';
    if (S.view === 'config' && view !== 'config' && cfg?.dirty()) {
        void confirmAsk(t('ui.config.leaveTitle'), t('ui.config.leaveText'), { ok: t('ui.config.leave'), danger: true }).then((yes) => {
            if (yes) { cfg.reset(); show(view); }
        });
        return;
    }
    S.view = view;
    for (const el of $$('.view')) el.classList.toggle('on', el.id === `view-${view}`);
    for (const item of $$('.nav-item')) {
        if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    }
    moveMarker();
    renderView(view);
    $(`#view-${view}`)?.scrollTo?.(0, 0);
}

function moveMarker() {
    const marker = $('#nav-marker');
    const current = $('.nav-item[aria-current="page"]');
    if (!current) { marker.classList.remove('on'); return; }
    marker.style.translate = `0 ${current.offsetTop}px`;
    marker.style.height = `${current.offsetHeight}px`;
    requestAnimationFrame(() => marker.classList.add('on'));
}

function renderView(view = S.view) {
    switch (view) {
        case 'overview': return renderOverview();
        case 'console': return renderConsoleView();
        case 'players': return renderPlayers();
        case 'plugins': return renderPlugins();
        case 'config': return renderConfig();
        case 'backups': return renderBackups();
        case 'servers': return renderServers();
        case 'create': return renderCreate();
        case 'guide': return renderGuide();
        case 'settings': return renderSettings();
        default: return undefined;
    }
}

/** a server view with no server says so and offers the two ways out */
function noServerState() {
    return emptyState({
        icon: 'server',
        title: t('dash.state.none'),
        body: t('dash.desc.none'),
        actions: [
            btn({ label: t('nav.create'), icon: 'plus', variant: 'primary', onClick: () => show('create') }),
            btn({ label: t('ui.servers.addExisting'), icon: 'folder', variant: 'glow', onClick: addServer }),
        ],
    });
}

/* ── sidebar: switcher, live dot, counts ───────────────────────────────── */

function renderSidebar() {
    const server = active();
    const st = statusOf(server);
    $('#switcher-name').textContent = server ? server.name : t('ui.state.none');
    $('#switcher-sub').textContent = server ? t(st.key) : t('ui.switcher.pick');
    const dot = $('#switcher-dot');
    const color = { success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--destructive)', neutral: 'var(--muted-foreground)' }[st.tone];
    dot.style.background = color;
    dot.classList.toggle('ping', Boolean(st.live));
    const liveDot = $('#nav-live');
    const activeRun = runOf(server).state;
    liveDot.hidden = !isLive(server);
    liveDot.style.background = activeRun === 'online' ? 'var(--success)' : 'var(--warning)';
    liveDot.classList.toggle('ping', isLive(server));
    const players = $('#nav-players');
    players.hidden = !isLive() || S.players.size === 0;
    players.textContent = String(S.players.size);
    players.classList.add('neutral');
    const updates = Object.keys(S.pg.updates).length;
    const badge = $('#nav-plugin-updates');
    badge.hidden = updates === 0;
    badge.textContent = String(updates);
    $('#side-lang-code').textContent = i18n.get().toUpperCase();
    const themeBtn = $('#side-theme');
    themeBtn.textContent = '';
    themeBtn.append(svg(effectiveTheme() === 'dark' ? 'moon' : 'sun'));
    $('#side-version').textContent = S.about ? `v${S.about.app}` : '';
    renderUpdateCard();
}

function buildSwitcherMenu(menu) {
    menu.append(h('p', { class: 'menu-label', text: t('servers.title') }));
    if (!S.servers.length) menu.append(h('p', { class: 'menu-label', text: t('servers.pickEmpty') }));
    for (const server of S.servers) {
        const st = statusOf(server);
        const dot = h('span', { class: 'switcher-dot', style: `background:${{ success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--destructive)', neutral: 'var(--muted-foreground)' }[st.tone]}` });
        menu.append(menuItem({
            icon: dot,
            label: server.name,
            right: server.id === S.activeId ? svg('check') : isRemote(server) ? h('span', { class: 'mono small muted', text: 'VPS' }) : null,
            on: server.id === S.activeId,
            onClick: () => activateServer(server.id),
        }));
    }
    menu.append(h('div', { class: 'menu-sep' }));
    menu.append(menuItem({ icon: 'plus', label: t('nav.create'), onClick: () => show('create') }));
    menu.append(menuItem({ icon: 'folder', label: t('ui.servers.addExisting'), onClick: addServer }));
    menu.append(menuItem({ icon: 'server', label: t('ui.servers.manage'), onClick: () => show('servers') }));
}

function buildLangMenu(menu) {
    for (const lang of i18n.langs()) {
        menu.append(menuItem({
            icon: h('span', { class: 'mono small muted', style: 'width:20px', text: lang.code.toUpperCase() }),
            label: lang.name,
            right: lang.code === i18n.get() ? svg('check') : null,
            on: lang.code === i18n.get(),
            onClick: () => setLanguage(lang.code),
        }));
    }
}

/* ── servers registry ──────────────────────────────────────────────────── */

async function refreshServers() {
    S.servers = (await api.invoke('servers:list')) || [];
    S.activeId = S.servers.find((s) => s.active)?.id ?? S.servers[0]?.id ?? null;
    renderSidebar();
    return active();
}

async function activateServer(id) {
    if (id === S.activeId) return;
    if (cfg.dirty()) {
        const leave = await confirmAsk(t('ui.config.leaveTitle'), t('ui.config.leaveText'), { ok: t('ui.config.leave'), danger: true });
        if (!leave) return;
        cfg.reset();
    }
    const res = await api.invoke('servers:activate', { id });
    if (!res?.ok) { toast(errorText(res?.error), 'err'); return; }
    S.pg.updates = {};
    await refreshServers();
    toast(tr('ui.servers.switched', active()?.name ?? ''), 'info');
    renderView();
    void checkPluginUpdates();
}

async function addServer() {
    const dir = await api.invoke('dialog:pickFolder', { title: t('servers.pickTitle') });
    if (!dir) return;
    const check = await api.invoke('fs:validateDir', dir);
    if (!check?.jar) { toast(t('servers.invalid'), 'err'); return; }
    const res = await api.invoke('servers:add', { dir });
    if (!res?.ok) {
        toast(res?.error === 'dupe' ? t('servers.dupe') : res?.error === 'no-jar' ? t('servers.invalid') : errorText(res?.error), 'err');
        return;
    }
    await refreshServers();
    toast(t('servers.added'));
    show('overview');
}

async function renameServer(server) {
    const name = await promptAsk(t('servers.rename'), { value: server.name, placeholder: t('servers.namePlaceholder') });
    if (!name || name === server.name) return;
    const res = await api.invoke('servers:rename', { id: server.id, name });
    if (!res?.ok) { toast(errorText(res?.error), 'err'); return; }
    await refreshServers();
    toast(t('servers.renamed'));
    renderView();
}

async function removeServer(server) {
    if (isLive(server)) { toast(t('servers.runningFirst'), 'err'); return; }
    const yes = await confirmAsk(t('servers.remove'), tr('servers.removeConfirm', server.name), { ok: t('servers.remove'), danger: true });
    if (!yes) return;
    const res = await api.invoke('servers:remove', { id: server.id });
    if (!res?.ok) { toast(res?.error === 'running' ? t('servers.runningFirst') : errorText(res?.error), 'err'); return; }
    await refreshServers();
    toast(t('servers.removed'));
    renderView();
}

async function uninstallRemote(server) {
    const yes = await confirmAsk(t('ui.remote.uninstall'), tr('ui.remote.uninstallText', server.name, placeOf(server)), { ok: t('ui.remote.uninstall'), danger: true });
    if (!yes) return;
    let res = await api.invoke('remote:uninstall', { id: server.id });
    if (!res?.ok && /sudo/.test(String(res?.error))) {
        const pw = await openModal({ title: t('ui.vps.sudo'), message: t('ui.vps.sudoHint'), input: true, ok: t('ui.remote.uninstall') });
        if (!pw) return;
        res = await api.invoke('remote:uninstall', { id: server.id, sudoPassword: pw });
    }
    if (!res?.ok) { toast(errorText(res?.error), 'err'); return; }
    await refreshServers();
    toast(res.kept ? tr('ui.remote.uninstalledKept', server.name, res.path) : tr('ui.remote.uninstalled', server.name), 'info', res.kept ? { duration: 9000 } : undefined);
    renderView();
}

async function setServerMemory(server, memory) {
    const res = await api.invoke('servers:setMemory', { id: server.id, memory });
    if (!res?.ok) { toast(errorText(res?.error), 'err'); return; }
    await refreshServers();
    toast(isLive(server) ? t('ui.memory.nextStart') : tr('ui.memory.saved', fmtMemory(memory)));
    renderView();
}

/* ── server process: start, stop, restart ──────────────────────────────── */

async function startServer(button) {
    const server = active();
    if (!server) { show('create'); return; }
    const other = liveServer();
    if (other && !isLive(server)) {
        toast(tr('ui.err.otherRunning', other.name), 'err');
        return;
    }
    const run = async () => {
        if (isRemote(server)) pushSys(t('ui.remote.starting'), server.dir);
        const result = await api.invoke('server:start', { dir: server.dir });
        if (!result?.ok) {
            if (result?.error === 'java') {
                toast(`${t('toast.javaNeed')} (${result.raw || '?'})`, 'err', {
                    action: { label: t('ui.java.install'), run: () => api.invoke('shell:openExternal', 'https://adoptium.net/temurin/releases/?version=25') },
                });
            } else if (result?.error === 'running') {
                toast(t('toast.alreadyRunning'), 'info');
            } else if (result?.error === 'no-jar') {
                toast(t('toast.noJar'), 'err');
            } else {
                toast(errorText(result?.message || result?.error), 'err');
            }
            return;
        }
        const run = S.runs.get(keyOf(server.dir));
        if (run) run.crashed = false;
        newSession(server.dir);
        pushSys(tr('ui.console.launch', fmtMemory(result.memory), result.java || 'java'), server.dir);
    };
    if (button) await busy(button, run);
    else await run();
}

async function stopServer(button, { force = false } = {}) {
    const server = active();
    const run = async () => {
        const res = await api.invoke('server:stop', { force, dir: server?.dir });
        if (res?.ok && res.forced && !force) toast(t('ui.stop.forced'), 'err');
        else if (res?.ok && res.graceful) toast(t('ui.stop.done'));
        else if (!res?.ok && res?.error !== 'not-running') toast(errorText(res?.error), 'err');
    };
    if (button) await busy(button, run);
    else await run();
}

async function restartServer(button) {
    const run = async () => {
        const server = active();
        pushSys(t('ui.console.restarting'), server?.dir);
        const res = await api.invoke('server:restart', { dir: server?.dir });
        if (!res?.ok) toast(errorText(res?.error), 'err');
        else toast(t('ui.restarted'));
    };
    if (button) await busy(button, run);
    else await run();
}

/** the actions that fit the server's state, for a page header */
function serverActions(zone, { compact = false } = {}) {
    zone.textContent = '';
    const server = active();
    if (!server) return;
    const size = compact ? 'sm' : undefined;
    if (isRemote(server) && ['offline', 'unknown'].includes(runOf(server).state)) {
        const retry = btn({ label: t('ui.remote.reconnect'), icon: 'refresh', variant: 'outline', size });
        retry.addEventListener('click', () => busy(retry, () => reconnect(server)));
        zone.append(retry);
        return;
    }
    if (!server.hasJar && !isRemote(server)) {
        zone.append(btn({ label: t('ui.servers.locate'), icon: 'folder', variant: 'outline', size, onClick: () => api.invoke('shell:openFolder', { dir: server.dir }) }));
        zone.append(btn({ label: t('nav.create'), icon: 'plus', variant: 'primary', size, onClick: () => show('create') }));
        return;
    }
    const other = isRemote(server) ? null : liveServer();
    if (!isLive(server)) {
        if (!compact && !isRemote(server)) zone.append(btn({ icon: 'folder', title: t('manage.open'), variant: 'outline', onClick: () => api.invoke('shell:openFolder', { dir: server.dir }) }));
        const start = btn({
            label: t('manage.start'), icon: 'play', variant: 'primary', size,
            disabled: Boolean(other),
            title: other ? tr('ui.err.otherRunning', other.name) : undefined,
        });
        start.addEventListener('click', () => startServer(start));
        zone.append(start);
        return;
    }
    if (runOf(server).state === 'stopping') {
        const force = btn({ label: t('ui.stop.force'), icon: 'zap', variant: 'ghost', size, cls: 'danger' });
        force.addEventListener('click', async () => {
            const yes = await confirmAsk(t('ui.stop.force'), t('ui.stop.forceText'), { ok: t('ui.stop.force'), danger: true });
            if (yes) await stopServer(force, { force: true });
        });
        const waiting = btn({ label: t('ui.state.stopping'), icon: 'square', variant: 'destructive', size, disabled: true });
        zone.append(force, waiting);
        return;
    }
    const restart = btn({ label: t('ui.restart'), icon: 'rotate-ccw', variant: 'outline', size, disabled: runOf(server).state !== 'online' });
    restart.addEventListener('click', () => restartServer(restart));
    const stop = btn({ label: t('manage.stop'), icon: 'square', variant: 'destructive', size });
    stop.addEventListener('click', () => stopServer(stop));
    zone.append(restart, stop);
}

/** where a server lives, said the way a person reads it */
function placeOf(server) {
    if (!isRemote(server)) return server.dir;
    const r = server.remote || {};
    return `${r.user}@${r.host}${Number(r.port) && Number(r.port) !== 22 ? `:${r.port}` : ''}:${r.path}`;
}

/**
 * The line under a page title: which server, and how it is. The folder is
 * only spelled out on the overview; elsewhere it is one hover away.
 */
function serverMeta(zone, server = active(), { path = false } = {}) {
    zone.textContent = '';
    if (!server) return;
    zone.append(statusPill(server));
    if (isRemote(server)) zone.append(h('span', { class: 'chip vps' }, svg('globe'), 'VPS'));
    if (path) zone.append(h('span', { class: 'mono small', title: placeOf(server), text: placeOf(server) }));
    else zone.append(h('span', { class: 'meta-name', title: placeOf(server), text: server.name }));
}

async function reconnect(server) {
    await api.invoke('servers:activate', { id: server.id });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const states = await api.invoke('servers:states');
    for (const st of states || []) S.runs.set(keyOf(st.dir), { ...(S.runs.get(keyOf(st.dir)) || {}), ...st });
    const now = runOf(server);
    if (now.state === 'offline') toast(tr('ui.remote.unreachable', server.remote?.host ?? ''), 'err');
    renderSidebar();
    renderView();
}

/** the machine a server runs on: this PC, or the VPS (asked once per view) */
async function sysOf(server) {
    if (!isRemote(server)) return S.sys;
    const key = keyOf(server.dir);
    if (!S.sysBy.has(key)) {
        const info = await api.invoke('system:info', { dir: server.dir });
        if (info && !info.error && info.totalMem) S.sysBy.set(key, info);
    }
    return S.sysBy.get(key) || null;
}

/* ── console buffer: one session per start, parsed once ────────────────── */

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const MC_CODES = /§[0-9a-fk-orx]/gi;
const plain = (text) => String(text).replace(ANSI, '').replace(MC_CODES, '');

const ANSI_COLORS = {
    30: '#5c6370', 31: '#ff6b6b', 32: 'var(--success)', 33: 'var(--warning)', 34: '#6ea8ff', 35: '#c98fff', 36: '#5fd6d6', 37: 'var(--log-ink)',
    90: 'var(--log-dim)', 91: '#ff8a94', 92: 'var(--primary)', 93: '#ffd479', 94: '#8db9ff', 95: '#d9a8ff', 96: '#7fe8e8', 97: 'var(--foreground)',
};
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ansiToHtml(raw) {
    const text = String(raw).replace(MC_CODES, '');
    let html = '';
    let open = 0;
    let last = 0;
    const code = /\u001b\[([0-9;]*)([A-Za-z])/g;
    let match;
    while ((match = code.exec(text))) {
        html += esc(text.slice(last, match.index));
        last = code.lastIndex;
        if (match[2] !== 'm') continue;
        const params = match[1].split(';').filter(Boolean).map(Number);
        if (!params.length || params.includes(0)) {
            html += '</span>'.repeat(open);
            open = 0;
            if (!params.length || params.every((p) => p === 0)) continue;
        }
        let style = '';
        for (let index = 0; index < params.length; index++) {
            const p = params[index];
            if (p === 1) style += 'font-weight:600;';
            else if (p === 2) style += 'opacity:.7;';
            else if (p === 3) style += 'font-style:italic;';
            else if (ANSI_COLORS[p]) style += `color:${ANSI_COLORS[p]};`;
            else if (p === 38 && params[index + 1] === 5) index += 2;
            else if (p === 38 && params[index + 1] === 2) {
                style += `color:rgb(${params[index + 2]},${params[index + 3]},${params[index + 4]});`;
                index += 4;
            }
        }
        if (style) { html += `<span style="${style}">`; open++; }
    }
    html += esc(text.slice(last));
    html += '</span>'.repeat(open);
    return html;
}

function classify(text) {
    if (/\b(ERROR|SEVERE|FATAL|CRITICAL)\b|Exception\b|^\s+at\s+[\w.$]+\(/.test(text)) return 'err';
    if (/\bWARN(ING)?\b/.test(text)) return 'warn';
    return 'info';
}

/** a new start keeps the server's history; the players list starts over */
function newSession(dir) {
    const b = bufOf(dir);
    b.players.clear();
    b.maxPlayers = null;
    b.expectList = false;
}

function pushSys(text, dir = active()?.dir) {
    addLines(dir, [{ raw: `› ${text}`, kind: 'sys' }]);
}

const isActiveDir = (dir) => sameDir(dir, active()?.dir);

function addLines(dir, items) {
    if (!dir) return;
    const b = bufOf(dir);
    const fresh = [];
    let touched = false;
    for (const item of items) {
        const text = plain(item.raw);
        const level = item.kind === 'sys' || item.kind === 'cmd' ? item.kind : classify(text);
        if (level === 'warn') b.warn++;
        if (level === 'err') b.err++;
        if (item.kind !== 'sys' && item.kind !== 'cmd') touched = trackLine(b, text) || touched;
        const line = { raw: item.raw, text, level, at: Date.now() };
        b.lines.push(line);
        fresh.push(line);
    }
    const overflow = b.lines.length - MAX_LINES;
    if (overflow > 0) b.lines.splice(0, overflow);
    if (!isActiveDir(dir)) return;
    if (touched) { renderSidebar(); if (S.view === 'players') renderPlayerList(); }
    if (S.view === 'console') appendConsoleLines(fresh, overflow > 0);
    if (S.view === 'overview') { renderActivity(); renderStats(); }
}

/* players and port, read from what the server actually says */
const JOIN = [/ joined the game\.?$/i, / a rejoint la partie\.?$/i, / ist dem Spiel beigetreten\.?$/i, / entrou no jogo\.?$/i, / se ha unido a la partida\.?$/i];
const LEAVE = [/ left the game\.?$/i, / a quitté la partie\.?$/i, / hat das Spiel verlassen\.?$/i, / saiu do jogo\.?$/i, / ha abandonado la partida\.?$/i];

function nameBefore(text, re) {
    const match = text.match(re);
    if (!match) return null;
    let head = text.slice(0, match.index).trimEnd();
    const cut = Math.max(head.lastIndexOf('] '), head.lastIndexOf(' - '), head.lastIndexOf(': '), head.lastIndexOf('> '));
    if (cut >= 0) head = head.slice(cut + 2);
    head = head.replace(/^[\s\-:>]+/, '').trim();
    return head && head.length <= 32 && !/\s{2,}/.test(head) ? head : null;
}

/** reads one line into its server's buffer; true when the players changed */
function trackLine(b, text) {
    let touched = false;
    if (b.expectList) {
        b.expectList = false;
        const names = text.replace(/^.*?(\]|INFO)\s*[:\-]?\s*/, '').split(/,\s*/).map((n) => n.trim()).filter((n) => n && n.length <= 32);
        b.players = new Map(names.map((n) => [n.toLowerCase(), { name: n, since: b.players.get(n.toLowerCase())?.since ?? null }]));
        touched = true;
    }
    const list = text.match(/(?:There are|Il y a|Es sind|Hay|Há)\D{0,12}(\d+)\s*\/\s*(\d+)/i);
    if (list) {
        b.maxPlayers = Number(list[2]);
        if (Number(list[1]) === 0) b.players.clear();
        else b.expectList = true;
        touched = true;
    }
    for (const re of JOIN) {
        const name = nameBefore(text, re);
        if (name) { b.players.set(name.toLowerCase(), { name, since: Date.now() }); touched = true; break; }
    }
    for (const re of LEAVE) {
        const name = nameBefore(text, re);
        if (name) { b.players.delete(name.toLowerCase()); touched = true; break; }
    }
    const port = text.match(/(?:server on|listening on|running on|bound to|port)\s+[^\s]*?:(\d{2,5})\b/i);
    if (port && b.dir) S.ports.set(keyOf(b.dir), Number(port[1]));
    return touched;
}

function linePasses(line) {
    if (S.con.filter === 'warn' && !(line.level === 'warn' || line.level === 'err')) return false;
    if (S.con.filter === 'err' && line.level !== 'err') return false;
    if (S.con.query && !line.text.toLowerCase().includes(S.con.query)) return false;
    return true;
}

function lineNode(line) {
    const el = h('div', { class: `ln ${line.level}` });
    if (S.con.query) {
        const lower = line.text.toLowerCase();
        let at = 0;
        let html = '';
        for (let hit = lower.indexOf(S.con.query); hit >= 0; hit = lower.indexOf(S.con.query, at)) {
            html += `${esc(line.text.slice(at, hit))}<mark>${esc(line.text.slice(hit, hit + S.con.query.length))}</mark>`;
            at = hit + S.con.query.length;
        }
        el.innerHTML = html + esc(line.text.slice(at));
    } else {
        el.innerHTML = ansiToHtml(line.raw);
    }
    return el;
}

function renderConsoleLines(full) {
    const box = $('#console');
    if (full) {
        box.textContent = '';
        const shown = S.con.lines.filter(linePasses);
        if (!shown.length) {
            box.append(h('p', { class: 'console-empty', text: S.con.lines.length ? t('settings.noResult') : isLive() ? t('ui.console.waiting') : t('console.empty') }));
        } else {
            const frag = document.createDocumentFragment();
            for (const line of shown) frag.append(lineNode(line));
            box.append(frag);
        }
        if (S.con.autoscroll) box.scrollTop = box.scrollHeight;
    }
    $('#con-count-warn').textContent = String(S.con.warn);
    $('#con-count-err').textContent = String(S.con.err);
}

function appendConsoleLines(lines, trimmed) {
    const box = $('#console');
    if (trimmed) { renderConsoleLines(true); return; }
    box.querySelector('.console-empty')?.remove();
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    const frag = document.createDocumentFragment();
    for (const line of lines) if (linePasses(line)) frag.append(lineNode(line));
    box.append(frag);
    while (box.childElementCount > MAX_LINES) box.firstElementChild.remove();
    if (S.con.autoscroll && atBottom) box.scrollTop = box.scrollHeight;
    $('#con-count-warn').textContent = String(S.con.warn);
    $('#con-count-err').textContent = String(S.con.err);
}

/* ── overview ──────────────────────────────────────────────────────────── */

function renderOverview() {
    const server = active();
    $('#ov-page').hidden = !server;
    $('#ov-empty').hidden = Boolean(server);
    if (!server) {
        const zone = $('#ov-empty');
        zone.textContent = '';
        zone.append(emptyState({
            hero: true,
            icon: 'sparkles',
            title: t('ui.welcome.title'),
            body: t('ui.welcome.text'),
            actions: [
                btn({ label: t('nav.create'), icon: 'plus', variant: 'primary', size: 'lg', onClick: () => show('create') }),
                btn({ label: t('ui.servers.addExisting'), icon: 'folder', variant: 'glow', size: 'lg', onClick: addServer }),
            ],
        }));
        zone.append(h('div', { class: 'btn-row', style: 'justify-content:center' },
            btn({ label: t('ui.nav.guide'), icon: 'book-open', variant: 'ghost', onClick: () => show('guide') })));
        return;
    }
    $('#ov-title').textContent = server.name;
    serverMeta($('#ov-meta'), server, { path: true });
    serverActions($('#ov-actions'));
    renderStats();
    renderActivity();
    renderJoin();
    void renderHealth();
}

function serverPort(server = active()) {
    if (!server) return null;
    return S.ports.get(server.dir.toLowerCase()) ?? null;
}

async function loadPort(server = active()) {
    if (!server) return null;
    const res = await api.invoke('config:read', { dir: server.dir });
    const match = res?.ok && typeof res.text === 'string' ? res.text.match(/^\s*(?:server-)?port\s*[:=]\s*["']?(\d{2,5})/m) : null;
    const port = match ? Number(match[1]) : 19132;
    S.ports.set(server.dir.toLowerCase(), port);
    const max = res?.ok ? res.text.match(/^\s*(?:maxPlayers|max-players)\s*[:=]\s*(\d+)/m) : null;
    if (max && !S.maxPlayers) S.maxPlayers = Number(max[1]);
    return port;
}

function renderStats() {
    const server = active();
    if (!server || S.view !== 'overview') return;
    const st = statusOf(server);
    const live = isLive(server);
    const set = (id, text, cls = '') => {
        const el = $(`#${id}`);
        el.textContent = text;
        el.className = `stat-fig ${cls}`;
    };
    set('st-state', t(st.key), st.tone === 'success' ? 'lit' : st.tone === 'danger' ? 'bad' : st.tone === 'warning' ? 'warn' : 'dim');
    const startedAt = runOf(server).startedAt;
    set('st-uptime', live && startedAt ? fmtUptime(Date.now() - startedAt) : '—', live ? '' : 'dim');
    set('st-players', live ? `${S.players.size}${S.maxPlayers ? ` / ${S.maxPlayers}` : ''}` : '—', live ? '' : 'dim');
    set('st-port', String(serverPort(server) ?? '—'));
    set('st-memory', fmtMemory(server.memory));
    const errs = S.con.err;
    const warns = S.con.warn;
    set('st-issues', `${errs} · ${warns}`, errs ? 'bad' : warns ? 'warn' : 'dim');
    $('#st-issues').title = `${t('metrics.errors')}: ${errs} · ${t('metrics.warns')}: ${warns}`;
}

function renderActivity() {
    const zone = $('#ov-log');
    if (!zone || S.view !== 'overview') return;
    const server = active();
    zone.textContent = '';
    const lines = server ? S.con.lines.slice(-14) : [];
    if (!lines.length) {
        zone.append(h('p', { class: 'log-empty', text: isLive(server) ? t('ui.console.waiting') : t('dash.logEmpty') }));
        return;
    }
    for (const line of lines) {
        const el = h('div', { class: `ln ${line.level}` });
        el.innerHTML = ansiToHtml(line.raw);
        zone.append(el);
    }
    zone.scrollTop = zone.scrollHeight;
}

function renderJoin() {
    const zone = $('#ov-addrs');
    zone.textContent = '';
    const port = serverPort() ?? 19132;
    const server = active();
    const outside = $('.ov-join > .card-note');
    if (outside) outside.hidden = isRemote(server);
    if (isRemote(server)) {
        const value = `${server.remote?.host}:${port}`;
        zone.append(h('div', { class: 'addr' },
            h('div', { class: 'addr-main' }, h('span', { class: 'addr-ip', text: value }), h('span', { class: 'addr-label', text: t('ui.join.vps') })),
            btn({ icon: 'copy', title: t('console.copy'), variant: 'ghost', size: 'sm', onClick: () => copyText(value) })));
        zone.append(h('p', { class: 'card-note', text: tr('ui.join.vpsFirewall', port) }));
        zone.append(h('div', { class: 'btn-row', style: 'margin-top:12px' },
            btn({ label: t('ui.join.list'), icon: 'external', variant: 'ghost', size: 'sm', onClick: () => api.invoke('shell:openExternal', 'https://powernukkitx.org/servers/submit') })));
        return;
    }
    const lan = S.sys?.lan || [];
    const rows = lan.length ? lan.slice(0, 3).map((it) => ({ ip: it.address, label: tr('ui.join.lan', it.name) })) : [];
    rows.push({ ip: '127.0.0.1', label: t('ui.join.thisPc') });
    for (const row of rows) {
        const value = `${row.ip}:${port}`;
        zone.append(h('div', { class: 'addr' },
            h('div', { class: 'addr-main' }, h('span', { class: 'addr-ip', text: value }), h('span', { class: 'addr-label', text: row.label })),
            btn({ icon: 'copy', title: t('console.copy'), variant: 'ghost', size: 'sm', onClick: () => copyText(value) })));
    }
    const actions = h('div', { class: 'btn-row', style: 'margin-top:12px' },
        btn({ label: t('ui.join.list'), icon: 'external', variant: 'ghost', size: 'sm', onClick: () => api.invoke('shell:openExternal', 'https://powernukkitx.org/servers/submit') }),
        btn({ label: 'playit.gg', icon: 'external', variant: 'ghost', size: 'sm', onClick: () => api.invoke('shell:openExternal', 'https://playit.gg/') }));
    zone.append(actions);
}

function checkRow({ state, icon, title, desc, action }) {
    return h('li', { class: `check-row ${state}` },
        h('span', { class: 'check-ic' }, svg(state === 'ok' ? 'check' : state === 'bad' ? 'x' : icon || 'alert')),
        h('div', { class: 'check-copy' }, h('span', { class: 'check-title', text: title }), desc ? h('span', { class: 'check-desc', title: desc, text: desc }) : null),
        action || null);
}

async function renderHealth(force = false) {
    const server = active();
    const list = $('#ov-checks');
    if (!server || !list) return;
    if (isRemote(server) && ['offline', 'unknown'].includes(runOf(server).state)) {
        const retry = btn({ label: t('ui.remote.reconnect'), icon: 'refresh', variant: 'outline', size: 'sm' });
        retry.addEventListener('click', () => busy(retry, () => reconnect(server)));
        list.textContent = '';
        list.append(checkRow({
            state: runOf(server).state === 'offline' ? 'bad' : 'warn', icon: 'wifi',
            title: runOf(server).state === 'offline' ? tr('ui.remote.unreachable', server.remote?.host ?? '') : t('ui.state.connecting'),
            desc: t('ui.remote.unreachableDesc'),
        }));
        void retry;
        renderJoin();
        return;
    }
    const port = serverPort(server) ?? await loadPort(server);
    if (S.view !== 'overview') return;
    renderStats();
    renderJoin();
    const rows = [];
    const sys = await sysOf(server);
    if (S.view !== 'overview') return;

    const java = S.java;
    if (isRemote(server)) {
        rows.push(checkRow({ state: 'ok', icon: 'globe', title: tr('ui.remote.connected', server.remote?.host ?? ''), desc: `${server.remote?.os || ''} · systemd ${server.remote?.unit || ''}`.trim() }));
    } else rows.push(java?.ok
        ? checkRow({ state: 'ok', title: tr('onboard.java.ok', java.version), desc: java.vendor && java.vendor !== 'Unknown' ? java.vendor : java.raw })
        : checkRow({
            state: java ? 'bad' : 'warn', title: java ? t('chip.java.bad') : 'Java…', desc: java?.raw && java.raw !== '?' ? java.raw : t('onboard.java.bad'),
            action: btn({ label: t('ui.java.install'), variant: 'outline', size: 'sm', onClick: () => api.invoke('shell:openExternal', 'https://adoptium.net/temurin/releases/?version=25') }),
        }));

    if (isLive(server)) {
        rows.push(checkRow({ state: 'ok', title: tr('ui.health.portOwn', port), desc: t('ui.health.portOwnDesc') }));
    } else {
        if (force || S.health.port?.port !== port || S.health.port?.dir !== server.dir || Date.now() - S.health.checkedAt > 30000) {
            S.health.port = { ...(await api.invoke('net:checkPort', { port, dir: isRemote(server) ? server.dir : undefined })), dir: server.dir };
            S.health.checkedAt = Date.now();
        }
        const res = S.health.port;
        rows.push(res?.free === false
            ? checkRow({ state: 'bad', title: tr('ui.health.portBusy', port), desc: t('ui.health.portBusyDesc') })
            : checkRow({ state: 'ok', title: tr('ui.health.portFree', port), desc: t('ui.health.portFreeDesc') }));
    }

    if (sys) {
        const total = sys.totalMem / 1024 / 1024;
        const want = memMb(server.memory);
        const heavy = want > total * (isRemote(server) ? 0.85 : 0.7);
        rows.push(checkRow({
            state: heavy ? 'warn' : 'ok',
            icon: 'memory',
            title: tr('ui.health.memory', fmtMemory(server.memory), fmtSize(sys.totalMem)),
            desc: heavy ? t('ui.health.memoryHeavy') : tr('ui.health.memoryOk', sys.cpus),
            action: btn({ icon: 'pencil', title: t('ui.memory.change'), variant: 'ghost', size: 'sm', onClick: () => show('servers') }),
        }));
    }

    const stable = S.stable;
    if (stable) {
        const current = server.tag;
        if (current && bare(current) === bare(stable.tag)) {
            rows.push(checkRow({ state: 'ok', title: tr('ui.health.coreOk', bare(current)), desc: t('ui.health.coreOkDesc') }));
        } else {
            const update = btn({ label: t('plugins.update'), icon: 'arrow-up-circle', variant: 'glow', size: 'sm', disabled: isLive(server) });
            update.title = isLive(server) ? t('servers.runningFirst') : '';
            update.addEventListener('click', () => updateCore(update, stable.tag));
            rows.push(checkRow({
                state: 'warn', icon: 'arrow-up-circle',
                title: current ? tr('ui.health.coreOld', bare(current), bare(stable.tag)) : tr('ui.health.coreUnknown', bare(stable.tag)),
                desc: t('ui.health.coreDesc'),
                action: update,
            }));
        }
    }

    const backups = S.backups.get(server.dir.toLowerCase()) ?? await loadBackups(server);
    if (S.view !== 'overview') return;
    const last = backups?.[0];
    const old = !last || Date.now() - new Date(last.date).getTime() > 7 * 86400000;
    const save = btn({ label: t('ui.backup.now'), icon: 'archive', variant: 'outline', size: 'sm', disabled: isLive(server) && runOf(server).state !== 'online' });
    save.addEventListener('click', () => createBackup(save));
    rows.push(checkRow({
        state: old ? 'warn' : 'ok', icon: 'archive',
        title: last ? tr('ui.health.backupLast', relTime(last.date)) : t('ui.health.backupNone'),
        desc: old ? t('ui.health.backupOld') : tr('ui.health.backupCount', backups.length),
        action: old ? save : null,
    }));

    list.textContent = '';
    list.append(...rows);
}

async function updateCore(button, tag) {
    const server = active();
    if (!server) return;
    const yes = await confirmAsk(t('ui.core.title'), tr('ui.core.text', bare(tag)), { ok: t('plugins.update') });
    if (!yes) return;
    await busy(button, async () => {
        const res = await api.invoke('core:update', { dir: server.dir, tag });
        if (!res?.ok) { toast(errorText(res?.error), 'err'); return; }
        await refreshServers();
        toast(tr('ui.core.done', bare(res.tag)));
    });
    renderView();
}

/* ── console view ──────────────────────────────────────────────────────── */

const QUICK = [
    { cmd: 'list', icon: 'users' },
    { cmd: 'status', icon: 'gauge' },
    { cmd: 'save-all', icon: 'save' },
    { cmd: 'time set day', icon: 'sun' },
    { cmd: 'weather clear', icon: 'cloud' },
    { cmd: 'plugins', icon: 'package' },
    { cmd: 'help', icon: 'help' },
];
const SUGGEST = [
    'help', 'list', 'status', 'version', 'plugins', 'say ', 'tell ', 'op ', 'deop ', 'kick ', 'ban ', 'ban-ip ', 'pardon ',
    'whitelist add ', 'whitelist remove ', 'whitelist on', 'whitelist off', 'whitelist list', 'gamemode survival ', 'gamemode creative ',
    'gamerule ', 'difficulty ', 'time set day', 'time set night', 'weather clear', 'weather rain', 'tp ', 'give ', 'kill ',
    'save-all', 'save-on', 'save-off', 'setworldspawn', 'spawnpoint ', 'xp ', 'effect ', 'gc', 'timings on', 'stop',
];

function renderConsoleView() {
    const server = active();
    serverMeta($('#con-meta'), server);
    serverActions($('#con-actions'), { compact: true });
    const live = isLive(server);
    $('#cmd-input').disabled = !live;
    $('#cmd-send').disabled = !live;
    $('#cmd-input').placeholder = live ? t('console.commandPlaceholder') : t('console.notRunning');
    const quick = $('#quick-cmds');
    quick.textContent = '';
    for (const q of QUICK) {
        quick.append(btn({ label: q.cmd, icon: q.icon, variant: 'outline', size: 'xs', disabled: !live, onClick: () => sendCommand(q.cmd) }));
    }
    for (const b of $$('#con-filter .seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.filter === S.con.filter));
    $('#con-autoscroll').setAttribute('aria-pressed', String(S.con.autoscroll));
    $('#con-search').value = S.con.query;
    renderConsoleLines(true);
    const dl = $('#cmd-suggest');
    if (!dl.childElementCount) for (const s of SUGGEST) dl.append(h('option', { value: s }));
}

async function sendCommand(text) {
    const clean = String(text || '').trim();
    if (!clean) return false;
    const server = active();
    const res = await api.invoke('server:command', { text: clean, dir: server?.dir });
    if (!res?.ok) {
        toast(res?.error === 'not-running' ? t('console.notRunning') : errorText(res?.error), 'err');
        return false;
    }
    addLines(server?.dir, [{ raw: `> ${clean.replace(/^\//, '')}`, kind: 'cmd' }]);
    if (/^\/?list\b/i.test(clean)) S.expectList = false;
    if (S.cmdHistory[S.cmdHistory.length - 1] !== clean) S.cmdHistory.push(clean);
    if (S.cmdHistory.length > 80) S.cmdHistory.shift();
    S.cmdIndex = -1;
    return true;
}

function consoleText(lines = S.con.lines) {
    return lines.map((line) => line.text).join('\n');
}

/* ── players ───────────────────────────────────────────────────────────── */

function quoteName(name) {
    return /\s/.test(name) ? `"${name.replace(/"/g, '')}"` : name;
}

const PLAYER_ACTIONS = [
    { id: 'op', icon: 'crown', cmd: (n) => `op ${n}` },
    { id: 'deop', icon: 'user-minus', cmd: (n) => `deop ${n}` },
    { id: 'wladd', icon: 'user-plus', cmd: (n) => `whitelist add ${n}` },
    { id: 'wlremove', icon: 'user-minus', cmd: (n) => `whitelist remove ${n}` },
    { id: 'kick', icon: 'log-out', cmd: (n) => `kick ${n}`, confirm: true },
    { id: 'ban', icon: 'ban', cmd: (n) => `ban ${n}`, confirm: true, danger: true },
    { id: 'pardon', icon: 'shield', cmd: (n) => `pardon ${n}` },
    { id: 'creative', icon: 'sparkles', cmd: (n) => `gamemode creative ${n}` },
];

async function playerAction(action, name) {
    if (!name) { $('#pl-name').focus(); return; }
    if (action.confirm) {
        const yes = await confirmAsk(t(`ui.players.act.${action.id}`), tr('ui.players.confirm', t(`ui.players.act.${action.id}`).toLowerCase(), name), { ok: t(`ui.players.act.${action.id}`), danger: action.danger });
        if (!yes) return;
    }
    const ok = await sendCommand(action.cmd(quoteName(name)));
    if (ok) toast(tr('ui.players.sent', action.cmd(quoteName(name))));
}

function renderPlayers() {
    const server = active();
    const live = isLive(server);
    $('#pl-meta').textContent = '';
    if (server) serverMeta($('#pl-meta'), server);
    $('#pl-refresh').disabled = !live;
    const acts = $('#pl-acts');
    acts.textContent = '';
    for (const action of PLAYER_ACTIONS) {
        acts.append(btn({
            label: t(`ui.players.act.${action.id}`), icon: action.icon, variant: 'outline', size: 'sm', disabled: !live,
            cls: action.danger ? 'danger' : '',
            onClick: () => playerAction(action, $('#pl-name').value.trim()),
        }));
    }
    $('#say-input').disabled = !live;
    $('#say-form button').disabled = !live;
    renderPlayerList();
    if (live && S.view === 'players' && !S.playersAsked) {
        S.playersAsked = true;
        void sendCommand('list');
    }
}

function renderPlayerList() {
    const zone = $('#pl-list');
    if (!zone) return;
    zone.textContent = '';
    const server = active();
    const live = isLive(server);
    $('#pl-count').textContent = live ? `${S.players.size}${S.maxPlayers ? ` / ${S.maxPlayers}` : ''}` : '—';
    if (!server) { zone.append(noServerState()); return; }
    if (!live) {
        zone.append(emptyState({
            compact: true, icon: 'power', title: t('ui.players.offTitle'), body: t('ui.players.offText'),
            actions: server.hasJar ? [btn({ label: t('manage.start'), icon: 'play', variant: 'primary', size: 'sm', disabled: Boolean(liveServer()), onClick: (e) => startServer(e.currentTarget) })] : [],
        }));
        return;
    }
    if (!S.players.size) {
        zone.append(emptyState({ compact: true, icon: 'users', title: t('ui.players.noneTitle'), body: t('ui.players.noneText') }));
        return;
    }
    for (const player of [...S.players.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        zone.append(h('div', { class: 'row' },
            tile(player.name),
            h('div', { class: 'row-main' },
                h('span', { class: 'row-title' }, h('span', { text: player.name })),
                h('span', { class: 'row-sub', text: player.since ? tr('ui.players.since', relTime(player.since)) : t('ui.players.online') })),
            h('div', { class: 'row-acts' },
                btn({ icon: 'pencil', title: t('ui.players.act.pick'), variant: 'ghost', size: 'sm', onClick: () => { $('#pl-name').value = player.name; $('#pl-name').focus(); } }),
                btn({ icon: 'crown', title: t('ui.players.act.op'), variant: 'ghost', size: 'sm', onClick: () => playerAction(PLAYER_ACTIONS[0], player.name) }),
                btn({ icon: 'log-out', title: t('ui.players.act.kick'), variant: 'ghost', size: 'sm', onClick: () => playerAction(PLAYER_ACTIONS[4], player.name) }),
                btn({ icon: 'ban', title: t('ui.players.act.ban'), variant: 'ghost', size: 'sm', cls: 'danger', onClick: () => playerAction(PLAYER_ACTIONS[5], player.name) }))));
    }
}

/* ── plugins ───────────────────────────────────────────────────────────── */

function renderPlugins() {
    const server = active();
    serverMeta($('#pg-meta'), server);
    $('#pg-folder').disabled = !server;
    $('#pg-folder').hidden = isRemote(server);
    selectPluginTab(S.pg.tab, false);
    for (const b of $$('#pg-sort .seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.sort === S.pg.sort));
    void refreshInstalled().then(() => {
        if (S.pg.tab === 'catalog') {
            if (!S.pg.results.length) void searchPlugins();
            else renderCatalog();
        }
    });
}

function selectPluginTab(tab, render = true) {
    S.pg.tab = tab;
    for (const b of $$('#pg-tabs .tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    $('#pg-catalog').hidden = tab !== 'catalog';
    $('#pg-installed').hidden = tab !== 'installed';
    const on = $(`#pg-tabs .tab[data-tab="${tab}"]`);
    const ink = $('#pg-ink');
    requestAnimationFrame(() => {
        ink.style.width = `${on.offsetWidth}px`;
        ink.style.translate = `${on.offsetLeft}px 0`;
    });
    if (render) {
        if (tab === 'installed') renderInstalled();
        else if (!S.pg.results.length) void searchPlugins();
        else renderCatalog();
    }
}

async function refreshInstalled() {
    const server = active();
    if (!server) { S.pg.installed = []; renderInstalledCount(); return; }
    const res = await api.invoke('plugins:installed', { dir: server.dir });
    S.pg.installed = res?.ok ? res.list : [];
    renderInstalledCount();
    if (S.view === 'plugins' && S.pg.tab === 'installed') renderInstalled();
}

function renderInstalledCount() {
    $('#pg-count-installed').textContent = String(S.pg.installed.length);
    const updates = Object.keys(S.pg.updates).length;
    $('#pg-count-installed').classList.toggle('hot', updates > 0);
    $('#pg-update-all').hidden = updates === 0;
    renderSidebar();
}

async function checkPluginUpdates() {
    const server = active();
    if (!server) return;
    const res = await api.invoke('plugins:updates', { dir: server.dir });
    S.pg.updates = res?.ok ? res.updates : {};
    renderInstalledCount();
    if (S.view === 'plugins') { if (S.pg.tab === 'installed') renderInstalled(); else renderCatalog(); }
}

let searchTimer = null;
let searchSeq = 0;
function searchPlugins({ append = false } = {}) {
    clearTimeout(searchTimer);
    const zone = $('#pg-results');
    if (!append) {
        S.pg.page = 1;
        zone.textContent = '';
        for (let index = 0; index < 6; index++) zone.append(h('div', { class: 'plug-skel skeleton' }));
    }
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
        const res = await api.invoke('plugins:search', { q: S.pg.q || undefined, sort: S.pg.sort, limit: 24, page: S.pg.page });
        if (seq !== searchSeq) return;
        if (!res?.ok) {
            zone.textContent = '';
            zone.append(emptyState({
                compact: true, icon: 'wifi', title: t('ui.plugins.offline'), body: errorText(res?.error),
                actions: [btn({ label: t('ui.retry'), icon: 'refresh', variant: 'outline', size: 'sm', onClick: () => searchPlugins() })],
            }));
            return;
        }
        S.pg.results = append ? [...S.pg.results, ...res.plugins] : res.plugins;
        S.pg.count = res.count;
        renderCatalog();
    }, S.pg.q && !append ? 300 : 0);
}

function renderCatalog() {
    const zone = $('#pg-results');
    if (!zone || S.pg.tab !== 'catalog') return;
    zone.textContent = '';
    if (!S.pg.results.length) {
        zone.append(emptyState({ compact: true, icon: 'search', title: t('plugins.empty'), body: S.pg.q ? tr('ui.plugins.noMatch', S.pg.q) : '' }));
        return;
    }
    for (const plugin of S.pg.results) zone.append(pluginCard(plugin));
    if (S.pg.results.length < S.pg.count) {
        const more = btn({ label: t('ui.plugins.more'), variant: 'outline', iconEnd: 'chevron-down' });
        more.addEventListener('click', () => { S.pg.page++; busy(more, async () => searchPlugins({ append: true })); });
        zone.append(h('div', { class: 'more-row', style: 'grid-column:1/-1' }, more));
    }
}

function pluginCard(plugin) {
    const mine = S.pg.installed.find((it) => it.slug === plugin.slug);
    const update = mine && S.pg.updates[plugin.slug];
    let action;
    if (S.pg.busy.has(plugin.slug)) {
        action = btn({ label: t('plugins.installing'), variant: 'outline', size: 'sm', disabled: true });
        action.dataset.slug = plugin.slug;
    } else if (update) {
        action = btn({ label: tr('ui.plugins.updateTo', update), icon: 'arrow-up-circle', variant: 'glow', size: 'sm' });
        action.addEventListener('click', () => installPlugin(plugin.slug, action));
    } else if (mine) {
        action = btn({ label: mine.enabled ? t('ui.plugins.added') : t('ui.plugins.disabled'), icon: 'check', variant: 'ghost', size: 'sm', disabled: true });
    } else {
        action = btn({ label: t('plugins.install'), icon: 'download', variant: 'outline', size: 'sm', disabled: !active() });
        action.addEventListener('click', () => installPlugin(plugin.slug, action));
    }
    action.dataset.slug = plugin.slug;
    const card = h('article', { class: 'plug-card' },
        h('div', { class: 'plug-top' },
            tile(plugin.name, true),
            h('div', { class: 'plug-id' },
                h('p', { class: 'plug-name', title: plugin.name, text: plugin.name }),
                h('p', { class: 'plug-author', text: [plugin.author ? tr('ui.plugins.by', plugin.author) : plugin.slug, plugin.version ? `v${bare(plugin.version)}` : ''].filter(Boolean).join(' · ') })),
            btn({ icon: 'external', title: t('ui.plugins.hub'), variant: 'ghost', size: 'xs', onClick: () => api.invoke('shell:openExternal', `https://powernukkitx.org/plugins/${encodeURIComponent(plugin.slug)}`) })),
        h('p', { class: 'plug-desc', text: plugin.description || t('ui.plugins.noDesc') }),
        h('div', { class: 'plug-foot' },
            h('span', { class: 'plug-stat', title: t('ui.plugins.stars') }, svg('star'), fmtNum(plugin.stars)),
            h('span', { class: 'plug-stat', title: t('ui.plugins.downloads') }, svg('download'), fmtNum(plugin.downloads)),
            h('span', { class: 'grow' }),
            action));
    card.addEventListener('pointermove', (event) => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
        card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    });
    return card;
}

function renderInstalled() {
    const zone = $('#pg-mine');
    zone.textContent = '';
    const server = active();
    if (!server) { zone.append(noServerState()); return; }
    if (!S.pg.installed.length) {
        zone.append(emptyState({
            compact: true, icon: 'package', title: t('ui.plugins.noneTitle'), body: t('ui.plugins.noneText'),
            actions: [btn({ label: t('plugins.marketplace'), variant: 'glow', size: 'sm', onClick: () => selectPluginTab('catalog') })],
        }));
        return;
    }
    for (const plugin of S.pg.installed) {
        const update = plugin.slug && S.pg.updates[plugin.slug];
        const toggle = h('label', { class: 'switch', title: plugin.enabled ? t('ui.plugins.disable') : t('ui.plugins.enable') },
            h('input', { type: 'checkbox', checked: plugin.enabled ? true : null, onchange: (event) => togglePlugin(plugin, event.target.checked, event.target) }),
            h('i'));
        const acts = h('div', { class: 'row-acts' });
        if (update) {
            const up = btn({ label: `v${update}`, icon: 'arrow-up-circle', variant: 'glow', size: 'sm' });
            up.addEventListener('click', () => installPlugin(plugin.slug, up));
            acts.append(up);
        }
        acts.append(toggle, btn({ icon: 'trash', title: t('plugins.remove'), variant: 'ghost', size: 'sm', cls: 'danger', onClick: () => removePlugin(plugin) }));
        zone.append(h('div', { class: `row${plugin.enabled ? '' : ' disabled'}` },
            tile(plugin.name),
            h('div', { class: 'row-main' },
                h('span', { class: 'row-title' },
                    h('span', { text: plugin.name }),
                    plugin.version ? h('span', { class: 'chip mono', text: `v${bare(plugin.version)}` }) : h('span', { class: 'chip', text: t('ui.plugins.manual') }),
                    plugin.enabled ? null : pill('neutral', t('ui.plugins.disabled'))),
                h('span', { class: 'row-sub mono', text: `${plugin.jarName} · ${fmtSize(plugin.size)}` })),
            acts));
    }
}

function restartHint(res) {
    if (res?.needsRestart) {
        toast(t('ui.plugins.restartNeeded'), 'info', { action: { label: t('ui.restart'), run: () => restartServer() } });
    }
}

async function installPlugin(slug, button) {
    const server = active();
    if (!server) { toast(t('plugins.needsServer'), 'err'); return; }
    S.pg.busy.add(slug);
    if (button) { button.disabled = true; button.textContent = t('plugins.installing'); }
    const res = await api.invoke('plugins:install', { slug, dir: server.dir });
    S.pg.busy.delete(slug);
    if (res?.ok) {
        toast(tr('ui.plugins.installed', res.entry?.name || slug, server.name));
        delete S.pg.updates[slug];
        restartHint(res);
    } else {
        toast(res?.error === 'no-server' ? t('plugins.needsServer') : errorText(res?.error), 'err');
    }
    await refreshInstalled();
    if (S.view === 'plugins') { if (S.pg.tab === 'catalog') renderCatalog(); else renderInstalled(); }
}

async function togglePlugin(plugin, enabled, input) {
    input.disabled = true;
    const res = await api.invoke('plugins:toggle', { dir: active()?.dir, fileName: plugin.fileName, enabled });
    if (!res?.ok) { toast(errorText(res?.error), 'err'); input.checked = !enabled; }
    else { toast(enabled ? tr('ui.plugins.enabledToast', plugin.name) : tr('ui.plugins.disabledToast', plugin.name)); restartHint(res); }
    await refreshInstalled();
}

async function removePlugin(plugin) {
    const yes = await confirmAsk(t('plugins.remove'), tr('ui.plugins.removeConfirm', plugin.name), { ok: t('plugins.remove'), danger: true });
    if (!yes) return;
    const res = await api.invoke('plugins:remove', { dir: active()?.dir, fileName: plugin.fileName });
    if (res?.ok) { toast(t('toast.pluginRemoved')); restartHint(res); }
    else toast(errorText(res?.error), 'err');
    if (plugin.slug) delete S.pg.updates[plugin.slug];
    await refreshInstalled();
}

async function updateAllPlugins(button) {
    await busy(button, async () => {
        for (const slug of Object.keys(S.pg.updates)) await installPlugin(slug, null);
    });
}

/* ── config: pnx.yml (or server.properties) as labelled controls ───────── */

const SERVER_LANGS = ['eng', 'fra', 'spa', 'deu', 'por', 'ita', 'rus', 'chs', 'cht', 'jpn', 'kor', 'tur', 'pol', 'ukr'];
const CFG_LABELS = {
    motd: 'cfg.motd', 'sub-motd': 'cfg.submotd', port: 'cfg.port', 'server-port': 'cfg.port', maxPlayers: 'cfg.maxPlayers', 'max-players': 'cfg.maxPlayers',
    defaultLevelName: 'cfg.defaultLevelName', 'level-name': 'cfg.defaultLevelName', allowList: 'cfg.allowList', 'white-list': 'cfg.allowList',
    viewDistance: 'cfg.viewDistance', 'view-distance': 'cfg.viewDistance', xboxAuth: 'cfg.xboxAuth', 'xbox-auth': 'cfg.xboxAuth',
    safeSpawn: 'cfg.safeSpawn', autoSave: 'cfg.autoSave', 'auto-save': 'cfg.autoSave', savePlayerData: 'cfg.savePlayerData',
    checkMovement: 'cfg.checkMovement', enableCommandBlocks: 'cfg.enableCommandBlocks', allowBeta: 'cfg.allowBeta',
    gamemode: 'ui.cfg.gamemode', difficulty: 'ui.cfg.difficulty', pvp: 'ui.cfg.pvp', language: 'ui.cfg.language', hardcore: 'ui.cfg.hardcore',
    'spawn-protection': 'ui.cfg.spawnProtection', spawnProtection: 'ui.cfg.spawnProtection', forceGamemode: 'ui.cfg.forceGamemode',
};
const CFG_ESSENTIAL = new Set([
    'motd', 'sub-motd', 'port', 'server-port', 'maxPlayers', 'max-players', 'defaultLevelName', 'level-name', 'allowList', 'white-list',
    'viewDistance', 'view-distance', 'xboxAuth', 'xbox-auth', 'gamemode', 'difficulty', 'pvp', 'language',
]);
const CFG_ENUMS = {
    gamemode: ['0', '1', '2', '3', 'survival', 'creative', 'adventure', 'spectator'],
    difficulty: ['0', '1', '2', '3', 'peaceful', 'easy', 'normal', 'hard'],
};
const CFG_SECTION_LABELS = { settings: 'cfg.sec.settings', 'player-settings': 'cfg.sec.player', 'gameplay-settings': 'cfg.sec.gameplay' };

/** reads the file into editable entries; the raw text stays the only truth */
function parseConfig(text, which) {
    const sep = which === 'server.properties' ? '=' : ':';
    const lines = text.split('\n');
    const entries = [];
    const stack = [];
    let comments = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].replace(/\r$/, '');
        const trimmed = line.trim();
        if (!trimmed) { comments = []; continue; }
        if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('!')) { comments.push(trimmed.replace(/^(#|\/\/|!)\s?/, '')); continue; }
        if (trimmed.startsWith('- ')) { comments = []; continue; }
        const at = line.indexOf(sep);
        if (at <= 0) { comments = []; continue; }
        const indent = (line.match(/^(\s*)/)?.[1] ?? '').length;
        const key = line.slice(0, at).trim();
        let rest = line.slice(at + 1);
        if (sep === ':') {
            const depth = Math.floor(indent / 2);
            stack.length = depth;
            if (!rest.trim() && /^[ \t]+\S/.test(lines[index + 1] ?? '')) {
                stack.push(key);
                comments = [];
                continue;
            }
        }
        let comment = '';
        let value = rest.trim();
        const quote = sep === ':' && (value.startsWith('"') || value.startsWith("'")) ? value[0] : '';
        if (sep === ':' && !quote) {
            const hash = value.search(/\s#/);
            if (hash >= 0) { comment = value.slice(hash); value = value.slice(0, hash).trimEnd(); }
        } else if (quote) {
            const close = findClosingQuote(value, quote);
            if (close > 0) { comment = value.slice(close + 1); value = value.slice(0, close + 1); }
        }
        entries.push({
            index, key, sep, quote, raw: value, comment,
            path: sep === ':' ? [...stack, key] : [key],
            value: unquote(value, quote),
            help: comments.join(' '),
        });
        comments = [];
    }
    return { lines, entries };
}

function findClosingQuote(value, quote) {
    for (let index = 1; index < value.length; index++) {
        if (quote === '"' && value[index] === '\\') { index++; continue; }
        if (value[index] === quote) {
            if (quote === "'" && value[index + 1] === "'") { index++; continue; }
            return index;
        }
    }
    return -1;
}

function unquote(raw, quote) {
    if (!quote || raw.length < 2 || !raw.endsWith(quote)) return raw;
    const inner = raw.slice(1, -1);
    return quote === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, '$1');
}

function serialize(value, entry, which) {
    const text = String(value);
    if (which === 'server.properties') return text;
    if (entry.quote === "'") return `'${text.replace(/'/g, "''")}'`;
    if (entry.quote === '"') return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const numericNow = /^-?\d+(\.\d+)?$/.test(text) && !/^-?\d+(\.\d+)?$/.test(entry.value);
    if (numericNow || text === '' || /^[\s{}[\]#&*!,>|%@`'"-]/.test(text) || /:\s|\s#|:$/.test(text) || /^(true|false|yes|no|null|~)$/i.test(text) !== /^(true|false)$/i.test(text)) {
        return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return text;
}

const cfg = {
    data: null, // { dir, which, path, lines, entries }
    dirty() { return Boolean(this.data?.entries.some((e) => e.next !== undefined && e.next !== e.value)); },
    count() { return this.data?.entries.filter((e) => e.next !== undefined && e.next !== e.value).length ?? 0; },
    reset() { for (const e of this.data?.entries || []) delete e.next; },
};

async function renderConfig() {
    const server = active();
    const body = $('#cfg-body');
    const empty = $('#cfg-empty');
    $('#cfg-meta').textContent = '';
    $('#cfg-open').disabled = !server;
    $('#cfg-open').hidden = isRemote(server);
    if (!server) {
        body.hidden = true;
        empty.hidden = false;
        empty.textContent = '';
        empty.append(noServerState());
        updateSavebar();
        return;
    }
    if (cfg.data && sameDir(cfg.data.dir, server.dir) && cfg.dirty()) {
        drawConfig();
        return;
    }
    const res = await api.invoke('config:read', { dir: server.dir });
    if (!res?.ok || !res.text) {
        cfg.data = null;
        body.hidden = true;
        empty.hidden = false;
        empty.textContent = '';
        empty.append(emptyState({
            icon: 'file-text', title: t('ui.config.noFileTitle'), body: res?.ok ? t('config.noFile') : errorText(res?.error),
            actions: server.hasJar && !isLive(server) ? [btn({ label: t('manage.start'), icon: 'play', variant: 'primary', disabled: Boolean(liveServer()), onClick: (e) => startServer(e.currentTarget) })] : [],
        }));
        updateSavebar();
        return;
    }
    const parsed = parseConfig(res.text, res.which);
    cfg.data = { dir: res.dir || server.dir, which: res.which, path: res.path, ...parsed };
    drawConfig();
}

function drawConfig() {
    const data = cfg.data;
    $('#cfg-body').hidden = false;
    $('#cfg-empty').hidden = true;
    const meta = $('#cfg-meta');
    meta.textContent = '';
    meta.append(h('span', { class: 'chip mono', text: data.which }), h('span', { class: 'mono small', title: data.path, text: data.path }));
    const essential = data.entries.filter((e) => CFG_ESSENTIAL.has(e.key));
    const advanced = data.entries.filter((e) => !CFG_ESSENTIAL.has(e.key));
    drawConfigGroups(essential, $('#cfg-essential'));
    drawConfigGroups(advanced, $('#cfg-advanced'));
    applyConfigSearch();
    updateSavebar();
}

function prettyKey(key) {
    return key.replace(/[-_]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^(.)/, (m) => m.toUpperCase());
}

function drawConfigGroups(entries, zone) {
    zone.textContent = '';
    const groups = new Map();
    for (const entry of entries) {
        const section = entry.path.length > 1 ? entry.path[0] : '';
        if (!groups.has(section)) groups.set(section, []);
        groups.get(section).push(entry);
    }
    const order = ['', 'settings', 'player-settings', 'gameplay-settings'];
    const keys = [...groups.keys()].sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    for (const key of keys) {
        const card = h('div', { class: 'card cfg-card' });
        if (key) card.append(h('p', { class: 'cfg-card-title', text: CFG_SECTION_LABELS[key] ? t(CFG_SECTION_LABELS[key]) : prettyKey(key) }));
        for (const entry of groups.get(key)) card.append(configRow(entry));
        zone.append(card);
    }
}

function configRow(entry) {
    const label = CFG_LABELS[entry.key] ? t(CFG_LABELS[entry.key]) : prettyKey(entry.key);
    const current = entry.next ?? entry.value;
    const row = h('div', { class: `cfg-row${entry.next !== undefined && entry.next !== entry.value ? ' changed' : ''}`, dataset: { search: `${label} ${entry.path.join('.')} ${entry.help}`.toLowerCase() } },
        h('div', { class: 'cfg-copy' },
            h('span', { class: 'cfg-label', text: label }),
            h('span', { class: 'cfg-key', title: entry.path.join('.'), text: entry.path.join('.') }),
            entry.help ? h('span', { class: 'cfg-hint', text: entry.help.slice(0, 160) }) : null));
    const set = (value) => {
        entry.next = value;
        row.classList.toggle('changed', entry.next !== entry.value);
        updateSavebar();
    };
    let control;
    const raw = entry.value;
    const locked = /^[[{]/.test(entry.raw) || /^(config|debug-settings)$/.test(entry.path[0] || '') || /^&|^\*/.test(entry.raw);
    if (!entry.quote && /^(true|false)$/i.test(raw)) {
        const input = h('input', { type: 'checkbox', checked: /^true$/i.test(current) ? true : null, onchange: (event) => set(event.target.checked ? 'true' : 'false') });
        control = h('label', { class: 'switch' }, input, h('i'));
    } else if (entry.key === 'language' && SERVER_LANGS.includes(raw)) {
        control = h('select', { class: 'select', onchange: (event) => set(event.target.value) },
            SERVER_LANGS.map((code) => h('option', { value: code, selected: code === current ? true : null, text: code })));
    } else if (CFG_ENUMS[entry.key] && CFG_ENUMS[entry.key].includes(String(raw).toLowerCase())) {
        const numeric = /^\d$/.test(raw);
        const opts = CFG_ENUMS[entry.key].filter((v) => /^\d$/.test(v) === numeric);
        control = h('select', { class: 'select', onchange: (event) => set(event.target.value) },
            opts.map((v) => h('option', { value: v, selected: v === String(current).toLowerCase() ? true : null, text: numeric ? `${v} · ${t(`ui.cfg.${entry.key}.${v}`)}` : t(`ui.cfg.${entry.key}.${v}`) })));
    } else if (!entry.quote && /^-?\d+(\.\d+)?$/.test(raw) && !locked) {
        control = h('input', { class: 'input', type: 'number', step: /\./.test(raw) ? 'any' : '1', value: current, onchange: (event) => set(event.target.value.trim() || raw) });
    } else if (locked) {
        control = h('input', { class: 'input mono', type: 'text', value: entry.raw, readonly: true, title: t('config.locked') });
    } else {
        control = h('input', { class: 'input', type: 'text', value: current, spellcheck: 'false', oninput: (event) => set(event.target.value) });
    }
    row.append(h('div', { class: 'cfg-ctl' }, control));
    return row;
}

function applyConfigSearch() {
    const q = ($('#cfg-search').value || '').trim().toLowerCase();
    let total = 0;
    for (const zone of [$('#cfg-essential'), $('#cfg-advanced')]) {
        let visibleInZone = 0;
        for (const card of zone.children) {
            let visible = 0;
            for (const row of card.querySelectorAll('.cfg-row')) {
                const hit = !q || row.dataset.search.includes(q);
                row.hidden = !hit;
                if (hit) visible++;
            }
            card.hidden = visible === 0;
            visibleInZone += visible;
        }
        zone.hidden = visibleInZone === 0;
        total += visibleInZone;
    }
    $('#cfg-ess-title').hidden = $('#cfg-essential').hidden;
    $('#cfg-adv-title').hidden = $('#cfg-advanced').hidden;
    $('#cfg-none').hidden = total > 0;
}

function updateSavebar() {
    const n = cfg.count();
    $('#cfg-savebar').hidden = n === 0 || S.view !== 'config';
    $('#cfg-dirty-text').textContent = tr(n > 1 ? 'ui.config.dirtyMany' : 'ui.config.dirtyOne', n);
}

async function saveConfig(button) {
    const data = cfg.data;
    if (!data) return;
    const lines = [...data.lines];
    for (const entry of data.entries) {
        if (entry.next === undefined || entry.next === entry.value) continue;
        const line = lines[entry.index];
        const at = line.indexOf(entry.sep);
        const head = line.slice(0, at + 1);
        const gap = line.slice(at + 1).match(/^\s*/)?.[0] ?? (entry.sep === ':' ? ' ' : '');
        lines[entry.index] = `${head}${gap || (entry.sep === ':' ? ' ' : '')}${serialize(entry.next, entry, data.which)}${entry.comment ? ` ${entry.comment.trim()}` : ''}`.replace(/\s+$/, '');
    }
    await busy(button, async () => {
        const res = await api.invoke('config:write', { dir: data.dir, which: data.which, text: lines.join('\n') });
        if (!res?.ok) { toast(errorText(res?.error), 'err'); return; }
        cfg.data = null;
        S.ports.delete(data.dir.toLowerCase());
        toast(t('config.saved'), 'ok', isLive() ? { action: { label: t('ui.restart'), run: () => restartServer() } } : {});
        await renderConfig();
    });
}

/* ── backups ───────────────────────────────────────────────────────────── */

async function loadBackups(server = active()) {
    if (!server) return [];
    const res = await api.invoke('backup:list', { dir: server.dir });
    const list = res?.ok ? res.backups : [];
    S.backups.set(server.dir.toLowerCase(), list);
    return list;
}

async function renderBackups() {
    const server = active();
    const zone = $('#bk-list');
    $('#bk-meta').textContent = '';
    const live = isLive(server);
    const hotOk = live && runOf(server).state === 'online';
    $('#bk-create').disabled = !server || (live && !hotOk);
    $('#bk-create').title = hotOk ? t('ui.backup.hotHint') : live ? t('ui.backup.stopFirst') : '';
    $('#bk-auto').hidden = !server;
    if (server) renderAutomation(server);
    $('#bk-folder').disabled = !server;
    $('#bk-folder').hidden = isRemote(server);
    if (!server) { zone.textContent = ''; zone.append(noServerState()); return; }
    serverMeta($('#bk-meta'), server);
    void live; // hot backups need no warning any more: the description says it
    const list = await loadBackups(server);
    if (S.view !== 'backups') return;
    zone.textContent = '';
    if (!list.length) {
        zone.append(emptyState({
            icon: 'archive', title: t('backups.empty'), body: t('ui.backup.emptyText'),
            actions: [btn({ label: t('backups.create'), icon: 'plus', variant: 'primary', disabled: live && !hotOk, onClick: (e) => createBackup(e.currentTarget) })],
        }));
        return;
    }
    const total = list.reduce((sum, b) => sum + (b.size || 0), 0);
    $('#bk-meta').append(h('span', { class: 'small', text: tr('ui.backup.total', list.length, fmtSize(total)) }));
    const card = h('div', { class: 'card card-flush' });
    const rows = h('div', { class: 'rows' });
    for (const backup of list) {
        const restore = btn({ label: t('backups.restore'), icon: 'rotate-ccw', variant: 'outline', size: 'sm', disabled: live });
        restore.addEventListener('click', () => restoreBackup(backup, restore));
        rows.append(h('div', { class: 'row' },
            h('span', { class: 'row-ic' }, svg('archive')),
            h('div', { class: 'row-main' },
                h('span', { class: 'row-title' }, h('span', { text: fmtDate(backup.date) }), backup.auto ? h('span', { class: 'chip', text: t('ui.auto.chip') }) : null),
                h('span', { class: 'row-sub mono', text: `${relTime(backup.date)} · ${backup.name}` })),
            h('span', { class: 'row-meta', text: fmtSize(backup.size) }),
            h('div', { class: 'row-acts' },
                restore,
                btn({ icon: 'trash', title: t('backups.delete'), variant: 'ghost', size: 'sm', cls: 'danger', onClick: () => deleteBackup(backup) }))));
    }
    card.append(rows);
    zone.append(card);
}

async function createBackup(button) {
    const server = active();
    if (!server) return;
    if (isLive(server) && runOf(server).state !== 'online') { toast(t('ui.backup.stopFirst'), 'err'); return; }
    await busy(button, async () => {
        const res = await api.invoke('backup:create', { dir: server.dir });
        if (res?.ok) toast(tr(res.hot ? 'ui.backup.hotDone' : 'backups.created', fmtSize(res.size)));
        else toast(res?.error === 'running' ? t('ui.backup.stopFirst') : errorText(res?.error), 'err');
    });
    await loadBackups(server);
    renderView();
}

/* ── automation: backups on a timer, a daily restart ─────────────────── */

const AUTO_EVERY = [0, 1, 2, 3, 6, 12, 24];
const AUTO_KEEP = [3, 5, 10, 20, 50];

function scheduleOf(server) {
    const sch = server?.schedule || {};
    return {
        backupEvery: AUTO_EVERY.includes(Number(sch.backupEvery)) ? Number(sch.backupEvery) : 0,
        keep: AUTO_KEEP.includes(Number(sch.keep)) ? Number(sch.keep) : 10,
        restartAt: typeof sch.restartAt === 'string' ? sch.restartAt : null,
        warn: sch.warn !== false,
        lastAuto: sch.lastAuto || null,
    };
}

function renderAutomation(server) {
    const sch = scheduleOf(server);
    const every = $('#auto-every');
    every.textContent = '';
    for (const hours of AUTO_EVERY) {
        every.append(h('option', { value: String(hours), selected: hours === sch.backupEvery ? true : null, text: hours ? tr(hours === 1 ? 'ui.auto.everyOne' : 'ui.auto.everyN', hours) : t('ui.auto.off') }));
    }
    const keep = $('#auto-keep');
    keep.textContent = '';
    for (const n of AUTO_KEEP) keep.append(h('option', { value: String(n), selected: n === sch.keep ? true : null, text: tr('ui.auto.keepN', n) }));
    keep.disabled = !sch.backupEvery;
    $('#auto-restart-on').checked = Boolean(sch.restartAt);
    $('#auto-restart-at').value = sch.restartAt || $('#auto-restart-at').value || '05:00';
    $('#auto-restart-at').disabled = !sch.restartAt;
    $('#auto-warn').checked = sch.warn;
    $('#auto-warn').disabled = !sch.restartAt;
    const next = $('#bk-auto-next');
    if (sch.backupEvery) {
        const due = (Date.parse(sch.lastAuto || '') || Date.now()) + sch.backupEvery * 3600 * 1000;
        next.hidden = false;
        next.textContent = isLive(server) ? tr('ui.auto.next', relTime(Math.max(due, Date.now() + 60000))) : t('ui.auto.paused');
    } else {
        next.hidden = true;
    }
    $('#bk-auto-note').textContent = isRemote(server) ? t('ui.auto.noteRemote') : t('ui.auto.noteLocal');
}

async function saveAutomation() {
    const server = active();
    if (!server) return;
    const schedule = {
        backupEvery: Number($('#auto-every').value) || 0,
        keep: Number($('#auto-keep').value) || 10,
        restartAt: $('#auto-restart-on').checked ? ($('#auto-restart-at').value || '05:00') : null,
        warn: $('#auto-warn').checked,
    };
    const res = await api.invoke('servers:setSchedule', { id: server.id, schedule });
    if (!res?.ok) { toast(errorText(res?.error), 'err'); return; }
    S.servers = S.servers.map((s) => (s.id === server.id ? { ...s, schedule: res.schedule } : s));
    renderAutomation(active());
    toast(t('ui.auto.saved'));
}

async function restoreBackup(backup, button) {
    const yes = await confirmAsk(t('backups.restore'), `${t('backups.restoreConfirm')}\n\n${fmtDate(backup.date)}`, { ok: t('backups.restore'), danger: true });
    if (!yes) return;
    await busy(button, async () => {
        const res = await api.invoke('backup:restore', { dir: active()?.dir, name: backup.name });
        if (res?.ok) toast(t('backups.restored'));
        else toast(errorText(res?.error), 'err');
    });
}

async function deleteBackup(backup) {
    const yes = await confirmAsk(t('backups.delete'), `${t('backups.deleteConfirm')}\n\n${fmtDate(backup.date)} · ${fmtSize(backup.size)}`, { ok: t('backups.delete'), danger: true });
    if (!yes) return;
    const res = await api.invoke('backup:delete', { dir: active()?.dir, name: backup.name });
    if (res?.ok) toast(t('backups.deleted'));
    else toast(errorText(res?.error), 'err');
    renderBackups();
}

/* ── servers view ──────────────────────────────────────────────────────── */

function renderServers() {
    const grid = $('#sv-grid');
    grid.textContent = '';
    if (!S.servers.length) { grid.append(h('div', { style: 'grid-column:1/-1' }, noServerState())); return; }
    for (const server of S.servers) {
        const isActive = server.id === S.activeId;
        const mem = h('select', { class: 'select', title: t('manage.memory'), 'aria-label': t('manage.memory'), onchange: (event) => setServerMemory(server, event.target.value) },
            MEMORY_OPTIONS.map((m) => h('option', { value: m, selected: m === server.memory ? true : null, text: fmtMemory(m) })));
        const foot = h('div', { class: 'srv-foot' },
            isActive
                ? btn({ label: t('ui.nav.overview'), icon: 'layout-dashboard', variant: 'glow', size: 'sm', onClick: () => show('overview') })
                : btn({ label: t('ui.servers.activate'), icon: 'check', variant: 'outline', size: 'sm', onClick: () => activateServer(server.id) }),
            h('span', { class: 'grow' }),
            isRemote(server) ? null : btn({ icon: 'folder', title: t('manage.open'), variant: 'ghost', size: 'sm', onClick: () => api.invoke('shell:openFolder', { dir: server.dir }) }),
            btn({ icon: 'pencil', title: t('servers.rename'), variant: 'ghost', size: 'sm', onClick: () => renameServer(server) }),
            isRemote(server) ? btn({ icon: 'power', title: t('ui.remote.uninstall'), variant: 'ghost', size: 'sm', cls: 'danger', onClick: () => uninstallRemote(server) }) : null,
            btn({ icon: 'trash', title: isRemote(server) ? t('ui.remote.forget') : t('servers.remove'), variant: 'ghost', size: 'sm', cls: 'danger', disabled: isLive(server), onClick: () => removeServer(server) }));
        grid.append(h('article', { class: `card srv-card${isActive ? ' card-lit' : ''}` },
            isActive ? h('span', { class: 'lui-hairline', dataset: { tone: 'brand' } }) : null,
            h('div', { class: 'srv-top' },
                tile(server.name, true),
                h('div', { class: 'srv-id' },
                    h('p', { class: 'srv-name', text: server.name }),
                    h('p', { class: 'srv-dir', title: placeOf(server), text: placeOf(server) })),
                statusPill(server)),
            h('div', { class: 'srv-facts' },
                isRemote(server) ? h('span', { class: 'chip vps', title: server.remote?.os || '' }, svg('globe'), `VPS · ${server.remote?.host ?? ''}`) : null,
                h('span', { class: 'chip mono', title: 'PowerNukkitX' }, svg('package'), server.tag ? bare(server.tag) : '?'),
                isActive ? pill('brand', t('ui.servers.active'), { dot: false }) : null,
                h('span', { class: 'grow' }),
                mem),
            foot));
    }
}

/* ── create view ───────────────────────────────────────────────────────── */

const create = {
    tag: null, memory: null, busy: false, done: null, target: 'local', auth: 'password', probe: null,
    vpsParent: '/opt/pnx', vpsPathEdited: false, pathCheck: null,
};

/** Same rule as the installer on the VPS: the folder name it would pick. */
function slugify(name) {
    const slug = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    return slug || 'server';
}

/** Folders a VPS server may go in, offered as one-click starts. */
const VPS_BASES = ['/opt/pnx', '/srv/pnx'];

function vpsBase(base) {
    const user = $('#vps-user').value.trim() || 'root';
    return base.replace('{user}', user);
}

function defaultVpsPath() {
    return `/opt/pnx/${slugify($('#cr-name').value.trim() || 'server')}`;
}

/** Keeps the VPS folder in step with the name until the user edits it. */
function syncVpsPath() {
    const input = $('#vps-path');
    if (!create.vpsPathEdited) input.value = `${create.vpsParent}/${slugify($('#cr-name').value.trim() || 'server')}`;
    renderVpsPresets();
    void checkVpsPath();
}

function renderVpsPresets() {
    const zone = $('#vps-presets');
    zone.textContent = '';
    const current = $('#vps-path').value.trim().replace(/\/[^/]*$/, '');
    const user = $('#vps-user').value.trim() || 'root';
    for (const base of VPS_BASES) {
        if (base.includes('{user}') && user === 'root') continue;
        const parent = vpsBase(base);
        zone.append(h('button', {
            class: 'preset mono', type: 'button', 'aria-pressed': String(current === parent),
            onclick: () => {
                create.vpsParent = parent;
                create.vpsPathEdited = false;
                syncVpsPath();
            },
        }, `${parent}/`, base === '/opt/pnx' ? h('span', { class: 'tag', text: t('ui.vpsdir.recommended') }) : null));
    }
}

const PATH_ERRORS = ['path-empty', 'path-relative', 'path-chars', 'path-shallow', 'path-system'];
let pathTimer = null;
/** Says, as the user types, whether the folder can take the server. */
function checkVpsPath() {
    clearTimeout(pathTimer);
    return new Promise((resolve) => {
        pathTimer = setTimeout(async () => {
            const hint = $('#vps-path-hint');
            const path = $('#vps-path').value.trim();
            const form = create.probe ? { ...vpsForm(), hostKey: create.probe.fingerprint } : {};
            const res = await api.invoke('remote:checkPath', { form, path });
            create.pathCheck = res;
            hint.classList.remove('warn', 'bad', 'ok');
            if (!res?.ok && PATH_ERRORS.includes(res?.error)) {
                hint.textContent = t(`ui.vpsdir.${res.error}`);
                hint.classList.add('bad');
            } else if (res?.state === 'full' || res?.state === 'file' || res?.state === 'private') {
                hint.textContent = t(`ui.vpsdir.state.${res.state}`);
                hint.classList.add('bad');
            } else if (res?.state === 'new' || res?.state === 'empty' || res?.state === 'locked') {
                hint.textContent = t(`ui.vpsdir.state.${res.state}`);
                hint.classList.add('ok');
            } else {
                hint.textContent = t('ui.vpsdir.state.unknown');
            }
            renderSummary();
            resolve(res);
        }, 250);
    });
}

/* ── the VPS folder browser ─────────────────────────────────────────────── */

function browseVps() {
    return new Promise((resolve) => {
        const veil = $('#browse');
        const list = $('#browse-list');
        const leaf = slugify($('#cr-name').value.trim() || 'server');
        const typed = $('#vps-path').value.trim();
        let current = typed ? typed.replace(/\/[^/]*$/, '') || '/' : '/opt';
        const form = { ...vpsForm(), hostKey: create.probe?.fingerprint };
        const target = () => `${current === '/' ? '' : current}/${leaf}`;
        const paint = (dirs, error) => {
            const crumbs = $('#browse-crumbs');
            crumbs.textContent = '';
            const parts = current.split('/').filter(Boolean);
            crumbs.append(h('button', { class: 'crumb', type: 'button', onclick: () => go('/') }, '/'));
            parts.forEach((part, index) => {
                const path = `/${parts.slice(0, index + 1).join('/')}`;
                if (index > 0) crumbs.append(h('span', { class: 'crumb-sep', text: '/' }));
                crumbs.append(h('button', { class: 'crumb', type: 'button', onclick: () => go(path) }, part));
            });
            list.textContent = '';
            if (error) list.append(h('li', { class: 'browse-empty bad', text: errorText(error) }));
            else if (!dirs.length) list.append(h('li', { class: 'browse-empty', text: t('ui.vpsdir.noSub') }));
            for (const dir of dirs) {
                list.append(h('li', {}, h('button', { class: 'browse-item', type: 'button', onclick: () => go(`${current === '/' ? '' : current}/${dir}`) },
                    svg('folder-closed'), h('span', { class: 'mono', text: dir }), svg('chevron-right'))));
            }
            $('#browse-result').textContent = target();
            const check = api.invoke('remote:checkPath', { form, path: target() });
            check.then((res) => {
                const ok = res?.ok;
                $('#browse-ok').disabled = !ok;
                $('#browse-result').classList.toggle('bad', !ok);
                $('#browse-result').title = ok ? '' : (PATH_ERRORS.includes(res?.error) ? t(`ui.vpsdir.${res.error}`) : t(`ui.vpsdir.state.${res?.state}`));
            });
            $('#browse-up').disabled = current === '/';
        };
        const go = async (path) => {
            list.textContent = '';
            list.append(h('li', { class: 'browse-empty', text: t('ui.vpsdir.loading') }));
            const res = await api.invoke('remote:browse', { form, path });
            if (res?.ok) { current = res.path; paint(res.dirs); } else paint([], res?.error);
        };
        const done = (value) => {
            veil.hidden = true;
            document.removeEventListener('keydown', onKey, true);
            $('#browse-ok').onclick = null;
            $('#browse-cancel').onclick = null;
            $('#browse-up').onclick = null;
            veil.onmousedown = null;
            resolve(value);
        };
        const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); done(null); } };
        $('#browse-ok').onclick = () => done(target());
        $('#browse-cancel').onclick = () => done(null);
        $('#browse-up').onclick = () => go(current.replace(/\/[^/]*$/, '') || '/');
        veil.onmousedown = (event) => { if (event.target === veil) done(null); };
        document.addEventListener('keydown', onKey, true);
        veil.hidden = false;
        void go(current);
    });
}

async function pickVpsPath() {
    const form = vpsForm();
    const missing = vpsMissing(form);
    if (missing) { $(`#${missing}`).focus(); toast(t('ui.vps.fillFirst'), 'err'); return; }
    if (!create.probe && !(await testVps($('#vps-test')))) return;
    const picked = await browseVps();
    if (!picked) return;
    $('#vps-path').value = picked;
    create.vpsPathEdited = true;
    renderVpsPresets();
    void checkVpsPath();
}

/* ── the summary beside the form ────────────────────────────────────────── */

function renderSummary() {
    const remote = create.target === 'remote';
    const list = $('#cr-summary-list');
    if (!list) return;
    const form = vpsForm();
    const name = $('#cr-name').value.trim();
    const where = remote ? (form.host ? `${form.user}@${form.host}` : '') : t('ui.create.local');
    const folder = remote ? $('#vps-path').value.trim() : $('#cr-dir').value.trim();
    const rows = [
        ['ui.create.sumWhere', where, remote ? 'globe' : 'hard-drive'],
        ['ui.create.sumName', name || (remote ? form.host : '') || t('ui.create.namePlaceholder'), 'server', !name],
        ['ui.create.sumFolder', folder, 'folder'],
        ['ui.create.sumVersion', create.tag ? bare(create.tag) : '', 'package'],
        ['ui.create.sumMemory', create.memory ? fmtMemory(create.memory) : '', 'memory'],
    ];
    list.textContent = '';
    // a long path keeps its end, where the folder's own name is
    const tail = (text, max) => (text.length > max ? `…${text.slice(text.length - max + 1)}` : text);
    for (const [key, value, icon, placeholder] of rows) {
        const isPath = key === 'ui.create.sumFolder';
        list.append(h('div', { class: 'sum-row' },
            h('dt', {}, svg(icon), t(key)),
            h('dd', { class: `${value && !placeholder ? '' : 'is-empty'} ${isPath ? 'mono' : ''}`, title: value || '', text: value ? (isPath ? tail(value, 28) : value) : '—' })));
    }
    const note = $('#cr-summary-note');
    note.classList.remove('warn');
    if (remote && !form.host) note.textContent = t('ui.create.noteHost');
    else if (remote && !create.probe) note.textContent = t('ui.create.noteTest');
    else if (remote && create.probe?.blocked) { note.textContent = errorText(`remote-${create.probe.blocked}`); note.classList.add('warn'); }
    else if (remote && create.pathCheck && !create.pathCheck.ok) { note.textContent = t('ui.create.notePath'); note.classList.add('warn'); }
    else note.textContent = t(remote ? 'ui.create.noteRemote' : 'ui.create.noteLocal');
    $('#cr-submit-label').textContent = t(remote ? 'ui.vps.install' : 'create.cta');
}

function renumberSteps() {
    const remote = create.target === 'remote';
    $('#view-create [data-step="server"]').textContent = remote ? '3' : '2';
    $('#view-create [data-step="build"]').textContent = remote ? '4' : '3';
}

/* ── create on a VPS: the SSH form, its test, the install ───────────────── */

function vpsForm() {
    const auth = create.auth;
    return {
        host: $('#vps-host').value.trim(),
        port: Number($('#vps-port').value) || 22,
        user: $('#vps-user').value.trim() || 'root',
        auth,
        password: auth === 'password' ? $('#vps-password').value : undefined,
        keyPath: auth === 'key' ? $('#vps-key').value.trim() : undefined,
        passphrase: auth === 'key' ? $('#vps-passphrase').value || undefined : undefined,
        sudoPassword: auth === 'key' ? $('#vps-sudo').value || undefined : undefined,
    };
}

function renderTarget() {
    const remote = create.target === 'remote';
    for (const b of $$('#cr-target .host-tile')) b.setAttribute('aria-pressed', String(b.dataset.target === create.target));
    $('#cr-vps').hidden = !remote;
    $('#cr-dir-field').hidden = remote;
    $('#cr-vpsdir-field').hidden = !remote;
    if (remote && !$('#vps-path').value.trim()) syncVpsPath();
    if (remote) renderVpsPresets();
    renumberSteps();
    for (const b of $$('#vps-auth .seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.auth === create.auth));
    const key = create.auth === 'key';
    $('#vps-password-field').hidden = key;
    $('#vps-key-field').hidden = !key;
    $('#vps-passphrase-field').hidden = !key;
    $('#vps-sudo-field').hidden = !key || $('#vps-user').value.trim() === 'root' || !$('#vps-user').value.trim();
    renderMemoryChoices();
    renderSummary();
}

function vpsMissing(form) {
    if (!form.host) return 'vps-host';
    if (form.auth === 'password' && !form.password) return 'vps-password';
    if (form.auth === 'key' && !form.keyPath) return 'vps-key';
    return null;
}

async function testVps(button) {
    const form = vpsForm();
    const missing = vpsMissing(form);
    if (missing) { $(`#${missing}`).focus(); toast(t('ui.vps.fillFirst'), 'err'); return null; }
    const list = $('#vps-checks');
    const res = await busy(button, () => api.invoke('remote:probe', form));
    list.hidden = false;
    list.textContent = '';
    if (!res?.ok) {
        create.probe = null;
        list.append(checkRow({ state: 'bad', icon: 'wifi', title: t('ui.vps.failed'), desc: errorText(res?.error) }));
        renderMemoryChoices();
        renderSummary();
        return null;
    }
    const info = res.info;
    create.probe = info;
    const gb = (bytes) => fmtSize(bytes);
    list.append(
        checkRow({ state: 'ok', icon: 'globe', title: tr('ui.vps.connected', form.host), desc: tr('ui.vps.fingerprint', info.fingerprint) }),
        checkRow({ state: info.supportedArch ? 'ok' : 'bad', icon: 'cpu', title: `${info.os} · ${info.arch}`, desc: tr('ui.vps.machine', gb(info.totalMem), info.cpus, gb(info.disk)) }),
        checkRow({ state: info.systemd ? 'ok' : 'bad', icon: 'server', title: info.systemd ? t('ui.vps.systemdOk') : t('ui.vps.systemdNo'), desc: info.servers ? tr('ui.vps.existing', info.servers) : '' }),
        checkRow({
            state: ['root', 'nopass', 'password'].includes(info.sudo) ? 'ok' : 'bad', icon: 'shield',
            title: t(`ui.vps.sudo.${info.sudo}`), desc: info.sudo === 'pass' ? t('ui.vps.sudoHint') : '',
        }),
        checkRow({ state: info.jre ? 'ok' : 'warn', icon: 'download', title: info.jre ? t('ui.vps.jreOk') : t('ui.vps.jreNo'), desc: t('ui.vps.jreDesc') }),
    );
    if (info.totalMem && info.totalMem < 1.5 * 1024 ** 3) {
        list.append(checkRow({ state: 'warn', icon: 'memory', title: t('ui.vps.lowMem'), desc: t('ui.health.memoryHeavy') }));
    }
    renderMemoryChoices();
    void checkVpsPath();
    return info;
}

async function runCreateRemote(submit) {
    const form = vpsForm();
    const missing = vpsMissing(form);
    if (missing) { $(`#${missing}`).focus(); toast(t('ui.vps.fillFirst'), 'err'); return; }
    const info = create.probe || await testVps($('#vps-test'));
    if (!info) return;
    if (info.blocked) { toast(errorText(`remote-${info.blocked}`), 'err'); return; }
    const name = $('#cr-name').value.trim() || form.host;
    const path = $('#vps-path').value.trim() || defaultVpsPath();
    const check = await checkVpsPath();
    if (check && !check.ok) {
        $('#vps-path').focus();
        toast(PATH_ERRORS.includes(check.error) ? t(`ui.vpsdir.${check.error}`) : t(`ui.vpsdir.state.${check.state}`), 'err');
        return;
    }
    const yes = await confirmAsk(t('ui.vps.confirmTitle'), `${tr('ui.vps.confirmText', name, `${form.user}@${form.host}`, info.os, fmtMemory(create.memory))}\n\n${tr('ui.vpsdir.confirm', check?.path || path)}`, { ok: t('ui.vps.install') });
    if (!yes) return;
    create.busy = true;
    $('#cr-log-card').hidden = false;
    $('#cr-log').textContent = '';
    $('#cr-done').hidden = true;
    $('#cr-progress').hidden = false;
    $('#cr-progress-fill').classList.add('indeterminate');
    const result = await busy(submit, () => api.invoke('remote:create', {
        ...form, hostKey: info.fingerprint, tag: create.tag, memory: create.memory, name, path: check?.path || path,
    }));
    create.busy = false;
    $('#cr-progress-fill').classList.remove('indeterminate');
    if (!result?.ok) {
        $('#cr-progress').hidden = true;
        createLog({ line: errorText(result?.error), kind: 'error' });
        toast(errorText(result?.error), 'err');
        return;
    }
    $('#cr-progress-fill').style.width = '100%';
    create.done = result;
    create.probe = null;
    $('#vps-password').value = '';
    $('#vps-passphrase').value = '';
    $('#vps-sudo').value = '';
    $('#vps-checks').hidden = true;
    await refreshServers();
    $('#cr-done').hidden = false;
    $('#cr-open').hidden = true;
    $('#cr-done-line').textContent = tr('ui.vps.done', bare(result.tag), form.host);
    $('#cr-name').value = '';
    $('#vps-path').value = '';
    create.vpsPathEdited = false;
    create.vpsParent = '/opt/pnx';
    create.pathCheck = null;
    renderSummary();
    toast(tr('ui.create.toast', result.entry?.name ?? form.host));
    if (result.firewall === 'none') toast(t('ui.vps.firewallNote'), 'info', { duration: 9000 });
    markGuide(2);
}

async function renderCreate() {
    if (!create.memory) create.memory = S.prefs.memory || '2G';
    if (!create.tag && S.stable) create.tag = S.stable.tag;
    const dirInput = $('#cr-dir');
    if (!dirInput.value && !create.busy) {
        dirInput.value = await api.invoke('fs:suggestDir', {});
        void validateCreateDir();
    }
    renderVersionChoices();
    renderTarget();
    $('#cr-name').placeholder = t('ui.create.namePlaceholder');
    renderSummary();
}

function renderVersionChoices() {
    const zone = $('#cr-versions');
    zone.textContent = '';
    if (!S.releases.length) {
        zone.append(h('span', { class: 'chip', text: S.releasesError ? t('create.versions.empty') : t('create.versions.loading') }));
        if (S.releasesError) zone.append(btn({ label: t('ui.retry'), icon: 'refresh', variant: 'ghost', size: 'sm', onClick: () => loadReleases(true) }));
        return;
    }
    const ranked = [...S.releases.filter((r) => !r.prerelease).slice(0, 6), ...S.releases.filter((r) => r.prerelease).slice(0, 2)];
    for (const release of ranked) {
        zone.append(h('button', {
            class: 'choice mono', type: 'button', 'aria-pressed': String(create.tag === release.tag),
            title: `${fmtSize(release.size)}${release.publishedAt ? ` · ${fmtDate(release.publishedAt)}` : ''}`,
            onclick: () => { create.tag = release.tag; renderVersionChoices(); renderSummary(); },
        }, bare(release.tag),
        release.latest ? h('span', { class: 'tag', text: t('ui.create.latest') }) : null,
        release.prerelease ? h('span', { class: 'tag pre', text: t('ui.create.pre') }) : null));
    }
}

function renderMemoryChoices() {
    const zone = $('#cr-memory');
    zone.textContent = '';
    zone.className = 'choice-list';
    const machine = create.target === 'remote' ? create.probe : S.sys;
    const totalMb = machine?.totalMem ? machine.totalMem / 1024 / 1024 : Infinity;
    for (const mem of MEMORY_OPTIONS) {
        const tooBig = memMb(mem) > totalMb * 0.85;
        zone.append(h('button', {
            class: 'choice mono', type: 'button', 'aria-pressed': String(create.memory === mem), disabled: tooBig ? true : null,
            title: tooBig ? t('ui.health.memoryHeavy') : null,
            onclick: () => { create.memory = mem; renderMemoryChoices(); renderSummary(); },
        }, fmtMemory(mem)));
    }
    const hint = $('#cr-memory-hint');
    hint.textContent = machine?.totalMem ? tr(create.target === 'remote' ? 'ui.vps.memoryHint' : 'ui.create.memoryHint', fmtSize(machine.totalMem)) : t('create.memory.hint');
    hint.classList.toggle('warn', machine?.totalMem ? memMb(create.memory) > totalMb * 0.6 : false);
    if (machine?.totalMem && memMb(create.memory) > totalMb * 0.85) {
        create.memory = [...MEMORY_OPTIONS].reverse().find((m) => memMb(m) <= totalMb * 0.6) || '1G';
        renderMemoryChoices();
    }
}

let dirTimer = null;
async function validateCreateDir() {
    clearTimeout(dirTimer);
    dirTimer = setTimeout(async () => {
        const dir = $('#cr-dir').value.trim();
        const hint = $('#cr-dir-hint');
        hint.classList.remove('warn');
        if (!dir) { hint.textContent = t('ui.create.dirHint'); return; }
        const check = await api.invoke('fs:validateDir', dir);
        if (check?.jar) { hint.textContent = t('ui.create.dirHasServer'); hint.classList.add('warn'); }
        else if (check?.exists && !check.empty) { hint.textContent = t('ui.create.dirNotEmpty'); hint.classList.add('warn'); }
        else hint.textContent = check?.exists ? t('ui.create.dirEmpty') : t('ui.create.dirNew');
        renderSummary();
    }, 220);
}

async function pickCreateDir() {
    const picked = await api.invoke('dialog:pickFolder', { title: t('create.dirpick.title') });
    if (!picked) return;
    $('#cr-dir').value = await api.invoke('fs:suggestDir', { base: picked });
    void validateCreateDir();
}

function createLog(payload) {
    const zone = $('#cr-log');
    zone.querySelector('.log-empty')?.remove();
    const text = payload.key ? tr(payload.key, ...(payload.params || [])) : String(payload.line || '');
    const kind = payload.kind || 'info';
    const glyph = kind === 'ok' ? '✓' : kind === 'error' ? '✕' : kind === 'warn' ? '!' : kind === 'dim' ? ' ' : '›';
    zone.append(h('div', { class: `ln ${kind === 'error' ? 'err' : kind === 'warn' ? 'warn' : kind === 'ok' ? 'sys' : ''}`, text: `${glyph} ${text}` }));
    zone.scrollTop = zone.scrollHeight;
}

async function runCreate(event) {
    event?.preventDefault();
    if (create.busy) return;
    if (create.target === 'remote') { await runCreateRemote($('#cr-submit')); return; }
    $('#cr-open').hidden = false;
    const dir = $('#cr-dir').value.trim();
    if (!dir) { toast(t('toast.dirFirst'), 'err'); $('#cr-dir').focus(); return; }
    const check = await api.invoke('fs:validateDir', dir);
    if (check?.jar) {
        const add = await confirmAsk(t('toast.serverExists'), t('ui.create.addInstead'), { ok: t('ui.servers.addExisting') });
        if (add) {
            const res = await api.invoke('servers:add', { dir, name: $('#cr-name').value.trim() || undefined });
            if (res?.ok) { await refreshServers(); show('overview'); } else toast(errorText(res?.error), 'err');
        }
        return;
    }
    create.busy = true;
    const submit = $('#cr-submit');
    $('#cr-log-card').hidden = false;
    $('#cr-log').textContent = '';
    $('#cr-done').hidden = true;
    $('#cr-progress').hidden = false;
    $('#cr-progress-fill').style.width = '0%';
    $('#cr-progress-fill').classList.remove('indeterminate');
    $('#cr-progress-chip').hidden = false;
    $('#cr-progress-chip').textContent = '0 %';
    const result = await busy(submit, () => api.invoke('server:create', {
        dir, tag: create.tag, memory: create.memory, name: $('#cr-name').value.trim() || undefined,
    }));
    create.busy = false;
    $('#cr-progress-chip').hidden = true;
    if (!result?.ok) {
        $('#cr-progress').hidden = true;
        if (result?.error === 'exists') { createLog({ key: 'create.log.exists', kind: 'error' }); toast(t('toast.serverExists'), 'err'); }
        else if (result?.error === 'no-releases') { createLog({ key: 'toast.noVersions', kind: 'error' }); toast(t('toast.noVersions'), 'err'); }
        else toast(errorText(result?.message || result?.error), 'err');
        return;
    }
    $('#cr-progress-fill').classList.remove('indeterminate');
    $('#cr-progress-fill').style.width = '100%';
    create.done = result;
    await refreshServers();
    $('#cr-done').hidden = false;
    $('#cr-done-line').textContent = tr('ui.create.done', bare(result.tag), fmtSize(result.size));
    $('#cr-dir').value = '';
    $('#cr-name').value = '';
    renderSummary();
    toast(tr('ui.create.toast', result.entry?.name ?? result.dir));
    markGuide(2);
}

/* ── guide ─────────────────────────────────────────────────────────────── */

const GUIDE_TOTAL = 7;
function markGuide(index) {
    if (S.tutorialDone.includes(index)) return;
    S.tutorialDone.push(index);
    void api.invoke('state:set', { tutorialDone: [...S.tutorialDone] });
    if (S.view === 'guide') renderGuide();
}

function renderGuide() {
    const list = $('#guide-steps');
    list.textContent = '';
    for (let index = 0; index < GUIDE_TOTAL; index++) {
        const done = S.tutorialDone.includes(index);
        const action = btn({ label: t(`tuto.${index + 1}.action`), variant: done ? 'ghost' : 'outline', size: 'sm', iconEnd: 'chevron-right' });
        action.addEventListener('click', () => runGuide(index, action));
        list.append(h('li', { class: `card g-step${done ? ' done' : ''}` },
            h('span', { class: 'g-num' }, done ? svg('check') : String(index + 1)),
            h('div', { class: 'g-body' },
                h('h2', { class: 'g-title', text: t(`tuto.${index + 1}.title`) }),
                h('p', { class: 'g-text', text: t(`tuto.${index + 1}.text`) })),
            action));
    }
    const count = S.tutorialDone.length;
    $('#guide-fill').style.width = `${Math.round((count / GUIDE_TOTAL) * 100)}%`;
    $('#guide-count').textContent = `${count}/${GUIDE_TOTAL}`;
    $('#guide-reset').hidden = count === 0;
}

async function runGuide(index, button) {
    switch (index) {
        case 0:
            await api.invoke('shell:openExternal', 'https://powernukkitx.org/');
            markGuide(0);
            break;
        case 1:
            await busy(button, async () => {
                S.java = await api.invoke('java:check');
                renderJavaPill();
            });
            if (S.java?.ok) { toast(`Java ${S.java.version} (${S.java.vendor}) — ${t('tuto.2.java-ok')}`); markGuide(1); }
            else {
                toast(`${t('tuto.2.java-bad')} ${tr('tuto.2.java-old', S.java?.raw ?? '?')}`, 'err', {
                    action: { label: t('ui.java.install'), run: () => api.invoke('shell:openExternal', 'https://adoptium.net/temurin/releases/?version=25') },
                });
            }
            break;
        case 2:
            show('create');
            break;
        case 3:
            if (!active()) { toast(t('toast.noServerYet'), 'err'); show('create'); break; }
            show('console');
            if (!isLive()) await startServer();
            markGuide(3);
            break;
        case 4:
            if (!active()) { toast(t('toast.noServerYet'), 'err'); break; }
            show('config');
            markGuide(4);
            break;
        case 5:
            show('plugins');
            markGuide(5);
            break;
        case 6:
            show('overview');
            markGuide(6);
            break;
        default:
            break;
    }
    if (S.view === 'guide') renderGuide();
}

/* ── settings ──────────────────────────────────────────────────────────── */

function effectiveTheme() {
    if (S.prefs.theme === 'light' || S.prefs.theme === 'dark') return S.prefs.theme;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyPrefs() {
    const root = document.documentElement;
    root.classList.toggle('light', effectiveTheme() === 'light');
    root.classList.toggle('compact', S.prefs.density === 'compact');
    root.classList.toggle('no-motion', S.prefs.motionOff === true);
    root.dataset.accent = S.prefs.accent || 'grass';
    void api.invoke('app:theme');
}

async function persistPrefs(patch) {
    Object.assign(S.prefs, patch);
    applyPrefs();
    await api.invoke('state:set', patch);
    renderSidebar();
}

function segRow(zone, options, current, pick) {
    zone.textContent = '';
    for (const option of options) {
        zone.append(h('button', {
            class: 'seg-btn', type: 'button', 'aria-pressed': String(option.value === current),
            onclick: () => { if (option.value !== current) pick(option.value); },
        }, option.icon ? svg(option.icon) : null, option.label));
    }
}

function renderSettings() {
    const lang = $('#set-lang');
    lang.textContent = '';
    for (const it of i18n.langs()) lang.append(h('option', { value: it.code, selected: it.code === i18n.get() ? true : null, text: it.name }));
    segRow($('#set-theme'), [
        { value: 'system', label: t('theme.system') },
        { value: 'dark', label: t('theme.dark'), icon: 'moon' },
        { value: 'light', label: t('theme.light'), icon: 'sun' },
    ], S.prefs.theme, (value) => persistPrefs({ theme: value }).then(renderSettings));
    segRow($('#set-density'), [
        { value: 'comfortable', label: t('density.comfortable') },
        { value: 'compact', label: t('density.compact') },
    ], S.prefs.density, (value) => persistPrefs({ density: value }).then(() => { renderSettings(); moveMarker(); }));
    const sw = $('#set-accent');
    sw.textContent = '';
    for (const accent of ACCENTS) {
        sw.append(h('button', {
            class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(S.prefs.accent === accent.id),
            title: t(`ui.accent.${accent.id}`), 'aria-label': t(`ui.accent.${accent.id}`),
            style: `--h:${accent.h};--c:${accent.c}`,
            onclick: () => persistPrefs({ accent: accent.id }).then(renderSettings),
        }));
    }
    const mem = $('#set-memory');
    mem.textContent = '';
    for (const m of MEMORY_OPTIONS) mem.append(h('option', { value: m, selected: m === S.prefs.memory ? true : null, text: fmtMemory(m) }));
    $('#set-confirm-quit').checked = S.prefs.confirmQuit !== false;
    $('#set-motion').checked = S.prefs.motionOff === true;
    $('#set-auto-restart').checked = S.prefs.autoRestart === true;
    $('#set-notify').checked = S.prefs.notify !== false;
    $('#set-notify-joins').checked = S.prefs.notifyJoins === true;
    $('#set-notify-joins').disabled = S.prefs.notify === false;
    $('#set-update-auto').checked = S.prefs.updateAuto !== false;
    $('#set-update-bg').checked = S.prefs.updateBg === true;
    $('#set-app-version').textContent = S.about ? `v${S.about.app}` : '—';
    $('#about-versions').textContent = S.about
        ? `App v${S.about.app} · CLI v${S.about.cli} · Electron ${S.about.electron} · Node ${S.about.node} · ${S.about.platform}`
        : t('about.loading');
    const links = $('#about-links');
    links.textContent = '';
    for (const [label, url] of [
        [t('about.links.site'), 'https://powernukkitx.org/'],
        [t('about.links.docs'), 'https://powernukkitx.org/docs'],
        [t('nav.plugins'), 'https://powernukkitx.org/plugins'],
        [t('about.links.github'), 'https://github.com/PowerNukkitX/PowerNukkitX'],
    ]) links.append(btn({ label, icon: 'external', variant: 'ghost', size: 'sm', onClick: () => api.invoke('shell:openExternal', url) }));
    applySettingsSearch();
}

function applySettingsSearch() {
    const q = ($('#set-search').value || '').trim().toLowerCase();
    let total = 0;
    for (const card of $$('.set-card')) {
        let visible = 0;
        const rows = card.querySelectorAll('.set-row');
        if (!rows.length) {
            const hit = !q || card.textContent.toLowerCase().includes(q);
            card.hidden = !hit;
            total += hit ? 1 : 0;
            continue;
        }
        for (const row of rows) {
            const hit = !q || row.textContent.toLowerCase().includes(q);
            row.hidden = !hit;
            if (hit) visible++;
        }
        card.hidden = visible === 0;
        total += visible;
    }
    $('#set-none').hidden = total > 0;
}

async function setLanguage(code) {
    if (code === i18n.get()) return;
    i18n.set(code);
    await api.invoke('state:set', { lang: code });
}

async function manualUpdateCheck(button) {
    await busy(button, async () => {
        const res = await api.invoke('update:check');
        if (!res?.ok) { toast(t('update.error'), 'err'); return; }
        if (res.status === 'dev') { toast(t('update.dev'), 'info'); return; }
        if (res.status === 'error') { toast(t('update.error'), 'err'); return; }
        if (res.kind === 'ready') { S.update = { kind: 'ready', version: res.version }; toast(t('update.downloaded')); }
        else if (res.kind === 'available' && res.version) { S.update = { kind: 'available', version: res.version }; toast(tr('update.available', res.version)); }
        else toast(t('update.upToDate'));
        renderUpdateCard();
    });
}

function renderUpdateCard() {
    const card = $('#update-card');
    const u = S.update;
    if (!u.kind || u.kind === 'none' || u.kind === 'error') { card.hidden = true; return; }
    card.hidden = false;
    const action = $('#update-action');
    if (u.kind === 'ready') {
        $('#update-title').textContent = tr('ui.update.ready', u.version || '');
        action.textContent = t('update.ready');
        action.disabled = false;
    } else if (u.kind === 'downloading') {
        $('#update-title').textContent = `${t('update.downloading')} ${u.percent ?? 0} %`;
        action.textContent = t('update.downloading');
        action.disabled = true;
    } else {
        $('#update-title').textContent = tr('update.available', u.version || '');
        action.textContent = t('ui.update.download');
        action.disabled = false;
    }
}

/* ── command palette ───────────────────────────────────────────────────── */

const VIEW_ICONS = {
    overview: 'layout-dashboard', console: 'terminal', players: 'users', plugins: 'package', config: 'sliders', backups: 'archive',
    servers: 'server', create: 'plus', guide: 'book-open', settings: 'settings',
};
const viewLabel = (view) => $(`.nav-item[data-view="${view}"] span[data-i18n]`)?.textContent ?? view;

function paletteEntries() {
    const server = active();
    const live = isLive();
    const entries = VIEWS.map((view, index) => ({ group: t('ui.palette.go'), icon: VIEW_ICONS[view], label: viewLabel(view), kbd: index < 9 ? `Ctrl ${index + 1}` : null, run: () => show(view) }));
    const actions = [];
    if (server?.hasJar && !live && !liveServer()) actions.push({ icon: 'play', label: t('palette.start'), run: () => { show('console'); void startServer(); } });
    if (live) {
        actions.push({ icon: 'square', label: t('palette.stop'), run: () => stopServer() });
        actions.push({ icon: 'rotate-ccw', label: t('ui.restart'), run: () => restartServer() });
        actions.push({ icon: 'users', label: `${t('ui.palette.run')} list`, run: () => { show('players'); void sendCommand('list'); } });
        actions.push({ icon: 'save', label: `${t('ui.palette.run')} save-all`, run: () => sendCommand('save-all') });
    }
    if (server && (!live || runOf(server).state === 'online')) actions.push({ icon: 'archive', label: t('palette.backup'), run: () => createBackup() });
    if (server) actions.push({ icon: 'folder', label: t('manage.open'), run: () => api.invoke('shell:openFolder', { dir: server.dir }) });
    actions.push({ icon: 'folder', label: t('palette.addServer'), run: addServer });
    actions.push({ icon: effectiveTheme() === 'dark' ? 'sun' : 'moon', label: t('ui.palette.theme'), run: () => persistPrefs({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' }) });
    actions.push({ icon: 'refresh', label: t('palette.update'), run: () => { show('settings'); void manualUpdateCheck($('#set-update-check')); } });
    const servers = S.servers.filter((s) => s.id !== S.activeId).map((s) => ({ group: t('servers.title'), icon: 'server', label: tr('ui.palette.switch', s.name), run: () => activateServer(s.id) }));
    return [...entries, ...actions.map((a) => ({ group: t('ui.palette.actions'), ...a })), ...servers];
}

let palIndex = 0;
function paletteRender() {
    const q = $('#palette-input').value.trim().toLowerCase();
    const list = $('#palette-list');
    list.textContent = '';
    const entries = paletteEntries().filter((e) => !q || e.label.toLowerCase().includes(q) || e.group.toLowerCase().includes(q));
    if (!entries.length) { list.append(h('p', { class: 'pal-empty', text: t('settings.noResult') })); return; }
    palIndex = Math.min(palIndex, entries.length - 1);
    let group = null;
    entries.forEach((entry, index) => {
        if (entry.group !== group) { group = entry.group; list.append(h('p', { class: 'pal-group', text: group })); }
        list.append(h('button', {
            class: `pal-item${index === palIndex ? ' on' : ''}`, type: 'button', role: 'option', dataset: { index: String(index) },
            onmousemove: () => { if (palIndex !== index) { palIndex = index; paletteHighlight(); } },
            onclick: () => { paletteClose(); entry.run(); },
        }, svg(entry.icon), h('span', { text: entry.label }), entry.kbd ? h('kbd', { class: 'kbd', text: entry.kbd }) : null));
    });
}
function paletteHighlight() {
    for (const item of $$('#palette-list .pal-item')) item.classList.toggle('on', Number(item.dataset.index) === palIndex);
    $('#palette-list .pal-item.on')?.scrollIntoView({ block: 'nearest' });
}
function paletteOpen() {
    closeMenu();
    $('#palette').hidden = false;
    $('#palette-input').value = '';
    palIndex = 0;
    paletteRender();
    $('#palette-input').focus();
}
function paletteClose() { $('#palette').hidden = true; }

/* ── onboarding: three short slides on the very first launch ───────────── */

function openOnboard(step = 0) {
    S.onboardStep = Math.min(Math.max(Number(step) || 0, 0), 2);
    $('#onboard').hidden = false;
    renderOnboard();
}
async function finishOnboard() {
    S.onboarded = true;
    $('#onboard').hidden = true;
    await api.invoke('state:set', { onboarded: true });
}
async function renderOnboard() {
    const step = S.onboardStep;
    $('#onboard-title').textContent = t(`onboard.w${step + 1}.title`);
    $('#onboard-text').textContent = t(`onboard.w${step + 1}.text`);
    const dots = $('#onboard-dots');
    dots.textContent = '';
    for (let index = 0; index < 3; index++) dots.append(h('i', { class: index === step ? 'on' : '' }));
    $('#onboard-back').hidden = step === 0;
    $('#onboard-skip').hidden = step === 2;
    const next = $('#onboard-next');
    next.textContent = step === 0 ? t('onboard.start') : step === 2 ? t('onboard.done') : t('onboard.next');
    const extra = $('#onboard-extra');
    extra.textContent = '';
    const go = (to) => { S.onboardStep = to; void api.invoke('state:set', { onboardStep: to }); renderOnboard(); };
    $('#onboard-back').onclick = () => go(step - 1);
    if (step < 2) next.onclick = () => go(step + 1);
    if (step === 1) {
        const chip = pill('neutral', 'Java…', { live: true });
        extra.append(chip);
        const info = S.java || await api.invoke('java:check');
        S.java = info;
        if ($('#onboard').hidden || S.onboardStep !== 1) return;
        chip.replaceWith(info?.ok ? pill('success', tr('onboard.java.ok', info.version)) : pill('danger', t('onboard.java.bad')));
        if (!info?.ok) extra.append(btn({ label: t('ui.java.install'), icon: 'external', variant: 'glow', size: 'sm', onClick: () => api.invoke('shell:openExternal', 'https://adoptium.net/temurin/releases/?version=25') }));
    }
    if (step === 2) {
        extra.append(h('div', { class: 'btn-row', style: 'justify-content:center' },
            btn({ label: t('onboard.server.create'), icon: 'plus', variant: 'primary', onClick: async () => { await finishOnboard(); show('create'); } }),
            btn({ label: t('onboard.server.add'), icon: 'folder', variant: 'glow', onClick: async () => { await finishOnboard(); await addServer(); } })));
        next.onclick = finishOnboard;
    }
}

/* ── topbar facts ──────────────────────────────────────────────────────── */

function renderJavaPill() {
    const el = $('#pill-java');
    const java = S.java;
    el.textContent = '';
    el.className = `pill ${java ? (java.ok ? 'pill-success' : 'pill-danger') : 'pill-neutral'}`;
    el.append(h('span', { class: 'pill-dot' }), h('span', { text: java ? (java.ok ? `Java ${java.version}` : t('chip.java.bad')) : 'Java…' }));
    el.title = java ? `${java.raw}${java.vendor ? ` (${java.vendor})` : ''}` : '';
}

function renderPnxPill() {
    const el = $('#pill-pnx');
    el.textContent = '';
    el.className = 'pill pill-neutral';
    el.append(h('span', { class: 'mono', text: S.stable ? `PNX ${bare(S.stable.tag)}` : 'PNX —' }));
    el.title = t('dash.releases');
}

async function loadReleases(force = false) {
    const list = await api.invoke('releases:list', { force });
    S.releasesError = !list?.ok;
    if (list?.ok) {
        S.releases = list.releases;
        S.stable = list.releases.find((r) => !r.prerelease) ?? list.releases[0] ?? null;
    }
    renderPnxPill();
    if (S.view === 'create') { if (!create.tag && S.stable) create.tag = S.stable.tag; renderVersionChoices(); }
    if (S.view === 'overview') void renderHealth();
}

/* ── language change: everything drawn from JS is drawn again ──────────── */

function onLanguageChange() {
    renderSidebar();
    renderJavaPill();
    renderPnxPill();
    renderView();
    moveMarker();
    if (!$('#onboard').hidden) renderOnboard();
}

/* ── events from main ──────────────────────────────────────────────────── */

function wireEvents() {
    api.on('server:line', ({ dir, lines, stream }) => {
        addLines(dir, lines.map((raw) => ({ raw, kind: stream === 'assistant' ? 'sys' : 'out' })));
    });
    api.on('server:state', async (payload) => {
        if (!payload?.dir) return;
        const key = keyOf(payload.dir);
        const before = S.runs.get(key)?.state;
        const crashed = payload.crashed ? true : payload.state === 'stopped' ? Boolean(S.runs.get(key)?.crashed) && before === 'stopped' : false;
        S.runs.set(key, { state: payload.state, pid: payload.pid, startedAt: payload.startedAt, memory: payload.memory, remote: payload.remote, crashed });
        if (before === payload.state) { renderSidebar(); return; }
        if (payload.state === 'online' && before && before !== 'online') {
            pushSys(t('ui.console.online'), payload.dir);
            if (isActiveDir(payload.dir)) {
                S.playersAsked = false;
                if (S.view === 'players') void sendCommand('list');
            }
        }
        if (payload.state === 'stopped' || payload.state === 'offline') {
            bufOf(payload.dir).players.clear();
            if (isActiveDir(payload.dir)) S.playersAsked = false;
        }
        S.servers = S.servers.map((s) => (sameDir(s.dir, payload.dir) ? { ...s, running: isLive(s), state: payload.state } : s));
        renderSidebar();
        if (SERVER_VIEWS.has(S.view) && isActiveDir(payload.dir)) renderView();
        else if (S.view === 'servers') renderServers();
    });
    api.on('server:exit', ({ code, dir, crashed, willRestart }) => {
        pushSys(tr('ui.console.exit', code ?? '?'), dir);
        const server = S.servers.find((s) => sameDir(s.dir, dir));
        if (crashed) {
            toast(tr(willRestart ? 'ui.crash.restarting' : 'ui.crash.text', server?.name ?? dir, code ?? '?'), 'err', {
                action: { label: t('ui.openConsole'), run: () => show('console') },
            });
        }
    });
    api.on('create:log', createLog);
    api.on('create:progress', ({ received, percent }) => {
        const fill = $('#cr-progress-fill');
        if (percent === null || percent === undefined) {
            fill.classList.add('indeterminate');
            $('#cr-progress-chip').textContent = fmtSize(received);
        } else {
            fill.classList.remove('indeterminate');
            fill.style.width = `${Math.floor(percent)}%`;
            $('#cr-progress-chip').textContent = `${Math.floor(percent)} %`;
        }
    });
    api.on('core:progress', ({ percent }) => {
        if (percent !== null && percent !== undefined && Math.floor(percent) % 25 === 0) {
            // quiet: the button already spins; a toast per quarter is enough
        }
    });
    api.on('plugin:progress', ({ slug, percent }) => {
        for (const b of $$(`button[data-slug="${CSS.escape(slug)}"]`)) {
            if (b.disabled) b.textContent = percent === null || percent === undefined ? '···' : `${percent} %`;
        }
    });
    api.on('backup:event', (payload) => {
        if (payload?.kind === 'failed') toast(tr('ui.auto.failed', errorText(payload.error)), 'err');
        if (payload?.auto) void refreshServers().then(() => { if (S.view === 'backups' && active()) renderAutomation(active()); });
        const server = active();
        if (server) S.backups.delete(server.dir.toLowerCase());
        if (S.view === 'backups') void renderBackups();
    });
    api.on('update:event', (payload) => {
        if (!payload?.kind) return;
        if (payload.kind === 'error') { if (S.update.kind === 'downloading') toast(t('update.error'), 'err'); S.update = { kind: null }; }
        else S.update = { kind: payload.kind, version: payload.version ?? S.update.version, percent: payload.percent ?? null };
        renderUpdateCard();
    });
}

/* ── wiring ────────────────────────────────────────────────────────────── */

function wire() {
    for (const item of $$('.nav-item')) item.addEventListener('click', () => show(item.dataset.view));
    $('#brand-home').addEventListener('click', () => show('overview'));
    document.addEventListener('click', (event) => {
        const go = event.target.closest('[data-go]');
        if (go) show(go.dataset.go);
    });

    $('#switcher').addEventListener('click', () => toggleMenu($('#switcher'), $('#switcher-menu'), buildSwitcherMenu));
    $('#side-lang').addEventListener('click', () => toggleMenu($('#side-lang'), $('#lang-menu'), buildLangMenu));
    $('#side-theme').addEventListener('click', () => persistPrefs({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' }).then(() => { if (S.view === 'settings') renderSettings(); }));
    $('#update-action').addEventListener('click', async (event) => {
        if (S.update.kind === 'ready') await api.invoke('update:install');
        else {
            S.update = { ...S.update, kind: 'downloading', percent: 0 };
            renderUpdateCard();
            const res = await api.invoke('update:download');
            if (!res?.ok) { toast(t('update.error'), 'err'); S.update.kind = 'available'; renderUpdateCard(); }
            event.target.blur();
        }
    });
    $('#pill-java').addEventListener('click', async () => {
        S.java = await api.invoke('java:check');
        renderJavaPill();
        if (!S.java?.ok) toast(t('chip.java.bad'), 'err', { action: { label: t('ui.java.install'), run: () => api.invoke('shell:openExternal', 'https://adoptium.net/temurin/releases/?version=25') } });
        else toast(tr('onboard.java.ok', S.java.version));
    });
    $('#pill-pnx').addEventListener('click', () => api.invoke('shell:openExternal', 'https://github.com/PowerNukkitX/PowerNukkitX/releases'));
    $('#palette-btn').addEventListener('click', paletteOpen);

    // overview
    $('#ov-health-refresh').addEventListener('click', async (event) => {
        await busy(event.currentTarget, async () => {
            S.java = await api.invoke('java:check');
            S.sys = await api.invoke('system:info');
            renderJavaPill();
            await renderHealth(true);
        });
    });

    // console
    for (const b of $$('#con-filter .seg-btn')) {
        b.addEventListener('click', () => { S.con.filter = b.dataset.filter; renderConsoleView(); });
    }
    let conSearchTimer = null;
    $('#con-search').addEventListener('input', (event) => {
        clearTimeout(conSearchTimer);
        S.con.query = event.target.value.trim().toLowerCase();
        conSearchTimer = setTimeout(() => renderConsoleLines(true), 120);
    });
    $('#con-autoscroll').addEventListener('click', () => {
        S.con.autoscroll = !S.con.autoscroll;
        $('#con-autoscroll').setAttribute('aria-pressed', String(S.con.autoscroll));
        if (S.con.autoscroll) $('#console').scrollTop = $('#console').scrollHeight;
    });
    $('#con-copy').addEventListener('click', () => {
        const text = consoleText(S.con.lines.filter(linePasses));
        if (!text.trim()) { toast(t('ui.console.nothing'), 'info'); return; }
        void copyText(text);
    });
    $('#con-export').addEventListener('click', async () => {
        const text = consoleText();
        if (!text.trim()) { toast(t('ui.console.nothing'), 'info'); return; }
        const res = await api.invoke('logs:export', { text });
        if (res?.ok) toast(t('console.exported'));
        else if (res?.error !== 'canceled') toast(errorText(res?.error), 'err');
    });
    $('#con-clear').addEventListener('click', () => {
        S.con.lines = [];
        S.con.warn = 0;
        S.con.err = 0;
        renderConsoleLines(true);
    });
    $('#cmd-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = $('#cmd-input');
        if (await sendCommand(input.value)) input.value = '';
    });
    $('#cmd-input').addEventListener('keydown', (event) => {
        const input = event.currentTarget;
        if (event.key === 'ArrowUp' && S.cmdHistory.length) {
            event.preventDefault();
            S.cmdIndex = Math.min(S.cmdIndex + 1, S.cmdHistory.length - 1);
            input.value = S.cmdHistory[S.cmdHistory.length - 1 - S.cmdIndex];
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            S.cmdIndex = Math.max(S.cmdIndex - 1, -1);
            input.value = S.cmdIndex < 0 ? '' : S.cmdHistory[S.cmdHistory.length - 1 - S.cmdIndex];
        }
    });

    // players
    $('#pl-refresh').addEventListener('click', () => sendCommand('list'));
    $('#pl-form').addEventListener('submit', (event) => event.preventDefault());
    $('#say-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = $('#say-input');
        const text = input.value.trim();
        if (!text) return;
        if (await sendCommand(`say ${text}`)) { input.value = ''; toast(t('ui.players.said')); }
    });

    // plugins
    for (const tab of $$('#pg-tabs .tab')) tab.addEventListener('click', () => selectPluginTab(tab.dataset.tab));
    $('#pg-search').addEventListener('input', (event) => { S.pg.q = event.target.value.trim(); searchPlugins(); });
    for (const b of $$('#pg-sort .seg-btn')) {
        b.addEventListener('click', () => {
            S.pg.sort = b.dataset.sort;
            for (const other of $$('#pg-sort .seg-btn')) other.setAttribute('aria-pressed', String(other === b));
            searchPlugins();
        });
    }
    $('#pg-folder').addEventListener('click', () => api.invoke('shell:openFolder', { dir: active()?.dir, sub: 'plugins' }));
    $('#pg-update-all').addEventListener('click', (event) => updateAllPlugins(event.currentTarget));

    // config
    $('#cfg-search').addEventListener('input', applyConfigSearch);
    $('#cfg-open').addEventListener('click', async () => {
        const ok = await api.invoke('shell:openFile', { dir: active()?.dir, name: cfg.data?.which || 'pnx.yml' });
        if (!ok) toast(t('toast.noYml'), 'err');
    });
    $('#cfg-save').addEventListener('click', (event) => saveConfig(event.currentTarget));
    $('#cfg-discard').addEventListener('click', () => { cfg.reset(); drawConfig(); });

    // backups
    $('#bk-create').addEventListener('click', (event) => createBackup(event.currentTarget));
    for (const id of ['#auto-every', '#auto-keep', '#auto-restart-on', '#auto-restart-at', '#auto-warn']) {
        $(id).addEventListener('change', () => void saveAutomation());
    }
    $('#bk-folder').addEventListener('click', () => api.invoke('shell:openFolder', { dir: active()?.dir, sub: 'backups' }));

    // servers
    $('#sv-add').addEventListener('click', addServer);

    // create
    $('#create-form').addEventListener('submit', runCreate);
    $('#cr-pick').addEventListener('click', pickCreateDir);
    $('#cr-dir').addEventListener('input', validateCreateDir);
    $('#cr-run').addEventListener('click', async () => { show('console'); await startServer(); });
    for (const b of $$('#cr-target .host-tile')) b.addEventListener('click', () => { create.target = b.dataset.target; renderTarget(); });
    $('#cr-name').addEventListener('input', () => { if (create.target === 'remote') syncVpsPath(); else renderSummary(); });
    $('#vps-path').addEventListener('input', () => { create.vpsPathEdited = true; renderVpsPresets(); void checkVpsPath(); });
    $('#vps-browse').addEventListener('click', pickVpsPath);
    for (const b of $$('#vps-auth .seg-btn')) b.addEventListener('click', () => { create.auth = b.dataset.auth; create.probe = null; renderTarget(); });
    for (const id of ['#vps-host', '#vps-port', '#vps-user', '#vps-password', '#vps-key', '#vps-passphrase', '#vps-sudo']) {
        $(id).addEventListener('input', () => {
            if (create.probe) { create.probe = null; $('#vps-checks').hidden = true; renderMemoryChoices(); }
            if (id === '#vps-user') { renderTarget(); renderVpsPresets(); }
            renderSummary();
        });
    }
    $('#vps-test').addEventListener('click', (event) => testVps(event.currentTarget));
    $('#vps-key-pick').addEventListener('click', async () => {
        const file = await api.invoke('dialog:pickFile', { title: t('ui.vps.key') });
        if (file) { $('#vps-key').value = file; create.probe = null; }
    });
    $('#cr-open').addEventListener('click', () => api.invoke('shell:openFolder', { dir: create.done?.dir }));

    // guide
    $('#guide-replay').addEventListener('click', () => openOnboard(0));
    $('#guide-reset').addEventListener('click', async () => {
        S.tutorialDone = [];
        await api.invoke('state:set', { tutorialDone: [] });
        renderGuide();
    });

    // settings
    $('#set-lang').addEventListener('change', (event) => setLanguage(event.target.value));
    $('#set-memory').addEventListener('change', (event) => persistPrefs({ memory: event.target.value }));
    $('#set-confirm-quit').addEventListener('change', (event) => persistPrefs({ confirmQuit: event.target.checked }));
    $('#set-motion').addEventListener('change', (event) => persistPrefs({ motionOff: event.target.checked }));
    $('#set-auto-restart').addEventListener('change', (event) => persistPrefs({ autoRestart: event.target.checked }));
    $('#set-notify').addEventListener('change', (event) => persistPrefs({ notify: event.target.checked }).then(renderSettings));
    $('#set-notify-joins').addEventListener('change', (event) => persistPrefs({ notifyJoins: event.target.checked }));
    $('#set-update-auto').addEventListener('change', (event) => persistPrefs({ updateAuto: event.target.checked }));
    $('#set-update-bg').addEventListener('change', (event) => persistPrefs({ updateBg: event.target.checked }));
    $('#set-update-check').addEventListener('click', (event) => manualUpdateCheck(event.currentTarget));
    $('#set-open-data').addEventListener('click', () => api.invoke('app:openStateFolder'));
    $('#set-reset').addEventListener('click', async () => {
        const yes = await confirmAsk(t('settings.data.reset'), t('settings.data.resetConfirm'), { ok: t('settings.data.reset.btn'), danger: true });
        if (!yes) return;
        await api.invoke('state:reset');
        Object.assign(S.prefs, {
            theme: 'system', density: 'comfortable', motionOff: false, accent: 'grass',
            confirmQuit: true, updateAuto: true, updateBg: false, autoRestart: false, memory: '2G',
        });
        S.tutorialDone = [];
        applyPrefs();
        renderSettings();
        renderSidebar();
        toast(t('settings.data.resetDone'));
    });
    $('#set-search').addEventListener('input', applySettingsSearch);
    $('.rail-item')?.classList.add('on');
    for (const item of $$('.rail-item')) {
        item.addEventListener('click', () => {
            for (const other of $$('.rail-item')) other.classList.toggle('on', other === item);
            $(`.set-card[data-sec="${item.dataset.sec}"]`)?.scrollIntoView({ block: 'start' });
        });
    }

    // palette
    $('#palette-input').addEventListener('input', () => { palIndex = 0; paletteRender(); });
    $('#palette-input').addEventListener('keydown', (event) => {
        const count = $$('#palette-list .pal-item').length;
        if (event.key === 'ArrowDown') { event.preventDefault(); palIndex = Math.min(palIndex + 1, count - 1); paletteHighlight(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); palIndex = Math.max(palIndex - 1, 0); paletteHighlight(); }
        else if (event.key === 'Enter') { event.preventDefault(); $('#palette-list .pal-item.on')?.click(); }
    });
    $('#palette').addEventListener('mousedown', (event) => { if (event.target === event.currentTarget) paletteClose(); });

    // onboarding
    $('#onboard-skip').addEventListener('click', finishOnboard);

    // keyboard: Ctrl+K palette, Ctrl+1..9 views, Esc closes
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (!$('#palette').hidden) { paletteClose(); return; }
            if (openMenuEl) { closeMenu(); return; }
        }
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = String(event.key).toLowerCase();
        if (key === 'k') {
            event.preventDefault();
            if ($('#palette').hidden) paletteOpen(); else paletteClose();
            return;
        }
        if (key === 's' && S.view === 'config' && cfg.dirty()) { event.preventDefault(); void saveConfig($('#cfg-save')); return; }
        if (key === 'f' && S.view === 'console') { event.preventDefault(); $('#con-search').focus(); return; }
        const n = Number(event.key);
        if (n >= 1 && n <= 9 && !event.shiftKey) { event.preventDefault(); show(VIEWS[n - 1]); }
    });

    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (S.prefs.theme === 'system') { applyPrefs(); renderSidebar(); }
    });
    window.addEventListener('resize', moveMarker);
    document.addEventListener('i18n:change', onLanguageChange);
}

/* ── boot ──────────────────────────────────────────────────────────────── */

(async function boot() {
    if (api.platform === 'darwin') document.documentElement.classList.add('mac');
    icons.hydrate();
    wire();
    wireEvents();

    const saved = (await api.invoke('state:get')) || {};
    Object.assign(S.prefs, {
        theme: ['dark', 'light', 'system'].includes(saved.theme) ? saved.theme : 'system',
        density: saved.density === 'compact' ? 'compact' : 'comfortable',
        motionOff: saved.motionOff === true,
        accent: ACCENTS.some((a) => a.id === saved.accent) ? saved.accent : 'grass',
        confirmQuit: saved.confirmQuit !== false,
        updateAuto: saved.updateAuto !== false,
        updateBg: saved.updateBg === true,
        autoRestart: saved.autoRestart === true,
        memory: MEMORY_OPTIONS.includes(saved.memory) ? saved.memory : '2G',
        notify: saved.notify !== false,
        notifyJoins: saved.notifyJoins === true,
    });
    S.tutorialDone = Array.isArray(saved.tutorialDone) ? saved.tutorialDone : [];
    S.onboarded = Boolean(saved.onboarded);
    S.onboardStep = Number.isInteger(saved.onboardStep) ? saved.onboardStep : 0;
    applyPrefs();
    const lang = saved.lang && i18n.langs().some((l) => l.code === saved.lang) ? saved.lang : i18n.detect();
    i18n.set(lang);
    i18n.applyDom();

    const [states, about] = await Promise.all([api.invoke('servers:states'), api.invoke('app:about')]);
    S.about = about;
    for (const st of states || []) S.runs.set(keyOf(st.dir), { ...st, crashed: false });
    await refreshServers();
    show('overview');
    renderJavaPill();
    renderPnxPill();

    void api.invoke('java:check').then((java) => { S.java = java; renderJavaPill(); if (S.view === 'overview') void renderHealth(); });
    void api.invoke('system:info').then((sys) => { S.sys = sys; if (S.view === 'overview') renderJoin(); if (S.view === 'create') renderMemoryChoices(); });
    void loadReleases();
    void checkPluginUpdates();
    void api.invoke('update:check').then((res) => {
        if (res?.ok && res.kind === 'available' && res.version) { S.update = { kind: 'available', version: res.version }; renderUpdateCard(); }
        if (res?.ok && res.kind === 'ready') { S.update = { kind: 'ready', version: res.version }; renderUpdateCard(); }
    });

    // the uptime clock only touches the DOM while its figure is on screen
    setInterval(() => {
        if (S.view === 'overview' && isLive()) renderStats();
    }, 1000);

    if (!S.onboarded) openOnboard(S.onboardStep);
})().catch((cause) => {
    console.error(cause);
    toast(String(cause?.message || cause), 'err');
});
})();
