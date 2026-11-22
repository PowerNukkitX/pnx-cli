'use strict';

/**
 * PowerNukkitX desktop app — Electron main process.
 *
 * One rule drives this file: the desktop app never re-implements what the CLI
 * already decides. It imports the compiled CLI (vendored into `resources/cli`
 * at package time, `../../cli/dist` in dev) and drives the very same functions
 * `pnx init`, `pnxcli` and `pnx start` run. The renderer talks to it through a
 * narrow, whitelisted IPC surface defined in preload.cjs.
 *
 * 2.0 — what changed and why:
 * - a server has a lifecycle (starting → online → stopping → stopped) pushed
 *   to the renderer as `server:state`, instead of a bare "has a pid";
 * - a graceful stop waits up to 30 s for the world to save (4 s used to end in
 *   a forced kill on any real world, i.e. a cut save);
 * - the memory picked is the heap cap (-Xmx), per server, not just -Xms;
 * - plugins are listed from the active server's own plugins/ folder, so two
 *   servers no longer share one "installed" list, and a jar can be disabled;
 * - new: core update in place, crash auto-restart, system/port diagnostics,
 *   LAN addresses, a suggested folder for a new server, restart.
 */

const {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    nativeTheme,
    Notification,
    safeStorage,
    shell,
} = require('electron');
const { spawn, execFile } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const { randomUUID } = require('node:crypto');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const dgram = require('node:dgram');

/** Absolute path to the vendored CLI. Dev: the cli package's dist. Prod: resources/cli. */
const cliDir = app.isPackaged
    ? join(process.resourcesPath, 'cli')
    : join(__dirname, '..', '..', 'cli', 'dist');
const cli = (rel) => pathToFileURL(join(cliDir, rel)).href;

const JAR_NAME = 'powernukkitx.jar';
const MEMORY_CHOICES = ['1G', '2G', '3G', '4G', '6G', '8G', '12G', '16G'];
const DEFAULT_MEMORY = '2G';
const STOP_TIMEOUT_MS = 30_000;
const TITLEBAR_HEIGHT = 44;

/* the app was called "PowerNukkitX Assistant" before 2.4: keep its data folder,
   or the safeStorage key (saved VPS passwords) and the window prefs would be lost */
app.setPath('userData', join(app.getPath('appData'), 'PowerNukkitX Assistant'));

/* one app at a time: a second launch focuses the running window
   instead of spawning a rival (two spawnings of the same server would fight) */
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}
app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
});

/*
 * Every IPC handler goes through one dispatcher: when the server a call is
 * about lives on a VPS, the remote route answers (remote.cjs, over SSH);
 * otherwise the local handler below runs unchanged.
 */
const LOCAL_HANDLERS = new Map();
const REMOTE_ROUTES = new Map();
{
    const nativeHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (name, fn) => {
        LOCAL_HANDLERS.set(name, fn);
        nativeHandle(name, async (event, payload) => {
            const route = REMOTE_ROUTES.get(name);
            if (route) {
                const entry = await remoteTarget(name, payload);
                if (entry) {
                    try {
                        return await route(entry, payload || {}, event);
                    } catch (cause) {
                        return { ok: false, error: remoteError(cause) };
                    }
                }
            }
            return fn(event, payload);
        });
    };
}

/** The vendored CLI is ESM; load it lazily and keep the pieces we drive. */
let V = null;
async function cliModules() {
    if (V) return V;
    const release = await import(cli('services/release.js'));
    const server = await import(cli('services/server.js'));
    const plugins = await import(cli('services/plugins.js'));
    const backup = await import(cli('services/backup.js'));
    const http = await import(cli('infra/http.js'));
    const store = await import(cli('infra/store.js'));
    const proc = await import(cli('services/process.js'));
    V = { release, server, plugins, backup, http, store, proc };
    return V;
}

/** the CLI's own version (it used to report the app's package.json by mistake) */
function cliVersion() {
    for (const candidate of [join(cliDir, 'package.json'), join(cliDir, '..', 'package.json')]) {
        try {
            const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
            if (pkg.name === '@powernukkitx/cli') return pkg.version;
        } catch { /* next */ }
    }
    return '?';
}

let win = null;

function send(channel, payload) {
    // the notifier hears what the window hears, even when it is hidden
    if (channel === 'server:line' || channel === 'server:exit') {
        try { notifier.observe(channel, payload); } catch { /* never block a line */ }
    }
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const errText = (cause) => String(cause instanceof Error ? cause.message : cause);

/** One assistant state file, next to the CLI's own state in ~/.pnx-cli. */
async function readState() {
    const { store } = await cliModules();
    return store.readJson('assistant.json', { memory: DEFAULT_MEMORY, tutorialDone: [], servers: [], activeId: null });
}
let stateWrite = Promise.resolve();
/** writes are queued: two IPC calls patching at once must not lose a field */
function writeState(patch) {
    stateWrite = stateWrite.then(async () => {
        const { store } = await cliModules();
        const next = { ...(await readState()), ...patch };
        await store.writeJson('assistant.json', next);
        if ('autoRestart' in patch) prefs.autoRestart = patch.autoRestart === true;
        return next;
    }).catch(() => readState());
    return stateWrite;
}

/** the few preferences main needs synchronously */
const prefs = { autoRestart: false };

/* ── updates: electron-updater against the repo's GitHub releases ────────── */

let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
} catch {
    // electron-updater is a runtime dep; a missing module only breaks dev
}
if (autoUpdater) autoUpdater.autoDownload = false;

function updaterStatus() {
    if (!autoUpdater) return { ok: false, status: 'unsupported' };
    if (!app.isPackaged) return { ok: true, status: 'dev' };
    return null; // null = go ahead, the real answer comes from the events
}

let updateKind = null; // 'available' | 'downloading' | 'ready' | 'none' | 'error'
let updateVersion = null;

function updateEvent(kind, payload = {}) {
    updateKind = kind;
    if (payload.version) updateVersion = payload.version;
    send('update:event', { kind, ...payload });
}

function wireUpdater() {
    if (!autoUpdater || !app.isPackaged) return null;
    autoUpdater.on('update-available', (info) => updateEvent('available', { version: info.version }));
    autoUpdater.on('update-not-available', () => updateEvent('none'));
    autoUpdater.on('download-progress', (progress) =>
        updateEvent('downloading', { percent: Math.round(progress.percent) }));
    autoUpdater.on('update-downloaded', (info) => updateEvent('ready', { version: info.version }));
    autoUpdater.on('error', () => updateEvent('error'));
    return autoUpdater;
}

/** the auto mode checks on a rhythm; installing stays a manual verdict forever */
async function pulseUpdate() {
    if (!autoUpdater || !app.isPackaged) return;
    const state = await readState();
    autoUpdater.autoDownload = state.updateBg === true;
    if (state.updateAuto === false) return;
    autoUpdater.checkForUpdates().catch(() => {});
}

