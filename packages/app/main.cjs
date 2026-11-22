'use strict';

/**
 * PowerNukkitX desktop app — Electron main process.
 *
 * One rule drives this file: the desktop app never re-implements what the CLI
 * already decides. It imports the compiled CLI (vendored into `resources/cli`
 * at package time, `../dist` in dev) and drives the very same functions
 * `pnx init`, `pnxcli` and `pnx start` run. The renderer talks to it through a
 * narrow, whitelisted IPC surface defined in preload.cjs.
 */

const {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    nativeTheme,
    shell,
} = require('electron');
const { spawn, execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, basename } = require('node:path');
const { randomUUID } = require('node:crypto');
const { readFile, writeFile, copyFile, rm } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { platform, homedir } = require('node:os');

/** Absolute path to the vendored CLI. Dev: this repo's dist. Prod: resources/cli. */
const cliDir = app.isPackaged
    ? join(process.resourcesPath, 'cli')
    : join(__dirname, '..', '..', 'cli', 'dist');
const cli = (rel) => pathToFileURL(join(cliDir, rel)).href;

const JAR_NAME = 'powernukkitx.jar';
const MEMORY_CHOICES = ['512M', '1G', '2G', '4G', '8G', '16G'];

/* one assistant at a time: a second launch focuses the running window
   instead of spawning a rival (two spawnings of the same server would fight) */
if (!app.requestSingleInstanceLock()) {
    app.quit();
}
app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
});

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
    V = { release, server, plugins, backup, http, store };
    return V;
}

let win = null;

function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** One assistant state file, next to the CLI's own state in ~/.pnx-cli. */
async function readState() {
    const { store } = await cliModules();
    return store.readJson('assistant.json', { memory: '1G', tutorialDone: [], servers: [], activeId: null });
}
async function writeState(patch) {
    const { store } = await cliModules();
    const state = { ...(await readState()), ...patch };
    await store.writeJson('assistant.json', state);
    return state;
}

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