ipcMain.handle('update:check', async () => {
    const status = updaterStatus();
    if (status) return { ok: true, status, kind: updateKind };
    try {
        const state = await readState();
        autoUpdater.autoDownload = state.updateBg === true;
        const result = await Promise.race([
            autoUpdater.checkForUpdates(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
        ]);
        const version = result?.updateInfo?.version ?? updateVersion;
        return { ok: true, status: 'checked', kind: updateKind, version };
    } catch {
        return { ok: true, status: 'error', kind: updateKind };
    }
});

ipcMain.handle('update:download', async () => {
    if (!autoUpdater) return { ok: false, error: 'unsupported' };
    try {
        await autoUpdater.downloadUpdate();
        return { ok: true };
    } catch {
        updateEvent('error');
        return { ok: false, error: 'download-failed' };
    }
});

ipcMain.handle('update:install', async () => {
    if (!autoUpdater) return { ok: false, error: 'unsupported' };
    // a graceful stop first: the installer must not cut a world mid-save
    if (running.proc) await stopServer().catch(() => {});
    quitting = true;
    autoUpdater.quitAndInstall();
    return { ok: true };
});

/* ── server registry: several servers, one active at a time ──────────────── */

const sameDir = (a, b) => String(a).trim().replace(/[\\/]+$/, '').toLowerCase()
    === String(b).trim().replace(/[\\/]+$/, '').toLowerCase();

async function activeServerEntry() {
    const state = await readState();
    return (state.servers || []).find((it) => it.id === state.activeId) || null;
}

/** Any dir the app should track ends up in the registry; dupes collapse. */
async function registerServerEntry(dir, extra = {}) {
    const state = await readState();
    const previous = (state.servers || []).find((it) => sameDir(it.dir, dir));
    const servers = (state.servers || []).filter((it) => !sameDir(it.dir, dir));
    if (!existsSync(join(dir, JAR_NAME))) return null;
    const entry = {
        id: previous?.id || randomUUID().slice(0, 10),
        name: String(extra.name || previous?.name || basename(dir)).trim().slice(0, 48),
        dir: String(dir).trim(),
        memory: MEMORY_CHOICES.includes(extra.memory) ? extra.memory : (previous?.memory || state.memory || DEFAULT_MEMORY),
        tag: extra.tag || previous?.tag || null,
        addedAt: previous?.addedAt || new Date().toISOString(),
    };
    servers.push(entry);
    const patch = { servers };
    if (extra.activate || !state.activeId || !servers.some((it) => it.id === state.activeId)) patch.activeId = entry.id;
    await writeState(patch);
    return entry;
}

async function patchServerEntry(id, patch) {
    const state = await readState();
    if (!(state.servers || []).some((it) => it.id === id)) return null;
    const servers = (state.servers || []).map((it) => (it.id === id ? { ...it, ...patch } : it));
    await writeState({ servers });
    return servers.find((it) => it.id === id) || null;
}

/** First boot with no registry yet: the CLI's default server becomes the first. */
async function migrateRegistry() {
    const state = await readState();
    if ((state.servers || []).length > 0) return;
    const { server } = await cliModules();
    const dir = await server.resolveServerDir().catch(() => null);
    if (dir && existsSync(join(dir, JAR_NAME))) {
        await registerServerEntry(dir);
    }
}

function serverView(it, state) {
    if (it.remote) {
        const live = remoteStates.get(it.dir.toLowerCase());
        const { secret, sudoSecret, ...publicRemote } = it.remote;
        void secret; void sudoSecret;
        return {
            ...it,
            remote: publicRemote,
            kind: 'remote',
            memory: it.memory || DEFAULT_MEMORY,
            active: it.id === state.activeId,
            hasJar: live ? live.hasJar !== false : true,
            running: Boolean(live) && !['stopped', 'offline'].includes(live.state),
            state: live?.state ?? 'unknown',
        };
    }
    const isRunning = Boolean(running.proc) && Boolean(running.dir) && sameDir(running.dir, it.dir);
    return {
        ...it,
        kind: 'local',
        memory: it.memory || state.memory || DEFAULT_MEMORY,
        active: it.id === state.activeId,
        hasJar: existsSync(join(it.dir, JAR_NAME)),
        running: isRunning,
        state: isRunning ? running.state : 'stopped',
    };
}

ipcMain.handle('servers:list', async () => {
    await migrateRegistry();
    const state = await readState();
    return (state.servers || []).map((it) => serverView(it, state));
});

ipcMain.handle('servers:add', async (_event, { dir, name } = {}) => {
    if (typeof dir !== 'string' || !dir.trim()) return { ok: false, error: 'no-dir' };
    if (!existsSync(join(dir, JAR_NAME))) return { ok: false, error: 'no-jar' };
    const state = await readState();
    if ((state.servers || []).some((it) => sameDir(it.dir, dir))) return { ok: false, error: 'dupe' };
    const entry = await registerServerEntry(dir, { name, activate: true });
    const { server } = await cliModules();
    if (entry) await server.setDefaultServer(entry.dir).catch(() => {});
    return { ok: true, entry };
});

ipcMain.handle('servers:activate', async (_event, { id } = {}) => {
    const state = await readState();
    const entry = (state.servers || []).find((it) => it.id === id);
    if (!entry) return { ok: false, error: 'unknown' };
    await writeState({ activeId: id });
    if (!entry.remote) {
        const { server } = await cliModules();
        await server.setDefaultServer(entry.dir).catch(() => {});
    } else {
        void pollRemote(entry, { force: true });
    }
    return { ok: true, entry: serverView(entry, { ...state, activeId: id }) };
});

ipcMain.handle('servers:rename', async (_event, { id, name } = {}) => {
    const clean = String(name || '').trim().slice(0, 48);
    if (!clean) return { ok: false, error: 'invalid' };
    const entry = await patchServerEntry(id, { name: clean });
    return entry ? { ok: true } : { ok: false, error: 'unknown' };
});

ipcMain.handle('servers:setMemory', async (_event, { id, memory } = {}) => {
    if (!MEMORY_CHOICES.includes(memory)) return { ok: false, error: 'invalid' };
    const entry = await patchServerEntry(id, { memory });
    return entry ? { ok: true } : { ok: false, error: 'unknown' };
});

ipcMain.handle('servers:remove', async (_event, { id } = {}) => {
    const state = await readState();
    const entry = (state.servers || []).find((it) => it.id === id);
    if (!entry) return { ok: false, error: 'unknown' };
    if (running.dir && sameDir(running.dir, entry.dir) && running.proc) {
        return { ok: false, error: 'running' };
    }
    if (entry.remote) {
        remote.close(entry);
        remoteStates.delete(entry.dir.toLowerCase());
    }
    const rest = (state.servers || []).filter((it) => it.id !== id);
    const patch = { servers: rest };
    if (state.activeId === id) {
        patch.activeId = rest[rest.length - 1]?.id ?? null;
        // the CLI's own default follows: a removed active server must not
        // leave `pnx` pointing at a ghost folder (and never at a VPS)
        const lastLocal = [...rest].reverse().find((it) => !it.remote);
        const { server } = await cliModules();
        await server.setDefaultServer(lastLocal ? lastLocal.dir : null).catch(() => {});
    }
    await writeState(patch);
    return { ok: true, activeId: 'activeId' in patch ? patch.activeId : state.activeId ?? null };
});

/* ── tracked paths: every server-scoped action stays inside the registry ──── */

async function trackedDir(dir) {
    if (typeof dir !== 'string' || !dir.trim()) return null;
    const state = await readState();
    const { server } = await cliModules();
    const all = (state.servers || []).map((it) => it.dir);
    const def = await server.resolveServerDir().catch(() => null);
    if (def) all.push(def);
    return all.find((it) => sameDir(it, dir)) || null;
}

/** the dir a server-scoped call acts on: the one asked, if tracked, else the active one */
async function targetDir(dir) {
    if (dir) return trackedDir(dir);
    const active = await activeServerEntry();
    if (active) return active.dir;
    const { server } = await cliModules();
    return server.resolveServerDir().catch(() => null);
}

const SUBFOLDERS = new Set(['plugins', 'backups', 'logs', 'worlds']);

/* ── config: pnx.yml first, the old server.properties second ─────────────── */

const CONFIG_FILES = ['pnx.yml', 'server.properties'];

ipcMain.handle('config:read', async (_event, { dir } = {}) => {
    const root = await targetDir(dir);
    if (!root) return { ok: false, error: 'no-server' };
    for (const name of CONFIG_FILES) {
        const path = join(root, name);
        if (existsSync(path)) {
            return { ok: true, which: name, path, dir: root, text: await fsp.readFile(path, 'utf8') };
        }
    }
    return { ok: true, which: 'pnx.yml', path: join(root, 'pnx.yml'), dir: root, text: '', exists: false };
});

ipcMain.handle('config:write', async (_event, { dir, which, text } = {}) => {
    const root = await trackedDir(dir);
    if (!root || !CONFIG_FILES.includes(which) || typeof text !== 'string') {
        return { ok: false, error: 'invalid' };
    }
    const path = join(root, which);
    try {
        // one roll-back copy: an assistant mistake must never cost a config
        if (existsSync(path)) await fsp.copyFile(path, `${path}.assistant-bak`);
        await fsp.writeFile(path, text.replace(/\r\n/g, '\n'), 'utf8');
        return { ok: true, path };
    } catch (cause) {
        return { ok: false, error: errText(cause) };
    }
});

/** keys the renderer may persist — everything else from the UI is refused */
const STATE_KEYS = [
    'memory', 'tutorialDone', 'lang', 'onboarded', 'onboardStep',
    'theme', 'density', 'motionOff', 'confirmQuit', 'updateAuto', 'updateBg',
    'accent', 'autoRestart', 'notify', 'notifyJoins',
];
const ACCENTS = ['grass', 'diamond', 'gold', 'redstone', 'lapis', 'amethyst', 'copper'];

let quitting = false;

/** the close-with-server prompt, said in the user's own language */
const QUIT_PROMPT = {
    fr: {
        title: 'Un serveur est en cours d’exécution',
        detail: 'Ton monde peut perdre sa dernière sauvegarde si le serveur est coupé brutalement.',
        stop: 'Arrêter proprement et quitter',
        force: 'Forcer l’arrêt',
        cancel: 'Annuler',
        remember: 'Ne plus demander (arrêt propre à la fermeture)',
    },
    en: {
        title: 'A server is currently running',
        detail: 'Your world may lose unsaved progress if the server is killed.',
        stop: 'Stop gracefully and quit',
        force: 'Force stop',
        cancel: 'Cancel',
        remember: 'Don’t ask again (graceful stop on close)',
    },
    es: {
        title: 'Hay un servidor en ejecución',
        detail: 'Tu mundo puede perder progreso si se mata el servidor.',
        stop: 'Detener correctamente y salir',
        force: 'Forzar parada',
        cancel: 'Cancelar',
        remember: 'No volver a preguntar (parada correcta al cerrar)',
    },
    de: {
        title: 'Ein Server läuft gerade',
        detail: 'Deine Welt könnte Fortschritt verlieren, wenn der Server gekillt wird.',
        stop: 'Sauber beenden und schließen',
        force: 'Beenden erzwingen',
        cancel: 'Abbrechen',
        remember: 'Nicht mehr fragen (beim Schließen sauber stoppen)',
    },
    pt: {
        title: 'Há um servidor em execução',
        detail: 'Seu mundo pode perder progresso se o servidor for encerrado à força.',
        stop: 'Parar corretamente e sair',
        force: 'Forçar parada',
        cancel: 'Cancelar',
        remember: 'Não perguntar novamente (parada correta ao fechar)',
    },
};

/* ── theme: the title bar follows the token set ──────────────────────────── */

const OVERLAY_COLORS = {
    dark: { color: '#0a0a0a', symbolColor: '#e6ebe8' },
    light: { color: '#ffffff', symbolColor: '#0a0a0a' },
};

async function resolveTheme() {
    const state = await readState();
    const theme = state.theme === 'light' || state.theme === 'dark' ? state.theme : 'system';
    if (theme !== 'system') return theme;
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/* ── the server process: one at a time, with a real lifecycle ─────────────── */

const running = {
    proc: null,
    dir: null,
    pid: null,
    startedAt: 0,
    memory: null,
    state: 'stopped', // starting | online | stopping | stopped
    stopRequested: false,
};
/** crash timestamps per dir, so an auto-restart loop gives up after 3 in 10 min */
const crashLog = new Map();
let restartTimer = null;

function pushState(extra = {}) {
    send('server:state', {
        state: running.state,
        dir: running.dir,
        pid: running.pid,
        startedAt: running.startedAt || null,
        memory: running.memory,
        ...extra,
    });
}

function memoryMb(memory) {
    const m = String(memory).match(/^(\d+)([MG])$/i);
    if (!m) return 1024;
    return Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1024 : 1);
}

/**
 * -Xmx is what "memory" means to a user. CLI 1.2+ already emits -Xms/-Xmx
 * (a quarter of the cap to start, the cap to grow to); an older vendored CLI
 * only sets -Xms, so the heap flags are rebuilt here when -Xmx is missing.
 */
function launchArgs(server, memory, javaVersion) {
    const base = server.buildLaunchArgs(memory, javaVersion).filter((arg) => !/^-XX:MaxRAMPercentage=/.test(arg));
    if (!base.some((arg) => arg.startsWith('-Xmx'))) {
        const xms = `-Xms${Math.max(512, Math.floor(memoryMb(memory) / 4))}M`;
        const at = base.findIndex((arg) => arg.startsWith('-Xms'));
        if (at >= 0) base.splice(at, 1, xms, `-Xmx${memory}`);
        else base.unshift(xms, `-Xmx${memory}`);
    }
    return [...base, '--nogui'];
}

async function startServer(dir, memory) {
    if (running.proc) return { ok: false, error: 'running', dir: running.dir };
    if (!existsSync(join(dir, JAR_NAME))) return { ok: false, error: 'no-jar', dir };
    clearTimeout(restartTimer);

    const { server } = await cliModules();
    const java = await server.checkJava();
    if (!java.ok) {
        return { ok: false, error: 'java', raw: java.raw, version: java.version };
    }

    const args = launchArgs(server, memory, java.version);
    let proc;
    try {
        proc = spawn(server.findJava(), args, {
            cwd: dir,
            env: server.javaEnv(),
            windowsHide: true,
        });
    } catch (cause) {
        return { ok: false, error: 'spawn', message: errText(cause) };
    }
    Object.assign(running, {
        proc,
        dir,
        pid: proc.pid,
        startedAt: Date.now(),
        memory,
        state: 'starting',
        stopRequested: false,
    });
    pushState();

    let fired = false;
    const finish = (code, message) => {
        if (fired) return;
        fired = true;
        const wasRequested = running.stopRequested;
        Object.assign(running, { proc: null, pid: null, state: 'stopped', startedAt: 0, stopRequested: false });
        const crashed = !wasRequested && code !== 0;
        const willRestart = crashed && !quitting ? scheduleRestart(dir, memory) : false;
        send('server:exit', { code, dir, crashed, willRestart, message });
        pushState({ code, crashed, willRestart, dir });
    };
    proc.on('error', (cause) => finish(-1, errText(cause)));
    for (const stream of ['stdout', 'stderr']) {
        let carry = '';
        proc[stream].setEncoding('utf8');
        proc[stream].on('data', (data) => {
            carry += data;
            const lines = carry.split(/\r?\n|\r/);
            carry = lines.pop() || '';
            if (!lines.length) return;
            if (running.proc === proc && running.state === 'starting'
                && lines.some((line) => /\bDone \(/.test(line))) {
                running.state = 'online';
                pushState();
            }
            send('server:line', { dir, lines, stream });
        });
    }
    proc.on('close', (code) => finish(code));

    return { ok: true, pid: proc.pid, java: `${java.vendor} ${java.version}`, args, memory };
}

function scheduleRestart(dir, memory) {
    if (!prefs.autoRestart) return false;
    const now = Date.now();
    const recent = (crashLog.get(dir) || []).filter((at) => now - at < 10 * 60 * 1000);
    recent.push(now);
    crashLog.set(dir, recent);
    if (recent.length > 3) return false; // a crash loop is a bug to read, not to repeat
    restartTimer = setTimeout(() => {
        if (running.proc || quitting) return;
        send('server:line', { dir, lines: [`[PowerNukkitX] auto-restart (${recent.length}/3)…`], stream: 'assistant' });
        void startServer(dir, memory);
    }, 5000);
    return true;
}

/** Graceful first: `stop` travels on stdin, the hard kill is the plan B. */
async function stopServer({ force = false, timeoutMs = STOP_TIMEOUT_MS } = {}) {
    clearTimeout(restartTimer);
    const proc = running.proc;
    if (!proc) return { ok: false, error: 'not-running' };
    running.stopRequested = true;
    if (!force) {
        running.state = 'stopping';
        pushState();
        try { proc.stdin.write('stop\n'); } catch { /* dies silently, force below */ }
        const gone = await new Promise((resolve) => {
            let limit = null;
            const watch = setInterval(() => {
                if (running.proc !== proc) { clearInterval(watch); clearTimeout(limit); resolve(true); }
            }, 150);
            limit = setTimeout(() => { clearInterval(watch); resolve(false); }, timeoutMs);
        });
        if (gone) return { ok: true, graceful: true };
    }
    killTree(proc);
    return { ok: true, forced: true };
}

function killTree(proc) {
    if (os.platform() === 'win32') {
        // The java process may own children: kill the tree the way the task manager would.
        execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => undefined);
    } else {
        proc.kill('SIGTERM');
        setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        }, 4000).unref();
    }
}

/* ── create flow (same steps as `pnx init`, log line by line) ─────────────── */

async function createServer(dir, { tag, name, memory } = {}) {
    const { release, server, http } = await cliModules();
    // Log lines travel as i18n keys + params: the renderer formats them in
    // whatever language the user picked, the main process never speaks French.
    const log = (key, params = [], kind = undefined) => send('create:log', { key, params, kind });

    if (existsSync(join(dir, JAR_NAME))) {
        return { ok: false, error: 'exists', dir };
    }

    log('create.log.dir', [dir]);
    await fsp.mkdir(dir, { recursive: true });

    log('create.log.versions');
    const releases = await release.listReleases();
    const wanted = releases.find((r) => r.tag === tag) ?? releases.find((r) => !r.prerelease) ?? releases[0];
    if (!wanted) return { ok: false, error: 'no-releases' };
    log('create.log.chosen', [wanted.tag], 'ok');

    const jarPath = join(dir, JAR_NAME);
    let lastPercent = -1;
    await release.downloadCore(wanted, jarPath, (progress) => {
        const pct = progress.percent === null ? null : Math.floor(progress.percent);
        if (pct !== lastPercent) {
            lastPercent = pct;
            send('create:progress', progress);
        }
    });
    const size = wanted.assets.find((a) => a.name === JAR_NAME)?.size ?? 0;
    log('create.log.jar', [`${(size / 1024 / 1024).toFixed(0)} MB`], 'ok');

    for (const script of server.officialStartScripts()) {
        try {
            await http.downloadFile(script.url, join(dir, script.name));
            log('create.log.script', [script.name], 'ok');
        } catch (cause) {
            // the scripts are a convenience for the app-less user; the app does not need them
            log('create.log.scriptFailed', [script.name, errText(cause)], 'warn');
        }
    }
    await server.setDefaultServer(dir);
    const entry = await registerServerEntry(dir, { tag: wanted.tag, name, memory, activate: true });
    log('create.log.registered', [], 'ok');

    return { ok: true, dir, tag: wanted.tag, size, entry };
}

/** a fresh, unused folder for a new server, under the one picked or ~/PowerNukkitX */
async function suggestDir(base) {
    const isFree = async (dir) => {
        if (!existsSync(dir)) return true;
        try { return (await fsp.readdir(dir)).length === 0; } catch { return false; }
    };
    if (base && await isFree(base)) return base;
    const root = base || join(os.homedir(), 'PowerNukkitX');
    for (let index = 1; index < 100; index++) {
        const candidate = join(root, index === 1 ? 'pnx-server' : `pnx-server-${index}`);
        if (await isFree(candidate)) return candidate;
    }
    return join(root, `pnx-server-${Date.now()}`);
}

/* ── plugins: one server's own plugins/ folder, enriched by the CLI registry ─ */

const PLUGIN_FILE = /^[^\\/:*?"<>|]+\.jar(\.disabled)?$/i;

/** files ({fileName, size}) of one plugins/ folder, enriched by the CLI registry */
async function describePlugins(files) {
    const { plugins } = await cliModules();
    const registry = await plugins.getInstalled().catch(() => []);
    const list = [];
    for (const { fileName: name, size } of files) {
        if (!PLUGIN_FILE.test(name)) continue;
        const enabled = !/\.disabled$/i.test(name);
        const jarName = name.replace(/\.disabled$/i, '');
        const tracked = registry.find((it) => it.fileName === jarName);
        list.push({
            fileName: name,
            jarName,
            enabled,
            size,
            slug: tracked?.slug ?? null,
            name: tracked?.name ?? jarName.replace(/\.jar$/i, '').replace(/[-_]+/g, ' '),
            version: tracked?.version ?? null,
            installedAt: tracked?.installedAt ?? null,
        });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
}

async function scanPlugins(root) {
    const pluginsDir = join(root, 'plugins');
    if (!existsSync(pluginsDir)) return { pluginsDir, list: [] };
    const files = [];
    for (const name of await fsp.readdir(pluginsDir)) {
        if (!PLUGIN_FILE.test(name)) continue;
        let size = 0;
        try { size = (await fsp.stat(join(pluginsDir, name))).size; } catch { /* vanished */ }
        files.push({ fileName: name, size });
    }
    return { pluginsDir, list: await describePlugins(files) };
}

async function pluginUpdates(list) {
    const { plugins } = await cliModules();
    const updates = {};
    await Promise.all(list.filter((it) => it.slug).map(async (it) => {
        try {
            const detail = await plugins.getPluginDetail(it.slug);
            const latest = String(detail.latest_version || '').replace(/^v/i, '');
            if (latest && it.version && latest !== String(it.version).replace(/^v/i, '')) updates[it.slug] = latest;
        } catch { /* hub down: no news is not an update */ }
    }));
    return updates;
}

ipcMain.handle('plugins:search', async (_event, { q, sort, limit, page } = {}) => {
    try {
        const { plugins } = await cliModules();
        return { ok: true, ...(await plugins.searchPlugins({ q, sort, page, limit: limit ?? 24 })) };
    } catch (cause) {
        return { ok: false, error: errText(cause) };
    }
});

ipcMain.handle('plugins:detail', async (_event, { slug } = {}) => {
    try {
        const { plugins } = await cliModules();
        return { ok: true, detail: await plugins.getPluginDetail(String(slug)) };
    } catch (cause) {
        return { ok: false, error: errText(cause) };
    }
});

ipcMain.handle('plugins:installed', async (_event, { dir } = {}) => {
    const root = await targetDir(dir);
    if (!root) return { ok: false, error: 'no-server', list: [] };
    try {
        const { pluginsDir, list } = await scanPlugins(root);
        return { ok: true, dir: root, pluginsDir, list };
    } catch (cause) {
        return { ok: false, error: errText(cause), list: [] };
    }
});

/** compares the hub's latest approved release with what each tracked jar says */
ipcMain.handle('plugins:updates', async (_event, { dir } = {}) => {
    const root = await targetDir(dir);
    if (!root) return { ok: false, error: 'no-server', updates: {} };
    const { plugins } = await cliModules();
    const { list } = await scanPlugins(root);
    const updates = {};
    await Promise.all(list.filter((it) => it.slug).map(async (it) => {
        try {
            const detail = await plugins.getPluginDetail(it.slug);
            const latest = String(detail.latest_version || '').replace(/^v/i, '');
            if (latest && it.version && latest !== String(it.version).replace(/^v/i, '')) updates[it.slug] = latest;
        } catch { /* hub down: no news is not an update */ }
    }));
    return { ok: true, updates };
});

ipcMain.handle('plugins:install', async (_event, { slug, dir } = {}) => {
    const { plugins } = await cliModules();
    if (!slug || typeof slug !== 'string') return { ok: false, error: 'no-slug' };
    const root = await targetDir(dir);
    if (!root) return { ok: false, error: 'no-server' };
    const pluginsDir = join(root, 'plugins');
    try {
        const old = (await plugins.getInstalled()).find((it) => it.slug === slug);
        const entry = await plugins.installPlugin(slug, pluginsDir, (progress, file) => {
            send('plugin:progress', {
                slug,
                file,
                percent: progress.percent === null ? null : Math.floor(progress.percent),
                received: progress.received,
            });
        });
        // a newer build under another file name: retire the old jar, or PNX
        // would load two copies of the same plugin next boot
        if (old && old.fileName !== entry.fileName) {
            await fsp.rm(join(pluginsDir, old.fileName), { force: true }).catch(() => {});
            await fsp.rm(join(pluginsDir, `${old.fileName}.disabled`), { force: true }).catch(() => {});
        }
        const needsRestart = Boolean(running.proc) && sameDir(running.dir, root);
        return { ok: true, entry, pluginsDir, needsRestart };
    } catch (cause) {
        return { ok: false, error: errText(cause) };
    }
});

ipcMain.handle('plugins:toggle', async (_event, { dir, fileName, enabled } = {}) => {
    const root = await targetDir(dir);
    if (!root) return { ok: false, error: 'no-server' };
    if (typeof fileName !== 'string' || !PLUGIN_FILE.test(fileName)) return { ok: false, error: 'invalid' };
    const jar = fileName.replace(/\.disabled$/i, '');
    const from = join(root, 'plugins', fileName);
    const to = join(root, 'plugins', enabled ? jar : `${jar}.disabled`);
    if (from === to) return { ok: true };
    try {
        await fsp.rename(from, to);
        return { ok: true, needsRestart: Boolean(running.proc) && sameDir(running.dir, root) };
    } catch (cause) {
        return { ok: false, error: errText(cause) };
    }
});

ipcMain.handle('plugins:remove', async (_event, { dir, fileName } = {}) => {
    const root = await targetDir(dir);
    if (!root) return { ok: false, error: 'no-server' };
    if (typeof fileName !== 'string' || !PLUGIN_FILE.test(fileName)) return { ok: false, error: 'invalid' };
    const { plugins } = await cliModules();
    await fsp.rm(join(root, 'plugins', fileName), { force: true });
    // the registry is shared by every server: forget the plugin only when no
    // other tracked server still carries that jar
    const jar = fileName.replace(/\.disabled$/i, '');
    const entry = (await plugins.getInstalled()).find((it) => it.fileName === jar);
    if (entry) {
        const state = await readState();
        const elsewhere = (state.servers || []).some((it) => !sameDir(it.dir, root)
            && (existsSync(join(it.dir, 'plugins', jar)) || existsSync(join(it.dir, 'plugins', `${jar}.disabled`))));
        if (!elsewhere) await plugins.removeInstalled(entry.slug);
    }
    return { ok: true, needsRestart: Boolean(running.proc) && sameDir(running.dir, root) };
});

/* ── backups: async sizes, cached, so a big world never freezes the window ── */

const sizeCache = new Map();

async function dirSizeAsync(dir) {
    let total = 0;
    const walk = async (path) => {
        let entries;
        try { entries = await fsp.readdir(path, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = join(path, entry.name);
            if (entry.isDirectory()) await walk(full);
            else {
                try { total += (await fsp.stat(full)).size; } catch { /* vanished */ }
            }
        }
    };
    await walk(dir);
    return total;
}

const BACKUP_NAME = /^pnx-backup-[0-9T-]+$/;

/* ── system: what this machine can give a server ──────────────────────────── */

function lanAddresses() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const it of list || []) {
            if (it.family === 'IPv4' && !it.internal) out.push({ name, address: it.address });
        }
    }
    // the usual home LAN ranges first: those are the ones a friend can join
    const rank = (a) => (/^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
    return out.sort((a, b) => rank(a.address) - rank(b.address));
}

function checkUdpPort(port) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', (cause) => {
            try { socket.close(); } catch { /* closed */ }
            resolve({ free: false, code: cause.code || 'error' });
        });
        socket.bind(port, '0.0.0.0', () => {
            socket.close(() => resolve({ free: true }));
        });
    });
}