function updateEvent(kind, payload = {}) {
    updateKind = kind;
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
        const version = result?.updateInfo?.version ?? null;
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

ipcMain.handle('update:install', () => {
    if (!autoUpdater) return { ok: false, error: 'unsupported' };
    // killing the child before quitting keeps the installer from waiting on it
    try { stopServer(); } catch { /* already gone */ }
    autoUpdater.quitAndInstall();
    return { ok: true };
});

/* ── server registry: several servers, one active at a time ──────────────── */

const sameDir = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

async function activeServerEntry() {
    const state = await readState();
    return (state.servers || []).find((it) => it.id === state.activeId) || null;
}

/** Any dir the app should track ends up in the registry; dupes collapse. */
async function registerServerEntry(dir, explicitName) {
    const state = await readState();
    const servers = (state.servers || []).filter((it) => !sameDir(it.dir, dir));
    if (!existsSync(join(dir, JAR_NAME))) return null;
    const entry = {
        id: randomUUID().slice(0, 10),
        name: explicitName || basename(dir),
        dir: String(dir).trim(),
    };
    servers.push(entry);
    const patch = { servers };
    if (!state.activeId || !servers.some((it) => it.id === state.activeId)) patch.activeId = entry.id;
    await writeState(patch);
    return entry;
}

/** First boot with no registry yet: the CLI's default server becomes the first. */
async function migrateRegistry() {
    const state = await readState();
    if ((state.servers || []).length > 0) return;
    const { server } = await cliModules();
    const dir = await server.resolveServerDir();
    if (dir && existsSync(join(dir, JAR_NAME))) {
        await registerServerEntry(dir);
    }
}

ipcMain.handle('servers:list', async () => {
    await migrateRegistry();
    const state = await readState();
    return (state.servers || []).map((it) => ({
        ...it,
        active: it.id === state.activeId,
        hasJar: existsSync(join(it.dir, JAR_NAME)),
        running: running.dir && sameDir(running.dir, it.dir) && Boolean(running.proc),
    }));
});

ipcMain.handle('servers:add', async (_event, { dir, name } = {}) => {
    if (typeof dir !== 'string' || !dir.trim()) return { ok: false, error: 'no-dir' };
    if (!existsSync(join(dir, JAR_NAME))) return { ok: false, error: 'no-jar' };
    const state = await readState();
    if ((state.servers || []).some((it) => sameDir(it.dir, dir))) return { ok: false, error: 'dupe' };
    const entry = await registerServerEntry(dir, name);
    const { server } = await cliModules();
    if (!state.activeId && entry) await server.setDefaultServer(entry.dir).catch(() => {});
    return { ok: true, entry };
});

ipcMain.handle('servers:activate', async (_event, { id } = {}) => {
    const state = await readState();
    const entry = (state.servers || []).find((it) => it.id === id);
    if (!entry) return { ok: false, error: 'unknown' };
    await writeState({ activeId: id });
    const { server } = await cliModules();
    await server.setDefaultServer(entry.dir).catch(() => {});
    return { ok: true, entry };
});

ipcMain.handle('servers:rename', async (_event, { id, name } = {}) => {
    const state = await readState();
    if (!(state.servers || []).some((it) => it.id === id)) return { ok: false, error: 'unknown' };
    const servers = (state.servers || []).map((it) => (it.id === id ? { ...it, name: String(name || it.name).trim() } : it));
    await writeState({ servers });
    return { ok: true };
});

ipcMain.handle('servers:remove', async (_event, { id } = {}) => {
    const state = await readState();
    const entry = (state.servers || []).find((it) => it.id === id);
    if (!entry) return { ok: false, error: 'unknown' };
    if (running.dir && sameDir(running.dir, entry.dir) && running.proc) {
        return { ok: false, error: 'running' };
    }
    const rest = (state.servers || []).filter((it) => it.id !== id);
    const patch = { servers: rest };
    if (state.activeId === id) {
        patch.activeId = rest[rest.length - 1]?.id ?? null;
        // the CLI's own default follows: a deleted active server must not
        // leave `pnx` pointing at a ghost folder
        if (patch.activeId) {
            const { server } = await cliModules();
            await server.setDefaultServer(rest[rest.length - 1].dir).catch(() => {});
        }
    }
    await writeState(patch);
    return { ok: true, activeId: patch.activeId ?? null };
});

/* ── config: pnx.yml first, the old server.properties second ─────────────── */

const CONFIG_FILES = ['pnx.yml', 'server.properties'];

ipcMain.handle('config:read', async (_event, { dir } = {}) => {
    if (!await trackedDir(dir)) return { ok: false, error: 'no-server' };
    for (const name of CONFIG_FILES) {
        const path = join(dir, name);
        if (existsSync(path)) {
            return { ok: true, which: name, path, text: await readFile(path, 'utf8') };
        }
    }
    return { ok: true, which: 'pnx.yml', path: join(dir, 'pnx.yml'), text: '', exists: false };
});

ipcMain.handle('config:write', async (_event, { dir, which, text } = {}) => {
    if (!await trackedDir(dir) || !CONFIG_FILES.includes(which) || typeof text !== 'string') {
        return { ok: false, error: 'invalid' };
    }
    const path = join(dir, which);
    try {
        // one roll-back copy: an assistant mistake must never cost a config
        if (existsSync(path)) await copyFile(path, `${path}.assistant-bak`);
        await writeFile(path, text.replace(/\r\n/g, '\n'), 'utf8');
        return { ok: true, path };
    } catch (cause) {
        return { ok: false, error: String(cause instanceof Error ? cause.message : cause) };
    }
});

/** keys the renderer may persist — everything else from the UI is refused */
const STATE_KEYS = [
    'memory', 'tutorialDone', 'servers', 'activeId', 'lang', 'onboarded', 'onboardStep',
    'theme', 'density', 'motionOff', 'confirmQuit', 'updateAuto', 'updateBg',
];

/* ── tracked paths: config and shell targets stay inside the registry ─────── */

async function trackedDir(dir) {
    if (typeof dir !== 'string') return null;
    const state = await readState();
    const { server } = await cliModules();
    const all = (state.servers || []).map((it) => it.dir);
    const def = await server.resolveServerDir().catch(() => null);
    if (def) all.push(def);
    return all.find((it) => sameDir(it, dir)) || null;
}

/** server dir itself, or exactly one level beneath it (plugins/, logs/, world/) */
async function trackedPath(target) {
    if (typeof target !== 'string') return null;
    const state = await readState();
    for (const it of state.servers || []) {
        if (sameDir(target, it.dir)) return it.dir;
        const rest = target.slice(String(it.dir).length);
        if (target.toLowerCase().startsWith(String(it.dir).toLowerCase())
            && /^[\\/][^\\/]+$/.test(rest)) {
            return it.dir;
        }
    }
    return null;
}

let quitting = false;

/** the close-with-server prompt, said in the user's own language */
const QUIT_PROMPT = {
    fr: {
        title: 'Un serveur est en cours d’exécution',
        detail: 'Ta partie et ton monde peuvent être perdus si le serveur est coupé brutalement.',
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
        stop: 'Detener con gracia y salir',
        force: 'Forzar parada',
        cancel: 'Cancelar',
        remember: 'No volver a preguntar (parada con gracia al cerrar)',
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
        detail: 'Seu mundo pode perder progresso se o servidor for morto.',
        stop: 'Parar graciosamente e sair',
        force: 'Forçar parada',
        cancel: 'Cancelar',
        remember: 'Não perguntar novamente (parada graciosa ao fechar)',
    },
};

/* ── theme: the title bar follows the token set ──────────────────────────── */

const OVERLAY_COLORS = {
    dark: { color: '#0a0a0a', symbolColor: '#e5e9e7' },
    light: { color: '#f4f6f4', symbolColor: '#1a1e1c' },
};

async function resolveTheme() {
    const state = await readState();
    const theme = state.theme === 'light' || state.theme === 'dark' ? state.theme : 'system';
    if (theme !== 'system') return theme;
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

const running = { proc: null, dir: null, pid: null, startedAt: 0 };

async function startServer(dir, memory) {
    if (running.proc) return { ok: false, error: 'running', dir: running.dir };
    if (!existsSync(join(dir, JAR_NAME))) return { ok: false, error: 'no-jar', dir };

    const { server } = await cliModules();
    const java = await server.checkJava();
    if (!java.ok) {
        return { ok: false, error: 'java', raw: java.raw };
    }

    const args = [...server.buildLaunchArgs(memory), '--nogui'];
    const proc = spawn(server.findJava(), args, {
        cwd: dir,
        env: server.javaEnv(),
        windowsHide: true,
    });
    running.proc = proc;
    running.dir = dir;
    running.pid = proc.pid;
    running.startedAt = Date.now();

    let fired = false;
    proc.on('error', () => {
        fired = true;
        running.proc = null;
        send('server:exit', { code: -1, dir });
    });
    for (const stream of ['stdout', 'stderr']) {
        let carry = '';
        proc[stream].setEncoding('utf8');
        proc[stream].on('data', (data) => {
            carry += data;
            const lines = carry.split(/\r?\n|\r/);
            carry = lines.pop() || '';
            if (lines.length > 0) send('server:line', { dir, lines });
        });
    }
    proc.on('close', (code) => {
        if (fired) return;
        running.proc = null;
        running.pid = null;
        send('server:exit', { code, dir });
    });

    return { ok: true, pid: proc.pid, java: java.vendor, args };
}

/** Graciious first: `stop` travels on stdin, the hard kill is the plan B. */
async function stopServer({ force = false } = {}) {
    const proc = running.proc;
    if (!proc) return { ok: false, error: 'not-running' };
    if (!force) {
        try { proc.stdin.write('stop\n'); } catch { /* dies silently, force below */ }
        const gone = await new Promise((resolve) => {
            const watch = setInterval(() => { if (!running.proc) { clearInterval(watch); resolve(true); } }, 150);
            setTimeout(() => { clearInterval(watch); resolve(false); }, 4000);
        });
        if (gone) return { ok: true, graceful: true };
    }
    if (platform() === 'win32') {
        // The java process owns children (ZGC threads are internal, but Nukkit
        // watchers are not): kill the tree the way the task manager would.
        execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => undefined);
    } else {
        proc.kill('SIGTERM');
        setTimeout(() => {
            if (running.proc === proc && proc.exitCode === null) proc.kill('SIGKILL');
        }, 4000).unref();
    }
    return { ok: true, forced: true };
}

/* ── create flow (same steps as `pnx init`, log line by line) ─────────────── */

async function createServer(dir, tag) {
    const { release, server, http } = await cliModules();
    // Log lines travel as i18n keys + params: the renderer formats them in
    // whatever language the user picked, the main process never speaks French.
    const log = (key, params = [], kind = undefined) => send('create:log', { key, params, kind });

    const done = (kind, key, params) => log(key, params, kind);

    if (existsSync(join(dir, JAR_NAME))) {
        return { ok: false, error: 'exists', dir };
    }

    log('create.log.dir', [dir]);
    const fs = await import('node:fs/promises');
    await fs.mkdir(dir, { recursive: true });

    log('create.log.versions');
    const releases = await release.listReleases();
    const wanted = releases.find((r) => r.tag === tag) ?? releases[0];
    if (!wanted) return { ok: false, error: 'no-releases' };
    done('ok', 'create.log.chosen', [wanted.tag, wanted.prerelease ? 'pre' : '']);

    const jarPath = join(dir, JAR_NAME);
    let lastPercent = -1;
    await release.downloadCore(wanted, jarPath, (progress) => {
        const pct = progress.percent === null ? null : Math.floor(progress.percent);
        if (pct !== lastPercent) {
            lastPercent = pct;
            send('create:progress', progress);
        }
    });
    const assetSize = wanted.assets.find((a) => a.name === JAR_NAME)?.size ?? 0;
    const sizeLine = lastPercent === null ? `${(assetSize / 1024 / 1024).toFixed(0)} Mo` : `${lastPercent} % — ${(assetSize / 1024 / 1024).toFixed(0)} Mo`;
    done('ok', 'create.log.jar', [sizeLine]);

    const scripts = server.officialStartScripts();
    for (const script of scripts) {
        await http.downloadFile(script.url, join(dir, script.name));
        done('ok', 'create.log.script', [script.name]);
    }
    await server.setDefaultServer(dir);
    done('ok', 'create.log.registered');
    // the new server joins the registry and becomes the active one
    try {
        const state = await readState();
        const servers = (state.servers || []).filter((it) => !sameDir(it.dir, dir));
        const entry = { id: randomUUID().slice(0, 10), name: basename(dir), dir: dir.trim() };
        servers.push(entry);
        await writeState({ servers, activeId: entry.id });
    } catch (cause) {
        done('error', 'create.log.failure', [String(cause instanceof Error ? cause.message : cause)]);
    }

    return { ok: true, dir, tag: wanted.tag, size: wanted.assets.find((a) => a.name === JAR_NAME)?.size ?? 0 };
}

/* ── plugins: the app drives the same marketplace service the CLI drives ─── */

function pluginsDirFor(dir) {
    return dir ? join(dir, 'plugins') : null;
}

ipcMain.handle('plugins:search', async (_event, { q, sort, limit } = {}) => {
    try {
        const { plugins } = await cliModules();
        return { ok: true, ...(await plugins.searchPlugins({ q, sort, limit: limit ?? 18 })) };
    } catch (cause) {
        return { ok: false, error: String(cause instanceof Error ? cause.message : cause) };
    }
});

ipcMain.handle('plugins:installed', async () => {
    const { plugins } = await cliModules();
    return plugins.getInstalled();
});

ipcMain.handle('plugins:install', async (_event, { slug }) => {
    const { plugins, server } = await cliModules();
    if (!slug) return { ok: false, error: 'no-slug' };
    const active = await activeServerEntry();
    const dir = running.dir || active?.dir || (await server.resolveServerDir());
    const pluginsDir = pluginsDirFor(dir);
    if (!pluginsDir) return { ok: false, error: 'no-server' };
    try {
        // re-installing a newer build: retire the old jar first, or PNX
        // would load two copies of the same plugin next boot
        const old = (await plugins.getInstalled()).find((it) => it.slug === slug);
        if (old) await rm(join(pluginsDir, old.fileName), { force: true }).catch(() => {});
        const entry = await plugins.installPlugin(slug, pluginsDir, (progress, file) => {
            send('plugin:progress', {
                slug,
                file,
                percent: progress.percent === null ? null : Math.floor(progress.percent),
                received: progress.received,
            });
        });
        return { ok: true, entry, pluginsDir };
    } catch (cause) {
        return { ok: false, error: String(cause instanceof Error ? cause.message : cause) };
    }
});

ipcMain.handle('plugins:remove', async (_event, { fileName }) => {
    const { plugins, server } = await cliModules();
    const list = await plugins.getInstalled();
    const entry = list.find((it) => it.fileName === fileName);
    if (!entry) return { ok: false, error: 'not-tracked' };
    const active = await activeServerEntry();
    const dir = running.dir || active?.dir || (await server.resolveServerDir());
    const pluginsDir = pluginsDirFor(dir);
    if (!pluginsDir) return { ok: false, error: 'no-server' };
    const { rm } = await import('node:fs/promises');
    await rm(join(pluginsDir, fileName), { force: true });
    await plugins.removeInstalled(entry.slug);
    return { ok: true };
});

/* ── IPC surface (mirrors preload.cjs exactly) ────────────────────────────── */

function registerIpc() {
    ipcMain.handle('app:about', () => ({
        app: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        cli: require(join(__dirname, '..', 'package.json')).version,
    }));

    ipcMain.handle('dialog:pickFolder', async (_event, { title } = {}) => {
        const result = await dialog.showOpenDialog(win, {
            properties: ['openDirectory', 'createDirectory'],
            title: title || 'PowerNukkitX',
        });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('fs:validateDir', async (_event, dir) => {
        if (!dir || !dir.trim()) return { ok: false, reason: 'empty' };
        const jar = existsSync(join(dir, JAR_NAME));
        return { ok: true, jar };
    });

    ipcMain.handle('releases:list', async () => {
        try {
            const { release } = await cliModules();
            const releases = await release.listReleases();
            return {
                ok: true,
                releases: releases.map((r, index) => ({
                    tag: r.tag,
                    prerelease: r.prerelease,
                    latest: index === 0 && !r.prerelease,
                    size: r.assets.find((a) => a.name === JAR_NAME)?.size ?? 0,
                })),
            };
        } catch (cause) {
            return { ok: false, error: String(cause instanceof Error ? cause.message : cause) };
        }
    });

    ipcMain.handle('java:check', async () => {
        const { server } = await cliModules();
        return server.checkJava();
    });

    ipcMain.handle('server:create', async (_event, { dir, tag }) => {
        if (!dir || typeof dir !== 'string') return { ok: false, error: 'no-dir' };
        try {
            return await createServer(dir.trim(), tag);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            send('create:log', { key: 'create.log.failure', params: [message], kind: 'error' });
            return { ok: false, error: 'failed', message };
        }
    });

    ipcMain.handle('server:start', async (_event, { dir, memory }) => {
        if (!dir) {
            const { server } = await cliModules();
            dir = await server.resolveServerDir();
        }
        if (!dir || !existsSync(join(dir, JAR_NAME))) return { ok: false, error: 'no-jar' };
        const mem = MEMORY_CHOICES.includes(memory) ? memory : '1G';
        return startServer(dir, mem);
    });

    ipcMain.handle('server:stop', async (_event, { force } = {}) => stopServer({ force: force === true }));
    ipcMain.handle('server:command', async (_event, { text } = {}) => {
        const proc = running.proc;
        if (!proc) return { ok: false, error: 'not-running' };
        if (typeof text !== 'string') return { ok: false, error: 'invalid' };
        const clean = text.replace(/[\r\n\u0000]/g, '').trim();
        if (!clean || clean.length > 512) return { ok: false, error: 'invalid' };
        proc.stdin.write(`${clean}\n`);
        return { ok: true };
    });
    ipcMain.handle('server:metrics', () => ({
        running: Boolean(running.proc),
        pid: running.pid,
        dir: running.dir,
        startedAt: running.startedAt || null,
    }));
    ipcMain.handle('server:status', () => ({
        running: Boolean(running.proc),
        pid: running.pid,
        dir: running.dir,
    }));

    ipcMain.handle('server:default', async () => {
        const { server } = await cliModules();
        return server.resolveServerDir();
    });

    ipcMain.handle('shell:openFile', (_event, { dir, name }) => {
        // only ever opens pnx.yml (the server's descriptor), and only from a
        // server dir the assistant itself tracks — never arbitrary paths
        if (name !== 'pnx.yml' || typeof dir !== 'string') return false;
        const path = join(dir, name);
        if (!existsSync(path)) return false;
        shell.openPath(path);
        return true;
    });
    ipcMain.handle('shell:openFolder', async (_event, dir) => {
        if (!await trackedPath(dir)) return false;
        if (existsSync(dir)) shell.openPath(dir);
        return true;
    });
    ipcMain.handle('shell:openExternal', (_event, url) => {
        if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
    });

    ipcMain.handle('state:get', async () => {
        const state = await readState();
        const { server } = await cliModules();
        return { ...state, defaultServer: await server.resolveServerDir() };
    });
    ipcMain.handle('state:set', async (_event, patch) => {
        if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid' };
        const clean = {};
        for (const key of STATE_KEYS) {
            if (key in patch) clean[key] = patch[key];
        }
        if ('servers' in clean && !Array.isArray(clean.servers)) clean.servers = [];
        if ('theme' in clean && !['dark', 'light', 'system'].includes(clean.theme)) delete clean.theme;
        if ('density' in clean && !['comfortable', 'compact'].includes(clean.density)) delete clean.density;
        await writeState(clean);
        return { ok: true, theme: clean.theme ?? null };
    });
    ipcMain.handle('state:reset', async () => {
        await writeState({
            memory: '1G', tutorialDone: [], onboardStep: 0,
            theme: 'system', density: 'comfortable', motionOff: false,
            confirmQuit: true, updateAuto: true, updateBg: false,
        });
        return { ok: true };
    });

    ipcMain.handle('app:theme', async () => {
        const theme = await resolveTheme();
        if (win && !win.isDestroyed() && typeof win.setTitleBarOverlay === 'function') {
            try { win.setTitleBarOverlay(OVERLAY_COLORS[theme]); } catch { /* not on linux */ }
        }
        return { theme };
    });

    ipcMain.handle('app:openStateFolder', async () => {
        const dir = join(homedir(), '.pnx-cli');
        if (existsSync(dir)) shell.openPath(dir);
        return { ok: true };
    });

    ipcMain.handle('logs:export', async (_event, { text } = {}) => {
        if (typeof text !== 'string') return { ok: false, error: 'invalid' };
        if (!text || !text.trim() || text.length > 4_000_000) return { ok: false, error: 'invalid' };
        const active = await activeServerEntry();
        const result = await dialog.showSaveDialog(win, {
            title: 'PowerNukkitX',
            defaultPath: join(active?.dir || homedir(), 'pnx-console.log'),
            filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
        });
        if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' };
        await writeFile(result.filePath, text.replace(/\r?\n/g, '\n'), 'utf8');
        return { ok: true, path: result.filePath };
    });

    /* ── backups: snapshots run by the CLI service, guarded by the registry ── */

    ipcMain.handle('backup:list', async () => {
        try {
            const active = await activeServerEntry();
            const { server, backup } = await cliModules();
            const dir = active?.dir || (await server.resolveServerDir());
            const root = await trackedDir(dir);
            if (!root) return { ok: false, error: 'no-server' };
            const backupsDir = join(root, 'backups');
            if (!existsSync(backupsDir)) return { ok: true, backups: [], dir };
            const { readdir, stat } = await import('node:fs/promises');
            const list = [];
            for (const name of await readdir(backupsDir)) {
                if (!name.startsWith('pnx-backup-')) continue;
                const full = join(backupsDir, name);
                list.push({ name, path: full, size: backup.dirSize(full), date: (await stat(full)).mtime.toISOString() });
            }
            list.sort((a, b) => String(b.name).localeCompare(String(a.name)));
            return { ok: true, backups: list, dir };
        } catch (cause) {
            return { ok: false, error: String(cause instanceof Error ? cause.message : cause) };
        }
    });

    ipcMain.handle('backup:create', async () => {
        try {
            if (running.proc) return { ok: false, error: 'running' };
            const active = await activeServerEntry();
            const { server, backup } = await cliModules();
            const dir = active?.dir || (await server.resolveServerDir());
            if (!await trackedDir(dir)) return { ok: false, error: 'no-server' };
            const result = await backup.createBackup(dir);
            send('backup:event', { kind: 'created', name: result.path.split(/[\\/]/).pop() });
            return { ok: true, ...result };
        } catch (cause) {
            return { ok: false, error: String(cause instanceof Error ? cause.message : cause) };
        }
    });

    ipcMain.handle('backup:restore', async (_event, { name } = {}) => {
        try {
            if (running.proc) return { ok: false, error: 'running' };
            if (typeof name !== 'string' || !/^pnx-backup-[0-9\-]+$/.test(name)) return { ok: false, error: 'invalid' };
            const active = await activeServerEntry();
            const dir = active?.dir || (await (await cliModules()).server.resolveServerDir());
            const tracked = await trackedDir(dir);
            if (!tracked) return { ok: false, error: 'no-server' };
            const src = join(tracked, 'backups', name);
            if (!existsSync(src)) return { ok: false, error: 'not-found' };
            const { readdir, cp } = await import('node:fs/promises');
            for (const entry of await readdir(src)) {
                await cp(join(src, entry), join(tracked, entry), { recursive: true, force: true });
            }
            send('backup:event', { kind: 'restored' });
            return { ok: true };
        } catch (cause) {
            return { ok: false, error: String(cause instanceof Error ? cause.message : cause) };
        }
    });

    ipcMain.handle('backup:delete', async (_event, { name } = {}) => {
        try {
            if (typeof name !== 'string' || !/^pnx-backup-[0-9\-]+$/.test(name)) return { ok: false, error: 'invalid' };
            const active = await activeServerEntry();
            const dir = active?.dir || (await (await cliModules()).server.resolveServerDir());
            const tracked = await trackedDir(dir);
            if (!tracked) return { ok: false, error: 'no-server' };
            const target = join(tracked, 'backups', name);
            if (!existsSync(target)) return { ok: false, error: 'not-found' };
            await rm(target, { recursive: true, force: true });
            send('backup:event', { kind: 'deleted' });
            return { ok: true };
        } catch (cause) {
            return { ok: false, error: String(cause instanceof Error ? cause.message : cause) };
        }
    });
}

/* ── window ───────────────────────────────────────────────────────────────── */

function createWindow() {
    win = new BrowserWindow({
        width: 1000,
        height: 680,
        minWidth: 860,
        minHeight: 560,
        show: false,
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            ...OVERLAY_COLORS.dark,
            height: 38,
        },
        icon: join(__dirname, '..', 'icons', 'icon.ico'),
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
        win?.setBackgroundColor(OVERLAY_COLORS[theme].color);
        if (win && !win.isDestroyed() && typeof win.setTitleBarOverlay === 'function') {
            try { win.setTitleBarOverlay({ ...OVERLAY_COLORS[theme], height: 38 }); } catch { /* linux */ }
        }
    })();

    win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
    /* hard frame: the only navigation is our own file, the only window is ours */
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        // Renderer passes its errors through, so `electron .` surfaces them too.
        if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
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
        await writeState({ confirmQuit: !checkboxChecked });
        if (response === 2) return; // cancel — server keeps running
        await adoptChoice(response, win);
    });

    win.on('closed', () => {
        win = null;
    });
}

/** graceful stop, then quit; the runner under `force` takes no prisoners */
async function adoptChoice(response, winRef) {
    const force = response === 1;
    await stopServer({ force }).catch(() => {});
    quitting = true;
    if (winRef && !winRef.isDestroyed()) winRef.destroy();
}

app.whenReady().then(() => {
    registerIpc();
    wireUpdater();
    void pulseUpdate();
    setInterval(() => void pulseUpdate(), 3 * 60 * 60 * 1000);
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    stopServer();
    if (platform() !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    stopServer();
});
'use strict';

/**
 * The render