/* ── servers on a VPS: SSH routes, state polling ──────────────────────────── */

const remote = require('./remote.cjs')({ send, cliModules, launchArgs, safeStorage, errText });

/** last known state per remote server (key: registry dir, lowercased) */
const remoteStates = new Map();
const remoteStopping = new Set();
const remoteNextPoll = new Map();

const isRemoteDir = (dir) => typeof dir === 'string' && /^ssh:\/\//i.test(dir.trim());

async function remoteEntryByDir(dir) {
    if (!isRemoteDir(dir)) return null;
    const state = await readState();
    return (state.servers || []).find((it) => it.remote && sameDir(it.dir, dir)) || null;
}

/** handlers that act on the active server when no dir is given */
const DEFAULTS_TO_ACTIVE = new Set([
    'config:read', 'plugins:installed', 'plugins:updates', 'plugins:install', 'plugins:toggle', 'plugins:remove',
    'backup:list', 'backup:create', 'backup:restore', 'backup:delete', 'core:update', 'shell:openFolder', 'shell:openFile',
]);

async function remoteTarget(name, payload) {
    const dir = typeof payload === 'string' ? payload : payload?.dir;
    if (dir) return remoteEntryByDir(dir);
    if (!DEFAULTS_TO_ACTIVE.has(name)) return null;
    const active = await activeServerEntry();
    return active?.remote ? active : null;
}

function remoteError(cause) {
    const text = errText(cause);
    if (/^(remote-|auth-failed|timeout|key-|hostkey-changed|ssh-missing|no-keychain|invalid)/.test(text)) return text;
    if (/ECONNREFUSED/.test(text)) return 'remote-refused';
    if (/ENOTFOUND|EAI_AGAIN/.test(text)) return 'remote-dns';
    if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(text)) return 'timeout';
    return text;
}

function publishRemote(entry, next, extra = {}) {
    const key = entry.dir.toLowerCase();
    const prev = remoteStates.get(key);
    remoteStates.set(key, next);
    const moved = !prev || prev.state !== next.state || prev.startedAt !== next.startedAt;
    if (!moved && !extra.force) return;
    const wasRunning = prev && !['stopped', 'offline', 'unknown'].includes(prev.state);
    const requested = remoteStopping.has(key);
    if (next.state === 'stopped') remoteStopping.delete(key);
    if (wasRunning && next.state === 'stopped') {
        const crashed = !requested && next.failed;
        send('server:exit', { dir: entry.dir, code: next.failed ? 1 : 0, crashed, willRestart: Boolean(next.restarting) });
    }
    send('server:state', {
        dir: entry.dir,
        state: next.state,
        pid: next.pid,
        startedAt: next.startedAt,
        memory: entry.memory,
        remote: true,
        crashed: next.state === 'stopped' && Boolean(next.failed) && !requested,
    });
    if (!['stopped', 'offline', 'unknown'].includes(next.state)) void remote.startTail(entry);
}

async function pollRemote(entry, { force = false } = {}) {
    const key = entry.dir.toLowerCase();
    if (!force && (remoteNextPoll.get(key) || 0) > Date.now()) return;
    remoteNextPoll.set(key, Date.now() + 3500);
    try {
        const st = await remote.status(entry);
        publishRemote(entry, { ...st, reachable: true }, { force });
    } catch (cause) {
        // unreachable: say so, then back off so a dead VPS costs nothing
        remoteNextPoll.set(key, Date.now() + 30000);
        publishRemote(entry, { state: 'offline', reachable: false, error: remoteError(cause) }, { force });
    }
}

async function pollRemotes() {
    if (!win || win.isDestroyed()) return;
    const state = await readState().catch(() => null);
    for (const entry of state?.servers || []) {
        if (entry.remote) void pollRemote(entry);
    }
}

async function memoryFor(entry, asked) {
    const state = await readState();
    return [asked, entry?.memory, state.memory].find((it) => MEMORY_CHOICES.includes(it)) || DEFAULT_MEMORY;
}

async function remoteRunning(entry) {
    const st = await remote.status(entry);
    publishRemote(entry, { ...st, reachable: true });
    return !['stopped'].includes(st.state);
}

const clean = (text) => String(text ?? '').replace(/[\r\n\u0000]/g, '').trim().replace(/^\//, '');

REMOTE_ROUTES.set('server:start', async (entry, { memory }) => {
    if (remoteStates.get(entry.dir.toLowerCase())?.state === 'online') return { ok: false, error: 'running' };
    const mem = await memoryFor(entry, memory);
    const res = await remote.start(entry, mem);
    remoteStopping.delete(entry.dir.toLowerCase());
    setTimeout(() => void pollRemote(entry, { force: true }), 600);
    return res;
});
REMOTE_ROUTES.set('server:stop', async (entry) => {
    remoteStopping.add(entry.dir.toLowerCase());
    publishRemote(entry, { ...(remoteStates.get(entry.dir.toLowerCase()) || {}), state: 'stopping' });
    const res = await remote.stop(entry);
    await pollRemote(entry, { force: true });
    return res;
});
REMOTE_ROUTES.set('server:restart', async (entry) => {
    remoteStopping.add(entry.dir.toLowerCase());
    const res = await remote.restart(entry, await memoryFor(entry));
    remoteStopping.delete(entry.dir.toLowerCase());
    setTimeout(() => void pollRemote(entry, { force: true }), 600);
    return res;
});
REMOTE_ROUTES.set('server:command', async (entry, { text }) => {
    const value = clean(text);
    if (!value || value.length > 512) return { ok: false, error: 'invalid' };
    return remote.command(entry, value);
});
REMOTE_ROUTES.set('config:read', (entry) => remote.readConfig(entry));
REMOTE_ROUTES.set('config:write', async (entry, { which, text }) => {
    if (!['pnx.yml', 'server.properties'].includes(which) || typeof text !== 'string') return { ok: false, error: 'invalid' };
    return remote.writeConfig(entry, which, text);
});
REMOTE_ROUTES.set('plugins:installed', async (entry) => ({
    ok: true, dir: entry.dir, pluginsDir: `${entry.remote.path}/plugins`, list: await describePlugins(await remote.listPlugins(entry)),
}));
REMOTE_ROUTES.set('plugins:updates', async (entry) => ({
    ok: true, updates: await pluginUpdates(await describePlugins(await remote.listPlugins(entry))),
}));
REMOTE_ROUTES.set('plugins:install', async (entry, { slug }) => {
    if (!slug || typeof slug !== 'string') return { ok: false, error: 'no-slug' };
    const result = await remote.installPlugin(entry, slug, (progress, file) => send('plugin:progress', {
        slug, file, percent: progress.percent === null ? null : Math.floor(progress.percent), received: progress.received,
    }));
    const st = remoteStates.get(entry.dir.toLowerCase());
    return { ok: true, entry: result, needsRestart: Boolean(st) && !['stopped', 'offline'].includes(st.state) };
});
REMOTE_ROUTES.set('plugins:toggle', async (entry, { fileName, enabled }) => {
    if (typeof fileName !== 'string' || !PLUGIN_FILE.test(fileName)) return { ok: false, error: 'invalid' };
    const jar = fileName.replace(/\.disabled$/i, '');
    const to = enabled ? jar : `${jar}.disabled`;
    if (to !== fileName) await remote.renamePlugin(entry, fileName, to);
    return { ok: true, needsRestart: remoteStates.get(entry.dir.toLowerCase())?.state === 'online' };
});
REMOTE_ROUTES.set('plugins:remove', async (entry, { fileName }) => {
    if (typeof fileName !== 'string' || !PLUGIN_FILE.test(fileName)) return { ok: false, error: 'invalid' };
    await remote.removePlugin(entry, fileName);
    return { ok: true, needsRestart: remoteStates.get(entry.dir.toLowerCase())?.state === 'online' };
});
REMOTE_ROUTES.set('backup:list', async (entry) => ({ ok: true, dir: entry.dir, backups: await remote.backupList(entry) }));
REMOTE_ROUTES.set('backup:create', async (entry) => {
    const res = await backupRemote(entry);
    send('backup:event', { kind: 'created', name: res.name, hot: res.hot });
    return { ok: true, ...res };
});
REMOTE_ROUTES.set('backup:restore', async (entry, { name }) => {
    if (await remoteRunning(entry)) return { ok: false, error: 'running' };
    await remote.backupRestore(entry, name);
    send('backup:event', { kind: 'restored', name });
    return { ok: true };
});
REMOTE_ROUTES.set('backup:delete', async (entry, { name }) => {
    await remote.backupDelete(entry, name);
    send('backup:event', { kind: 'deleted', name });
    return { ok: true };
});
REMOTE_ROUTES.set('core:update', async (entry, { tag }) => {
    if (await remoteRunning(entry)) return { ok: false, error: 'running' };
    const { release } = await cliModules();
    const releases = await release.listReleases();
    const wanted = releases.find((r) => r.tag === tag) ?? releases.find((r) => !r.prerelease);
    const asset = wanted && release.findAsset(wanted);
    if (!asset) return { ok: false, error: 'no-releases' };
    await remote.coreUpdate(entry, asset.url);
    await patchServerEntry(entry.id, { tag: wanted.tag });
    return { ok: true, tag: wanted.tag };
});
REMOTE_ROUTES.set('net:checkPort', async (entry, { port }) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: 'invalid' };
    const st = remoteStates.get(entry.dir.toLowerCase());
    if (st && !['stopped', 'offline'].includes(st.state)) return { ok: true, port: p, free: false, ownServer: true };
    return { ok: true, port: p, ...(await remote.checkPort(entry, p)) };
});
REMOTE_ROUTES.set('system:info', (entry) => remote.sysinfo(entry));
// a VPS has no folder to open on this computer
REMOTE_ROUTES.set('shell:openFolder', async () => false);
REMOTE_ROUTES.set('shell:openFile', async () => false);

/* ── hot backups: the world is copied while the server keeps running ─────── */

/*
 * `save-off` stops the server writing chunks, `save-all` flushes what it holds,
 * the copy runs, `save-on` gives the world back. The world on disk is then
 * consistent; players notice nothing but a line in the console.
 */
const HOT_SETTLE_MS = 6000;
const backupsBusy = new Set();

async function backupLocal(root, { auto = false } = {}) {
    const key = root.toLowerCase();
    if (backupsBusy.has(key)) throw new Error('backup-busy');
    backupsBusy.add(key);
    // a server started from a terminal (`pnx start`) is flushed the same way,
    // through the CLI's control socket instead of our own stdin
    const term = await terminalRun(root);
    const viaTerminal = Boolean(term?.control);
    const live = viaTerminal || (Boolean(running.proc) && sameDir(running.dir, root) && running.state === 'online');
    const write = (line) => {
        if (viaTerminal) { void V.proc.sendControl(term, line); return; }
        try { running.proc?.stdin.write(`${line}\n`); } catch { /* gone */ }
    };
    try {
        if (term && !viaTerminal) throw new Error('running');
        if (running.proc && sameDir(running.dir, root) && !live) throw new Error('running');
        if (live) {
            write('save-off');
            write('save-all');
            await new Promise((r) => setTimeout(r, HOT_SETTLE_MS));
        }
        const { backup } = await cliModules();
        const result = await backup.createBackup(root);
        if (auto) await fsp.writeFile(join(result.path, '.auto'), '').catch(() => {});
        return { name: basename(result.path), size: result.size, hot: live };
    } finally {
        if (live) write('save-on');
        backupsBusy.delete(key);
    }
}

/* ── servers started from a terminal with `pnx start` ─────────────────────
   The CLI records its server in ~/.pnx-cli/pid.json, with a token-guarded
   control socket. The app adopts such a server instead of calling it
   stopped (and offering a second start on the same port): it shows it online,
   follows its log file in the console, and types commands - `stop` included -
   through the very socket `pnx cmd` and `pnx stop` use. */

const terminal = { record: null, tail: null };

/** The terminal-started server for `dir` (any dir when omitted), or null. */
async function terminalRun(dir) {
    const { proc } = await cliModules();
    const record = await proc.loadPid().catch(() => null);
    if (!record || !proc.isAlive(record.pid)) return null;
    if (running.proc && running.pid === record.pid) return null;
    if (dir && !sameDir(record.serverPath, dir)) return null;
    return record;
}

const terminalState = (record, state) => ({
    dir: record.serverPath,
    state,
    pid: record.pid,
    startedAt: Date.parse(record.startedAt) || null,
    memory: null,
    terminal: true,
    controllable: Boolean(record.control),
});

/** Streams new lines of logs/server.log into the console, from the last 40. */
function startTail(dir) {
    stopTail();
    const file = join(dir, 'logs', 'server.log');
    let pos = -1;
    let busy = false;
    const read = async () => {
        if (busy) return;
        busy = true;
        try {
            const size = (await fsp.stat(file)).size;
            const first = pos < 0;
            if (first) pos = Math.max(0, size - 16 * 1024); // a short backlog first
            const cut = first && pos > 0;
            if (size < pos) pos = 0; // rotated
            if (size === pos) return;
            const length = Math.min(size - pos, 1 << 20);
            const handle = await fsp.open(file, 'r');
            try {
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, pos);
                pos += length;
                let lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
                if (cut) lines = lines.slice(1); // the first line was cut in half
                if (first) lines = lines.slice(-40);
                if (lines.length) send('server:line', { dir, lines, stream: 'stdout' });
            } finally {
                await handle.close();
            }
        } catch {
            // no log yet: the server is still booting
        } finally {
            busy = false;
        }
    };
    void read();
    terminal.tail = setInterval(() => void read(), 1000);
}

function stopTail() {
    if (terminal.tail) clearInterval(terminal.tail);
    terminal.tail = null;
}

async function pollTerminal() {
    const record = await terminalRun().catch(() => null);
    const prev = terminal.record;
    if (record && (!prev || prev.pid !== record.pid)) {
        terminal.record = record;
        send('server:state', terminalState(record, 'online'));
        send('server:line', {
            dir: record.serverPath,
            lines: ['[PowerNukkitX] Started from a terminal (pnx start): its log is followed here, and commands go through pnx.'],
            stream: 'assistant',
        });
        startTail(record.serverPath);
    } else if (!record && prev) {
        terminal.record = null;
        stopTail();
        send('server:state', { ...terminalState(prev, 'stopped'), pid: null, startedAt: null });
        send('server:exit', { dir: prev.serverPath, code: 0, crashed: false, willRestart: false });
    }
}

/** `stop` on the terminal server's console (the world is saved), or a kill. */
async function stopTerminal(record, force) {
    const { proc } = await cliModules();
    if (force) {
        await proc.killProcess(record.pid);
        return { ok: true };
    }
    const how = await proc.requestStop(record);
    if (how === 'none') return { ok: false, error: 'not-controllable' };
    send('server:state', terminalState(record, 'stopping'));
    return { ok: true };
}

async function backupRemote(entry, { auto = false } = {}) {
    const key = entry.dir.toLowerCase();
    if (backupsBusy.has(key)) throw new Error('backup-busy');
    backupsBusy.add(key);
    let live = false;
    try {
        const st = await remote.status(entry);
        publishRemote(entry, { ...st, reachable: true });
        if (st.state === 'starting' || st.state === 'stopping') throw new Error('running');
        live = st.state === 'online';
        if (live) {
            await remote.command(entry, 'save-off');
            await remote.command(entry, 'save-all');
            await new Promise((r) => setTimeout(r, HOT_SETTLE_MS));
        }
        const res = await remote.backupCreate(entry, { auto });
        return { ...res, hot: live };
    } finally {
        if (live) await remote.command(entry, 'save-on').catch(() => {});
        backupsBusy.delete(key);
    }
}

/** keeps the newest `keep` automatic backups; manual ones are never touched */
async function pruneAuto(entry, keep) {
    if (!keep || keep < 1) return 0;
    let list;
    if (entry.remote) list = await remote.backupList(entry);
    else {
        const dir = join(entry.dir, 'backups');
        if (!existsSync(dir)) return 0;
        list = [];
        for (const name of await fsp.readdir(dir)) {
            if (BACKUP_NAME.test(name) && existsSync(join(dir, name, '.auto'))) list.push({ name, auto: true });
        }
    }
    const autos = list.filter((b) => b.auto).sort((a, b) => b.name.localeCompare(a.name));
    let removed = 0;
    for (const old of autos.slice(keep)) {
        if (entry.remote) await remote.backupDelete(entry, old.name);
        else await fsp.rm(join(entry.dir, 'backups', old.name), { recursive: true, force: true });
        removed++;
    }
    return removed;
}

/* ── scheduler: automatic backups and a daily restart, with warnings ────── */

const SCHEDULE_EVERY = [0, 1, 2, 3, 6, 12, 24];
const SCHEDULE_KEEP = [3, 5, 10, 20, 50];
const WARNINGS = [{ at: 300, key: 'm5' }, { at: 60, key: 'm1' }, { at: 10, key: 's10' }];

/** what players read in chat, in the assistant's language (the closest guess we have) */
const CHAT = {
    fr: { m5: 'Redémarrage du serveur dans 5 minutes.', m1: 'Redémarrage du serveur dans 1 minute.', s10: 'Redémarrage dans 10 secondes — à tout de suite !' },
    en: { m5: 'Server restart in 5 minutes.', m1: 'Server restart in 1 minute.', s10: 'Restarting in 10 seconds — see you soon!' },
    es: { m5: 'Reinicio del servidor en 5 minutos.', m1: 'Reinicio del servidor en 1 minuto.', s10: 'Reinicio en 10 segundos. ¡Hasta ahora!' },
    de: { m5: 'Server-Neustart in 5 Minuten.', m1: 'Server-Neustart in 1 Minute.', s10: 'Neustart in 10 Sekunden – bis gleich!' },
    pt: { m5: 'Reinício do servidor em 5 minutos.', m1: 'Reinício do servidor em 1 minuto.', s10: 'Reiniciando em 10 segundos — até já!' },
};

function cleanSchedule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const every = SCHEDULE_EVERY.includes(Number(raw.backupEvery)) ? Number(raw.backupEvery) : 0;
    const keep = SCHEDULE_KEEP.includes(Number(raw.keep)) ? Number(raw.keep) : 10;
    const restartAt = typeof raw.restartAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.restartAt) ? raw.restartAt : null;
    return { backupEvery: every, keep, restartAt, warn: raw.warn !== false };
}

const schedRuntime = new Map(); // key → { warned: Set, restartDay }
let schedBusy = false;

function isOnline(entry) {
    if (entry.remote) return remoteStates.get(entry.dir.toLowerCase())?.state === 'online';
    return Boolean(running.proc) && sameDir(running.dir, entry.dir) && running.state === 'online';
}

async function sayTo(entry, text) {
    const line = `say ${text}`;
    if (entry.remote) return remote.command(entry, line).catch(() => null);
    try { running.proc?.stdin.write(`${line}\n`); } catch { /* gone */ }
    return null;
}

async function restartEntry(entry) {
    if (entry.remote) {
        remoteStopping.add(entry.dir.toLowerCase());
        const res = await remote.restart(entry, entry.memory);
        remoteStopping.delete(entry.dir.toLowerCase());
        setTimeout(() => void pollRemote(entry, { force: true }), 600);
        return res;
    }
    const { dir, memory } = running;
    const stopped = await stopServer();
    if (!stopped.ok) return stopped;
    for (let index = 0; index < 60 && running.proc; index++) await new Promise((r) => setTimeout(r, 100));
    if (running.proc) return { ok: false, error: 'still-running' };
    return startServer(dir, memory);
}

function dayKey(date) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

async function tickScheduler() {
    if (schedBusy) return;
    schedBusy = true;
    try {
        const state = await readState();
        const lang = CHAT[state.lang] ? state.lang : 'en';
        for (const entry of state.servers || []) {
            const sch = cleanSchedule(entry.schedule);
            if (!sch) continue;
            const key = entry.dir.toLowerCase();
            const rt = schedRuntime.get(key) || { warned: new Set(), restartDay: null };
            schedRuntime.set(key, rt);
            const now = new Date();

            // daily restart, announced in chat
            if (sch.restartAt && isOnline(entry) && rt.restartDay !== dayKey(now)) {
                const [hh, mm] = sch.restartAt.split(':').map(Number);
                const target = new Date(now);
                target.setHours(hh, mm, 0, 0);
                const left = (target.getTime() - now.getTime()) / 1000;
                if (left <= 0 && left > -120) {
                    rt.restartDay = dayKey(now);
                    rt.warned.clear();
                    send('server:line', { dir: entry.dir, lines: ['[PowerNukkitX] scheduled restart…'], stream: 'assistant' });
                    const res = await restartEntry(entry);
                    notifier.scheduled(entry, res?.ok !== false);
                    continue;
                }
                if (sch.warn) {
                    for (const w of WARNINGS) {
                        // only the warning whose moment is now: "in 5 minutes" said
                        // 75 s before the restart would be a lie
                        if (left > 0 && left <= w.at && left > w.at - 14 && !rt.warned.has(w.key)) {
                            rt.warned.add(w.key);
                            await sayTo(entry, CHAT[lang][w.key]);
                        }
                    }
                }
            }

            // automatic backup while the server runs (a stopped world does not change)
            if (sch.backupEvery > 0 && isOnline(entry)) {
                const last = Date.parse(entry.schedule.lastAuto || '') || 0;
                if (Date.now() - last >= sch.backupEvery * 3600 * 1000) {
                    await patchServerEntry(entry.id, { schedule: { ...entry.schedule, lastAuto: new Date().toISOString() } });
                    try {
                        const res = entry.remote ? await backupRemote(entry, { auto: true }) : await backupLocal(entry.dir, { auto: true });
                        await pruneAuto(entry, sch.keep).catch(() => 0);
                        send('backup:event', { kind: 'created', name: res.name, auto: true, dir: entry.dir });
                    } catch (cause) {
                        if (errText(cause) !== 'backup-busy') notifier.backupFailed(entry, remoteError(cause));
                    }
                }
            }
        }
    } finally {
        schedBusy = false;
    }
}

/* ── notifications: what matters when the window is not looked at ─────── */

const NOTE = {
    fr: { crash: '« %s » s’est arrêté de façon inattendue', crashBody: 'Code %s. Ouvre l’application pour lire la console.', restarting: 'Redémarrage automatique dans 5 s.', join: '%s a rejoint « %s »', backupFail: 'Sauvegarde automatique échouée — « %s »', restarted: '« %s » redémarré comme prévu', restartFail: 'Le redémarrage planifié de « %s » a échoué' },
    en: { crash: '“%s” stopped unexpectedly', crashBody: 'Code %s. Open the app to read the console.', restarting: 'Restarting automatically in 5 s.', join: '%s joined “%s”', backupFail: 'Automatic backup failed — “%s”', restarted: '“%s” restarted as scheduled', restartFail: 'The scheduled restart of “%s” failed' },
    es: { crash: '«%s» se detuvo inesperadamente', crashBody: 'Código %s. Abre la app para leer la consola.', restarting: 'Reinicio automático en 5 s.', join: '%s entró en «%s»', backupFail: 'Copia automática fallida — «%s»', restarted: '«%s» reiniciado según lo previsto', restartFail: 'Falló el reinicio programado de «%s»' },
    de: { crash: '„%s“ wurde unerwartet beendet', crashBody: 'Code %s. Öffne die App, um die Konsole zu lesen.', restarting: 'Automatischer Neustart in 5 s.', join: '%s ist „%s“ beigetreten', backupFail: 'Automatisches Backup fehlgeschlagen – „%s“', restarted: '„%s“ wie geplant neu gestartet', restartFail: 'Geplanter Neustart von „%s“ fehlgeschlagen' },
    pt: { crash: '“%s” parou inesperadamente', crashBody: 'Código %s. Abra o aplicativo para ler o console.', restarting: 'Reinício automático em 5 s.', join: '%s entrou em “%s”', backupFail: 'Backup automático falhou — “%s”', restarted: '“%s” reiniciado como programado', restartFail: 'O reinício programado de “%s” falhou' },
};
const fmt = (text, ...params) => params.reduce((acc, p) => acc.replace('%s', String(p)), text);

const notifier = (() => {
    let prefs = { notify: true, notifyJoins: false, lang: 'en', servers: [] };
    const refresh = async () => {
        const state = await readState().catch(() => null);
        if (!state) return;
        prefs = {
            notify: state.notify !== false,
            notifyJoins: state.notifyJoins === true,
            lang: NOTE[state.lang] ? state.lang : 'en',
            servers: state.servers || [],
        };
    };
    const nameOf = (dir) => prefs.servers.find((it) => sameDir(it.dir, dir))?.name || basename(String(dir || ''));
    const show = (title, body, { always = false } = {}) => {
        if (!prefs.notify || !Notification.isSupported()) return;
        // a person looking at the window already sees it there
        if (!always && win && !win.isDestroyed() && win.isFocused() && win.isVisible()) return;
        const note = new Notification({ title, body: body || '', silent: false });
        note.on('click', () => {
            if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
        });
        note.show();
    };
    const JOIN = / joined the game\.?$| a rejoint la partie\.?$| ist dem Spiel beigetreten\.?$| entrou no jogo\.?$| se ha unido a la partida\.?$/i;
    // eslint-disable-next-line no-control-regex
    const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|§[0-9a-fk-orx]/gi;
    return {
        refresh,
        observe(channel, payload) {
            const t = NOTE[prefs.lang];
            if (channel === 'server:exit' && payload?.crashed) {
                show(fmt(t.crash, nameOf(payload.dir)), payload.willRestart ? t.restarting : fmt(t.crashBody, payload.code ?? '?'));
            } else if (channel === 'server:line' && prefs.notifyJoins && payload?.stream !== 'assistant') {
                for (const raw of payload.lines || []) {
                    const line = String(raw).replace(ANSI, '');
                    const m = line.match(JOIN);
                    if (!m) continue;
                    let head = line.slice(0, m.index).trimEnd();
                    const cut = Math.max(head.lastIndexOf('] '), head.lastIndexOf(' - '), head.lastIndexOf(': '));
                    if (cut >= 0) head = head.slice(cut + 2);
                    head = head.trim();
                    if (head && head.length <= 32) show(fmt(t.join, head, nameOf(payload.dir)), '');
                }
            }
        },
        backupFailed(entry, reason) {
            const t = NOTE[prefs.lang];
            show(fmt(t.backupFail, entry.name), reason, { always: true });
            send('backup:event', { kind: 'failed', dir: entry.dir, error: reason });
        },
        scheduled(entry, ok) {
            const t = NOTE[prefs.lang];
            show(fmt(ok ? t.restarted : t.restartFail, entry.name), '');
        },
    };
})();

/* ── IPC surface (mirrors preload.cjs exactly) ────────────────────────────── */

function registerIpc() {
    ipcMain.handle('servers:setSchedule', async (_event, { id, schedule } = {}) => {
        const clean = cleanSchedule(schedule);
        if (!clean) return { ok: false, error: 'invalid' };
        const state = await readState();
        const entry = (state.servers || []).find((it) => it.id === id);
        if (!entry) return { ok: false, error: 'unknown' };
        // switching backups on starts the clock now, not "overdue since 1970"
        const lastAuto = entry.schedule?.lastAuto || (clean.backupEvery ? new Date().toISOString() : null);
        await patchServerEntry(id, { schedule: { ...clean, lastAuto } });
        schedRuntime.delete(entry.dir.toLowerCase());
        return { ok: true, schedule: { ...clean, lastAuto } };
    });

    ipcMain.handle('servers:states', async () => {
        const out = [];
        if (running.proc) out.push({ dir: running.dir, state: running.state, pid: running.pid, startedAt: running.startedAt || null, memory: running.memory });
        const term = await terminalRun().catch(() => null);
        if (term) out.push(terminalState(term, 'online'));
        const state = await readState();
        for (const entry of state.servers || []) {
            const st = entry.remote && remoteStates.get(entry.dir.toLowerCase());
            if (st) out.push({ dir: entry.dir, state: st.state, pid: st.pid ?? null, startedAt: st.startedAt ?? null, memory: entry.memory, remote: true, error: st.error });
        }
        return out;
    });

    ipcMain.handle('remote:probe', async (_event, form = {}) => {
        if (!remote.available()) return { ok: false, error: 'ssh-missing' };
        try {
            return { ok: true, info: await remote.probe(form) };
        } catch (cause) {
            return { ok: false, error: remoteError(cause) };
        }
    });

    ipcMain.handle('remote:create', async (_event, form = {}) => {
        if (!remote.available()) return { ok: false, error: 'ssh-missing' };
        const log = (key, params = [], kind = undefined) => send('create:log', { key, params, kind });
        try {
            const res = await remote.provision(form, log);
            if (!res.ok) return res;
            const state = await readState();
            const servers = (state.servers || []).filter((it) => !sameDir(it.dir, res.dir));
            const entry = {
                id: randomUUID().slice(0, 10),
                name: String(form.name || '').trim().slice(0, 48) || `${res.remote.host}`,
                dir: res.dir,
                memory: MEMORY_CHOICES.includes(res.memory) ? res.memory : DEFAULT_MEMORY,
                tag: res.tag,
                addedAt: new Date().toISOString(),
                remote: res.remote,
            };
            servers.push(entry);
            await writeState({ servers, activeId: entry.id });
            log('create.log.registered', [], 'ok');
            void pollRemote(entry, { force: true });
            return { ok: true, dir: entry.dir, tag: res.tag, size: res.size, entry: { id: entry.id, name: entry.name }, firewall: res.firewall, remote: true };
        } catch (cause) {
            const error = remoteError(cause);
            send('create:log', { key: 'create.log.failure', params: [error], kind: 'error' });
            return { ok: false, error };
        }
    });

    ipcMain.handle('remote:uninstall', async (_event, { id, sudoPassword } = {}) => {
        const state = await readState();
        const entry = (state.servers || []).find((it) => it.id === id && it.remote);
        if (!entry) return { ok: false, error: 'unknown' };
        let removal = null;
        try {
            remoteStopping.add(entry.dir.toLowerCase());
            removal = await remote.uninstall(entry, { sudoPassword });
        } catch (cause) {
            return { ok: false, error: remoteError(cause) };
        }
        remoteStates.delete(entry.dir.toLowerCase());
        const rest = (state.servers || []).filter((it) => it.id !== id);
        await writeState({ servers: rest, activeId: state.activeId === id ? (rest[rest.length - 1]?.id ?? null) : state.activeId });
        return { ok: true, kept: Boolean(removal?.kept), path: entry.remote.path };
    });

    // choosing the install folder on the VPS, before anything is installed
    ipcMain.handle('remote:browse', async (_event, { form = {}, path } = {}) => {
        if (!remote.available()) return { ok: false, error: 'ssh-missing' };
        try {
            return { ok: true, ...(await remote.browse(form, path)) };
        } catch (cause) {
            return { ok: false, error: remoteError(cause) };
        }
    });

    ipcMain.handle('remote:checkPath', async (_event, { form = {}, path } = {}) => {
        if (!remote.available()) return { ok: false, error: 'ssh-missing' };
        const cleaned = remote.cleanRemotePath(path);
        if (cleaned.error) return { ok: false, error: cleaned.error };
        if (!form.host) return { ok: true, path: cleaned.path, state: 'unknown' };
        try {
            return await remote.checkPath(form, cleaned.path);
        } catch (cause) {
            return { ok: true, path: cleaned.path, state: 'unknown', error: remoteError(cause) };
        }
    });

    ipcMain.handle('dialog:pickFile', async (_event, { title } = {}) => {
        const sshDir = join(os.homedir(), '.ssh');
        const result = await dialog.showOpenDialog(win, {
            properties: ['openFile', 'showHiddenFiles'],
            title: title || 'PowerNukkitX',
            defaultPath: existsSync(sshDir) ? sshDir : os.homedir(),
        });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('app:about', () => ({
        app: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        cli: cliVersion(),
        platform: `${os.platform()} ${os.arch()}`,
        ssh: remote.available(),
    }));

    ipcMain.handle('dialog:pickFolder', async (_event, { title } = {}) => {
        const result = await dialog.showOpenDialog(win, {
            properties: ['openDirectory', 'createDirectory'],
            title: title || 'PowerNukkitX',
        });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('fs:validateDir', async (_event, dir) => {
        if (!dir || typeof dir !== 'string' || !dir.trim()) return { ok: false, reason: 'empty' };
        const jar = existsSync(join(dir, JAR_NAME));
        const exists = existsSync(dir);
        let empty = true;
        if (exists) {
            try { empty = (await fsp.readdir(dir)).length === 0; } catch { empty = false; }
        }
        return { ok: true, jar, exists, empty };
    });

    ipcMain.handle('fs:suggestDir', async (_event, { base } = {}) =>
        suggestDir(typeof base === 'string' && base.trim() ? base.trim() : null));

    ipcMain.handle('releases:list', async (_event, { force } = {}) => {
        try {
            const { release } = await cliModules();
            const releases = await release.listReleases(force === true);
            const firstStable = releases.find((r) => !r.prerelease);
            return {
                ok: true,
                releases: releases.map((r) => ({
                    tag: r.tag,
                    prerelease: r.prerelease,
                    latest: r === firstStable,
                    publishedAt: r.publishedAt || null,
                    size: r.assets.find((a) => a.name === JAR_NAME)?.size ?? 0,
                })),
            };
        } catch (cause) {
            return { ok: false, error: errText(cause) };
        }
    });

    ipcMain.handle('java:check', async () => {
        const { server } = await cliModules();
        return server.checkJava();
    });

    ipcMain.handle('system:info', async () => ({
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? '',
        platform: os.platform(),
        hostname: os.hostname(),
        lan: lanAddresses(),
    }));

    ipcMain.handle('net:checkPort', async (_event, { port } = {}) => {
        const p = Number(port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: 'invalid' };
        if (running.proc) return { ok: true, port: p, free: false, ownServer: true };
        return { ok: true, port: p, ...(await checkUdpPort(p)) };
    });

    ipcMain.handle('server:create', async (_event, { dir, tag, name, memory } = {}) => {
        if (!dir || typeof dir !== 'string') return { ok: false, error: 'no-dir' };
        try {
            return await createServer(dir.trim(), { tag, name, memory });
        } catch (cause) {
            const message = errText(cause);
            send('create:log', { key: 'create.log.failure', params: [message], kind: 'error' });
            return { ok: false, error: 'failed', message };
        }
    });

    ipcMain.handle('server:start', async (_event, { dir, memory } = {}) => {
        const root = await targetDir(dir);
        if (!root || !existsSync(join(root, JAR_NAME))) return { ok: false, error: 'no-jar' };
        // already running from a terminal: a second JVM would fight it for the port
        if (await terminalRun(root)) return { ok: false, error: 'running' };
        const state = await readState();
        const entry = (state.servers || []).find((it) => sameDir(it.dir, root));
        const mem = [memory, entry?.memory, state.memory].find((it) => MEMORY_CHOICES.includes(it)) || DEFAULT_MEMORY;
        crashLog.delete(root); // a start by hand resets the crash budget
        return startServer(root, mem);
    });

    ipcMain.handle('server:stop', async (_event, { force, dir } = {}) => {
        if (!running.proc || (dir && !sameDir(running.dir, dir))) {
            const term = await terminalRun(dir);
            if (term) return stopTerminal(term, force === true);
        }
        return stopServer({ force: force === true });
    });

    ipcMain.handle('server:restart', async () => {
        if (!running.proc) return { ok: false, error: 'not-running' };
        const { dir, memory } = running;
        const stopped = await stopServer();
        if (!stopped.ok) return stopped;
        // a forced kill may still be unwinding: wait for the process to be gone
        for (let index = 0; index < 60 && running.proc; index++) await new Promise((r) => setTimeout(r, 100));
        if (running.proc) return { ok: false, error: 'still-running' };
        return startServer(dir, memory);
    });

    ipcMain.handle('server:command', async (_event, { text, dir } = {}) => {
        if (typeof text !== 'string') return { ok: false, error: 'invalid' };
        // the console of a server takes commands without the leading slash
        const clean = text.replace(/[\r\n\u0000]/g, '').trim().replace(/^\//, '');
        if (!clean || clean.length > 512) return { ok: false, error: 'invalid' };
        const proc = running.proc;
        if (!proc || (dir && !sameDir(running.dir, dir))) {
            const term = await terminalRun(dir);
            if (term) {
                if (!term.control) return { ok: false, error: 'not-controllable' };
                const { proc: cliProc } = await cliModules();
                return (await cliProc.sendControl(term, clean)) ? { ok: true } : { ok: false, error: 'refused' };
            }
        }
        if (!proc) return { ok: false, error: 'not-running' };
        try {
            proc.stdin.write(`${clean}\n`);
        } catch (cause) {
            return { ok: false, error: errText(cause) };
        }
        return { ok: true };
    });

    ipcMain.handle('server:status', async () => {
        if (!running.proc) {
            const term = await terminalRun().catch(() => null);
            if (term) return { running: true, ...terminalState(term, 'online') };
        }
        return serverStatus();
    });

    const serverStatus = () => ({
        running: Boolean(running.proc),
        state: running.state,
        pid: running.pid,
        dir: running.dir,
        startedAt: running.startedAt || null,
        memory: running.memory,
    });

    ipcMain.handle('server:default', async () => {
        const active = await activeServerEntry();
        if (active) return active.dir;
        const { server } = await cliModules();
        return server.resolveServerDir().catch(() => null);
    });

    /** replaces powernukkitx.jar by another release; the old jar stays as .bak */
    ipcMain.handle('core:update', async (_event, { dir, tag } = {}) => {
        const root = await targetDir(dir);
        if (!root) return { ok: false, error: 'no-server' };
        if (running.proc && sameDir(running.dir, root)) return { ok: false, error: 'running' };
        if (await terminalRun(root)) return { ok: false, error: 'running' };
        const temp = join(root, `${JAR_NAME}.download`);
        try {
            const { release } = await cliModules();
            const releases = await release.listReleases();
            const wanted = releases.find((r) => r.tag === tag) ?? releases.find((r) => !r.prerelease);
            if (!wanted) return { ok: false, error: 'no-releases' };
            const jar = join(root, JAR_NAME);
            await release.downloadCore(wanted, temp, (progress) => send('core:progress', progress));
            if (existsSync(jar)) await fsp.copyFile(jar, join(root, `${JAR_NAME}.bak`));
            await fsp.rename(temp, jar);
            const state = await readState();
            const entry = (state.servers || []).find((it) => sameDir(it.dir, root));
            if (entry) await patchServerEntry(entry.id, { tag: wanted.tag });
            return { ok: true, tag: wanted.tag };
        } catch (cause) {
            await fsp.rm(temp, { force: true }).catch(() => {});
            return { ok: false, error: errText(cause) };
        }
    });

    ipcMain.handle('shell:openFile', async (_event, { dir, name } = {}) => {
        // only ever opens the server's own config files, and only from a
        // server dir the assistant itself tracks — never arbitrary paths
        if (!CONFIG_FILES.includes(name)) return false;
        const root = await targetDir(dir);
        if (!root) return false;
        const path = join(root, name);
        if (!existsSync(path)) return false;
        await shell.openPath(path);
        return true;
    });

    ipcMain.handle('shell:openFolder', async (_event, payload) => {
        const { dir, sub } = typeof payload === 'string' ? { dir: payload } : (payload || {});
        const root = await targetDir(dir);
        if (!root) return false;
        if (sub && !SUBFOLDERS.has(sub)) return false;
        const path = sub ? join(root, sub) : root;
        if (sub && !existsSync(path)) await fsp.mkdir(path, { recursive: true }).catch(() => {});
        if (existsSync(path)) await shell.openPath(path);
        return true;
    });

    ipcMain.handle('shell:openExternal', (_event, url) => {
        if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
    });

    ipcMain.handle('state:get', async () => {
        const state = await readState();
        const { server } = await cliModules();
        return { ...state, defaultServer: await server.resolveServerDir().catch(() => null) };
    });

    ipcMain.handle('state:set', async (_event, patch) => {
        if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid' };
        const clean = {};
        for (const key of STATE_KEYS) {
            if (key in patch) clean[key] = patch[key];
        }
        if ('theme' in clean && !['dark', 'light', 'system'].includes(clean.theme)) delete clean.theme;
        if ('density' in clean && !['comfortable', 'compact'].includes(clean.density)) delete clean.density;
        if ('accent' in clean && !ACCENTS.includes(clean.accent)) delete clean.accent;
        if ('memory' in clean && !MEMORY_CHOICES.includes(clean.memory)) delete clean.memory;
        if ('tutorialDone' in clean && !Array.isArray(clean.tutorialDone)) delete clean.tutorialDone;
        await writeState(clean);
        void notifier.refresh();
        return { ok: true, theme: clean.theme ?? null };
    });

    ipcMain.handle('state:reset', async () => {
        await writeState({
            memory: DEFAULT_MEMORY, tutorialDone: [], onboardStep: 0,
            theme: 'system', density: 'comfortable', motionOff: false,
            confirmQuit: true, updateAuto: true, updateBg: false,
            accent: 'grass', autoRestart: false,
        });
        return { ok: true };
    });

    ipcMain.handle('app:theme', async () => {
        const theme = await resolveTheme();
        if (win && !win.isDestroyed()) {
            win.setBackgroundColor(OVERLAY_COLORS[theme].color);
            if (typeof win.setTitleBarOverlay === 'function') {
                try { win.setTitleBarOverlay({ ...OVERLAY_COLORS[theme], height: TITLEBAR_HEIGHT }); } catch { /* not on linux */ }
            }
        }
        return { theme };
    });

    ipcMain.handle('app:openStateFolder', async () => {
        const dir = join(os.homedir(), '.pnx-cli');
        if (existsSync(dir)) await shell.openPath(dir);
        return { ok: true };
    });

    ipcMain.handle('logs:export', async (_event, { text } = {}) => {
        if (typeof text !== 'string') return { ok: false, error: 'invalid' };
        if (!text || !text.trim() || text.length > 8_000_000) return { ok: false, error: 'invalid' };
        const active = await activeServerEntry();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const result = await dialog.showSaveDialog(win, {
            title: 'PowerNukkitX',
            defaultPath: join(active?.dir || os.homedir(), `pnx-console-${stamp}.log`),
            filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
        });
        if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' };
        await fsp.writeFile(result.filePath, text.replace(/\r?\n/g, '\n'), 'utf8');
        return { ok: true, path: result.filePath };
    });

    /* ── backups: snapshots run by the CLI service, guarded by the registry ── */

    ipcMain.handle('backup:list', async (_event, { dir } = {}) => {
        try {
            const root = await targetDir(dir);
            if (!root) return { ok: false, error: 'no-server' };
            const backupsDir = join(root, 'backups');
            if (!existsSync(backupsDir)) return { ok: true, backups: [], dir: root };
            const list = [];
            for (const name of await fsp.readdir(backupsDir)) {
                if (!BACKUP_NAME.test(name)) continue;
                const full = join(backupsDir, name);
                const info = await fsp.stat(full);
                const key = `${full}|${info.mtimeMs}`;
                if (!sizeCache.has(key)) sizeCache.set(key, await dirSizeAsync(full));
                list.push({ name, size: sizeCache.get(key), date: info.mtime.toISOString(), auto: existsSync(join(full, '.auto')) });
            }
            list.sort((a, b) => String(b.name).localeCompare(String(a.name)));
            return { ok: true, backups: list, dir: root };
        } catch (cause) {
            return { ok: false, error: errText(cause) };
        }
    });

    ipcMain.handle('backup:create', async (_event, { dir } = {}) => {
        try {
            const root = await targetDir(dir);
            if (!root) return { ok: false, error: 'no-server' };
            const result = await backupLocal(root);
            send('backup:event', { kind: 'created', name: result.name, hot: result.hot });
            return { ok: true, ...result };
        } catch (cause) {
            return { ok: false, error: errText(cause) };
        }
    });

    ipcMain.handle('backup:restore', async (_event, { dir, name } = {}) => {
        try {
            const root = await targetDir(dir);
            if (!root) return { ok: false, error: 'no-server' };
            if (running.proc && sameDir(running.dir, root)) return { ok: false, error: 'running' };
            if (await terminalRun(root)) return { ok: false, error: 'running' };
            if (typeof name !== 'string' || !BACKUP_NAME.test(name)) return { ok: false, error: 'invalid' };
            const src = join(root, 'backups', name);
            if (!existsSync(src)) return { ok: false, error: 'not-found' };
            // the state being replaced is kept first, so a restore is undoable
            // (the same promise `pnx backup restore` makes)
            const safety = await backupLocal(root);
            send('backup:event', { kind: 'created', name: safety.name, hot: false });
            for (const entry of await fsp.readdir(src)) {
                if (entry === '.auto') continue;
                // the world folders are replaced, not merged: chunks written
                // after the snapshot must not survive a restore
                const target = join(root, entry);
                if (entry === 'worlds' || entry === 'world') await fsp.rm(target, { recursive: true, force: true });
                await fsp.cp(join(src, entry), target, { recursive: true, force: true });
            }
            send('backup:event', { kind: 'restored', name, safety: safety.name });
            return { ok: true, safety: safety.name };
        } catch (cause) {
            return { ok: false, error: errText(cause) };
        }
    });

    ipcMain.handle('backup:delete', async (_event, { dir, name } = {}) => {
        try {
            const root = await targetDir(dir);
            if (!root) return { ok: false, error: 'no-server' };
            if (typeof name !== 'string' || !BACKUP_NAME.test(name)) return { ok: false, error: 'invalid' };
            const target = join(root, 'backups', name);
            if (!existsSync(target)) return { ok: false, error: 'not-found' };
            await fsp.rm(target, { recursive: true, force: true });
            send('backup:event', { kind: 'deleted', name });
            return { ok: true };
        } catch (cause) {
            return { ok: false, error: errText(cause) };
        }
    });
}

/* ── window ───────────────────────────────────────────────────────────────── */

function createWindow() {
    win = new BrowserWindow({
        width: 1240,
        height: 800,
        minWidth: 980,
        minHeight: 640,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: OVERLAY_COLORS.dark.color,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            ...OVERLAY_COLORS.dark,
            height: TITLEBAR_HEIGHT,
        },
        icon: join(__dirname, '..', 'icons', os.platform() === 'win32' ? 'icon.ico' : 'icon-1024.png'),
        webPreferences: {
            preload: join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    // theme-aware chrome: overlay and backdrop follow the picked token set
    void (async () => {
        const theme = await resolveTheme().catch(() => 'dark');
        if (!win || win.isDestroyed()) return;
        win.setBackgroundColor(OVERLAY_COLORS[theme].color);
        if (typeof win.setTitleBarOverlay === 'function') {
            try { win.setTitleBarOverlay({ ...OVERLAY_COLORS[theme], height: TITLEBAR_HEIGHT }); } catch { /* linux */ }
        }
    })();

    win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
    /* hard frame: the only navigation is our own file, the only window is ours */
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        // the console's "copy" buttons are the one thing the page may ask for
        callback(permission === 'clipboard-sanitized-write');
    });
    win.webContents.on('console-message', (event) => {
        // Renderer passes its errors through, so `electron .` surfaces them too.
        if (event.level === 'error') console.error(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    win.once('ready-to-show', () => win.show());

    /* closing with a live server is the user's call, never a silent child kill */
    win.on('close', async (event) => {
        if (quitting || !running.proc) return;
        event.preventDefault();
        const state = await readState();
        if (state.confirmQuit === false) {
            await adoptChoice(0, win);
            return;
        }
        const texts = QUIT_PROMPT[state.lang] || QUIT_PROMPT.en;
        const { response, checkboxChecked } = await dialog.showMessageBox(win, {
            type: 'question',
            buttons: [texts.stop, texts.force, texts.cancel],
            defaultId: 0,
            cancelId: 2,
            message: texts.title,
            detail: texts.detail,
            checkboxLabel: texts.remember,
            checkboxChecked: false,
        });
        if (response === 2) return; // cancel — server keeps running
        if (checkboxChecked) await writeState({ confirmQuit: false });
        await adoptChoice(response, win);
    });

    win.on('closed', () => {
        win = null;
    });
}

/** graceful stop (the world saves), then quit; `force` takes no prisoners */
async function adoptChoice(response, winRef) {
    const force = response === 1;
    await stopServer({ force }).catch(() => {});
    quitting = true;
    if (winRef && !winRef.isDestroyed()) winRef.destroy();
}

app.whenReady().then(async () => {
    // Windows shows notifications only for an app with an identity
    if (os.platform() === 'win32') app.setAppUserModelId('org.powernukkitx.assistant');
    registerIpc();
    try { prefs.autoRestart = (await readState()).autoRestart === true; } catch { /* default */ }
    wireUpdater();
    void pulseUpdate();
    setInterval(() => void pulseUpdate(), 3 * 60 * 60 * 1000);
    createWindow();
    setTimeout(() => void pollRemotes(), 1500);
    setInterval(() => void pollRemotes(), 4000);
    // servers started from a terminal with `pnx start`, adopted as they appear
    setTimeout(() => void pollTerminal().catch(() => {}), 1200);
    setInterval(() => void pollTerminal().catch(() => {}), 3000);
    void notifier.refresh();
    setInterval(() => void notifier.refresh(), 30000);
    setInterval(() => void tickScheduler().catch(() => {}), 10000);
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    // VPS servers keep running: systemd owns them, only the SSH links close
    remote.closeAll();
    // only reachable once the close prompt has stopped the server, or on a crash
    if (running.proc) killTree(running.proc);
    if (os.platform() !== 'darwin') app.quit();
});

/* `quitting` is only set once the server question is settled (adoptChoice,
   update:install): a Cmd+Q must still go through the close prompt */
