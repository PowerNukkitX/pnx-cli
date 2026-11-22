import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isInteractive, log } from '../ui/kit.js';
import { select, text, pressEnter, CancelledError, type SelectItem } from '../ui/prompt.js';
import { c, gradient, S } from '../ui/theme.js';
import { card, logo, pill } from '../ui/dashboard.js';
import { VERSION } from '../infra/version.js';
import { JAR_NAME } from '../infra/paths.js';
import { jarVersion } from '../infra/jar.js';
import { resolveServerDir, checkJava, MIN_JAVA } from '../services/server.js';
import { serverPort } from '../services/config-file.js';
import { loadPid, isAlive, sendControl } from '../services/process.js';
import { loadSession } from '../services/agent/protocol.js';
import { lanAddresses, uptime } from './status.js';

/**
 * `pnx` with no arguments: the menu.
 *
 * Built for somebody who does not know the commands yet. Three ideas:
 *
 *  - The screen says where you are before it asks anything: which server,
 *    whether it runs, what is in it. Nobody should guess which folder the
 *    menu is about.
 *  - The first screen is short and depends on the situation: no server means
 *    "create one or point at one"; a running server puts Stop, the live
 *    console and the log first. Everything else sits one level down, in a
 *    sub-menu with a way back.
 *  - Every action prints its result and waits for Enter; then the screen is
 *    redrawn from the top, so the menu is always in the same place.
 *
 * Each action calls the same function as its command; nothing here is a
 * second implementation.
 */

type State = Awaited<ReturnType<typeof readState>>;

let javaLine: string | null = null;

const countJars = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.jar')).length : 0);
const countDirs = (dir: string) => (existsSync(dir)
    ? readdirSync(dir).filter((name) => { try { return statSync(join(dir, name)).isDirectory(); } catch { return false; } }).length
    : 0);

async function readState() {
    const serverDir = await resolveServerDir();
    const pid = await loadPid();
    const running = pid !== null && isAlive(pid.pid);
    const session = await loadSession();
    const elsewhere = running && serverDir !== null && resolve(pid!.serverPath) !== resolve(serverDir);
    return {
        serverDir,
        running,
        pid: running ? pid!.pid : null,
        startedAt: running ? new Date(pid!.startedAt) : null,
        /** a server is running, but not the one this menu is about */
        runningElsewhere: elsewhere ? pid!.serverPath : null,
        controllable: running && Boolean(pid!.control),
        record: pid,
        linked: session !== null,
        session,
        plugins: serverDir ? countJars(join(serverDir, 'plugins')) : 0,
        worlds: serverDir ? countDirs(join(serverDir, 'worlds')) : 0,
        version: serverDir ? jarVersion(join(serverDir, JAR_NAME)) : null,
        port: serverPort(serverDir),
        lan: lanAddresses()[0] ?? null,
    };
}

/**
 * The top of every screen - a dashboard, not a list: the logo, then one card
 * that answers the three questions a person opens the menu with. Which
 * server? Is it up? Where do my friends connect?
 */
async function header(state: State): Promise<string[]> {
    if (javaLine === null) {
        const java = await checkJava();
        javaLine = java.ok
            ? `Java ${java.version}${java.vendor !== 'Unknown' ? ` ${c.muted(`(${java.vendor})`)}` : ''}`
            : c.warn(`Java ${MIN_JAVA}+ missing ${S.arrow} adoptium.net`);
    }
    const cols = process.stdout.columns || 80;
    const tall = (process.stdout.rows || 24) >= 30 && cols >= 72;
    const width = Math.min(cols - 4, 66);
    const lines: string[] = [''];

    if (tall) {
        lines.push(...logo([
            '',
            c.bold('PowerNukkitX CLI'),
            c.muted(`v${VERSION}  ${S.bullet}  ${c.strip(javaLine)}`),
            '',
            c.muted('Minecraft Bedrock servers,'),
            c.muted('without the hassle.'),
        ]));
    } else {
        lines.push(`  ${c.brand(S.logo)} ${c.bold(gradient('PowerNukkitX CLI'))} ${c.muted(`v${VERSION}`)}  ${c.muted(S.bullet)}  ${javaLine}`);
    }
    lines.push('');

    if (!state.serverDir) {
        lines.push(...card('No server yet', pill(false, 'none'), [
            'Create one in seconds, or use one you already have.',
            c.muted('Everything else unlocks after that.'),
        ], width));
    } else {
        const here = state.running && !state.runningElsewhere;
        const facts = [
            `PowerNukkitX ${state.version ?? '?'}`,
            `${state.plugins} plugin${state.plugins === 1 ? '' : 's'}`,
            `${state.worlds} world${state.worlds === 1 ? '' : 's'}`,
        ].join(c.muted(`  ${S.bullet}  `));
        const join_ = `${c.muted('Join')}   ${c.brand(`${state.lan ?? '127.0.0.1'}:${state.port}`)}`;
        const life = here
            ? `${c.muted('Up')}     ${uptime(state.startedAt!)}  ${c.muted(`${S.bullet}  PID ${state.pid}`)}`
            : `${c.muted('State')}  ${c.muted('stopped - start it below')}`;
        lines.push(...card(basename(state.serverDir), pill(here), [
            facts,
            life,
            join_,
            c.muted(state.serverDir),
            ...(state.linked ? [c.info(`${S.stepInfo} paired with a dashboard`)] : []),
        ], width));
    }
    if (state.runningElsewhere) {
        lines.push(`  ${c.warn(`${S.stepWarn} Another server is running:`)} ${c.muted(state.runningElsewhere)}`);
    }
    lines.push('');
    return lines;
}

/** Runs an action, keeps its output on screen until Enter. */
async function perform(run: () => Promise<unknown>, pause = true): Promise<void> {
    try {
        await run();
    } catch (cause) {
        if (!(cause instanceof CancelledError)) log.error(cause instanceof Error ? cause.message : String(cause));
    }
    process.exitCode = 0; // a failed action is shown, not carried out of the menu
    if (pause) await pressEnter();
}

const BACK = '__back';
const QUIT = '__quit';

/* ── the actions ───────────────────────────────────────────────────────── */

const actions: Record<string, (state: State) => Promise<void>> = {
    create: () => perform(async () => {
        const { runCreate, printCreateSummary } = await import('./create.js');
        printCreateSummary(await runCreate({}));
    }),
    use: () => perform(async () => {
        const { runUse } = await import('./use.js');
        await runUse({});
    }),
    start: () => perform(async () => {
        process.stdout.write(`${c.muted('The server runs in this window: type its commands here. Ctrl+C saves, stops it and brings you back to the menu.')}\n`);
        const { runStart } = await import('./start.js');
        await runStart({});
    }),
    stop: () => perform(async () => {
        const { runStop } = await import('./stop.js');
        await runStop();
    }),
    console: () => perform(async () => {
        const { runLogs } = await import('./logs.js');
        await runLogs({ lines: '30', follow: true, console: true });
    }, false),
    send: (state) => perform(async () => {
        const line = (await text({ message: 'Command to run on the server', placeholder: 'say Hello everyone' })).trim().replace(/^\//, '');
        if (!line) return;
        const ok = await sendControl(state.record!, line);
        process.stdout.write(ok
            ? `${c.success(S.check)} Sent. Its answer shows in the server log (Live console).\n`
            : `${c.error(S.cross)} The server did not take the command.\n`);
    }),
    logs: () => perform(async () => {
        const { runLogs } = await import('./logs.js');
        await runLogs({ lines: '40', follow: true });
    }, false),

    'plugin/search': () => perform(async () => {
        const { searchCommand } = await import('./plugin/search.js');
        await searchCommand({ args: { flags: {}, positionals: [] } });
    }),
    'plugin/popular': () => perform(async () => {
        const { renderList } = await import('./plugin/list.js');
        await renderList({ sort: 'stars', limit: 15, page: 1 });
    }),
    'plugin/install': () => perform(async () => {
        const { runInstallPlugins } = await import('./plugin/install.js');
        await runInstallPlugins({});
    }),
    'plugin/installed': () => perform(async () => {
        const { runInstalledPlugins } = await import('./plugin/installed.js');
        await runInstalledPlugins();
    }),
    'plugin/update': () => perform(async () => {
        const { runUpdatePlugins } = await import('./plugin/update.js');
        await runUpdatePlugins([]);
    }),
    'plugin/remove': () => perform(async () => {
        const { runRemovePlugins } = await import('./plugin/remove.js');
        await runRemovePlugins([], false);
    }),

    backup: () => perform(async () => {
        const { runBackup } = await import('./backup.js');
        await runBackup();
    }),
    update: () => perform(async () => {
        const { runUpdate } = await import('./update.js');
        await runUpdate({});
    }),
    doctor: () => perform(async () => {
        const { runDoctor } = await import('./doctor.js');
        await runDoctor();
    }),
    status: () => perform(async () => {
        const { runStatus } = await import('./status.js');
        await runStatus();
    }),
    'backup/list': () => perform(async () => {
        const { backupListCommand } = await import('./backup.js');
        await backupListCommand();
    }),
    'backup/restore': () => perform(async () => {
        const { backupRestoreCommand } = await import('./backup.js');
        await backupRestoreCommand({ args: { flags: { yes: false }, positionals: [] } });
    }),
    'open/folder': () => perform(async () => {
        const { openCommand } = await import('./open.js');
        await openCommand({ args: { flags: {}, positionals: [] } });
    }),
    info: () => perform(async () => {
        const { runInfo } = await import('./info.js');
        await runInfo();
    }),
    config: () => perform(async () => {
        const { runConfig } = await import('./config.js');
        await runConfig();
    }),
    rcon: () => perform(async () => {
        const { runConsole } = await import('./console.js');
        await runConsole();
    }),

    'link/pair': (state) => perform(async () => {
        const { pairInteractively } = await import('./link.js');
        await pairInteractively(state.serverDir);
    }),
    'link/status': () => perform(async () => {
        const { runLink } = await import('./link.js');
        await runLink({ status: true });
    }),
    'link/supervise': (state) => perform(async () => {
        const { runLink } = await import('./link.js');
        await runLink({ dir: state.serverDir!, hub: state.session!.hub });
    }),
    'link/forget': () => perform(async () => {
        const { askConfirm } = await import('../ui/kit.js');
        if (!(await askConfirm('Forget the dashboard token stored on this computer?', false))) return;
        const { runLink } = await import('./link.js');
        await runLink({ forget: true });
    }),
    help: () => perform(async () => {
        const { renderRootHelp } = await import('../cli/help.js');
        const { COMMANDS, GROUPS } = await import('../cli/registry.js');
        renderRootHelp(COMMANDS, GROUPS, VERSION);
    }),
};

/* ── the screens ───────────────────────────────────────────────────────── */

const gap: SelectItem<string> = { heading: '' };

/** The first screen: what makes sense right now, and the doors to the rest. */
function homeItems(state: State): Array<SelectItem<string>> {
    if (!state.serverDir) {
        return [
            { value: 'create', label: 'Create a new server', hint: 'downloads PowerNukkitX into a folder' },
            { value: 'use', label: 'Use a server I already have', hint: 'pick its folder' },
            gap,
            { value: 'doctor', label: 'Check this computer', hint: 'Java, memory, disk, port' },
            { value: 'help', label: 'All commands' },
            { value: QUIT, label: 'Quit' },
        ];
    }
    const here = state.running && !state.runningElsewhere;
    const first: Array<SelectItem<string>> = here
        ? [
            { value: 'stop', label: 'Stop the server', hint: 'saves the world first' },
            ...(state.controllable
                ? [
                    { value: 'console', label: 'Live console', hint: 'watch the log, type commands' },
                    { value: 'send', label: 'Send one command', hint: 'say, op, whitelist...' },
                ]
                : [{ value: 'logs', label: 'Follow the log' }]),
        ]
        : [{
            value: 'start',
            label: 'Start the server',
            hint: state.runningElsewhere ? 'stop the other one first' : 'runs in this window',
        }];
    return [
        { heading: 'Server' },
        ...first,
        { value: 'status', label: 'Status & join address', hint: 'is it up, where players connect' },
        { heading: 'Manage' },
        { value: 'menu/plugins', label: `Plugins  ${S.info}`, hint: 'install, search, update, remove' },
        { value: 'menu/maintenance', label: `Backups & updates  ${S.info}`, hint: 'back up, restore, new PowerNukkitX' },
        { value: 'menu/settings', label: `Settings  ${S.info}`, hint: 'configuration, folders, dashboard' },
        gap,
        { value: 'help', label: 'All commands', hint: 'pnx --help' },
        { value: QUIT, label: 'Quit', hint: 'q' },
    ];
}

const back: SelectItem<string> = { value: BACK, label: `${S.left} Back` };

const SUBMENUS: Record<string, { title: string; items: (state: State) => Array<SelectItem<string>> }> = {
    'menu/plugins': {
        title: 'Plugins',
        items: () => [
            { value: 'plugin/install', label: 'Install plugins', hint: 'pick from the marketplace' },
            { value: 'plugin/search', label: 'Search the marketplace', hint: 'by name' },
            { value: 'plugin/popular', label: 'Most popular plugins' },
            { value: 'plugin/installed', label: 'Installed plugins' },
            { value: 'plugin/update', label: 'Update plugins' },
            { value: 'plugin/remove', label: 'Remove plugins' },
            gap,
            back,
        ],
    },
    'menu/maintenance': {
        title: 'Backups & updates',
        items: () => [
            { value: 'backup', label: 'Back up now', hint: 'worlds, plugins and settings into backups/' },
            { value: 'backup/list', label: 'See backups' },
            { value: 'backup/restore', label: 'Restore a backup', hint: 'a safety copy is taken first' },
            { value: 'update', label: 'Update PowerNukkitX', hint: 'keeps the previous jar as .old' },
            { value: 'doctor', label: 'Run a check-up', hint: 'Java, memory, disk, port' },
            gap,
            back,
        ],
    },
    'menu/settings': {
        title: 'Server & settings',
        items: (state) => [
            { value: 'config', label: 'View the configuration', hint: 'pnx.yml / server.properties' },
            { value: 'info', label: 'Server and system info' },
            { value: 'open/folder', label: 'Open the server folder', hint: 'in your file manager' },
            { value: 'use', label: 'Switch to another server', hint: 'choose its folder' },
            { value: 'create', label: 'Create another server' },
            { value: 'rcon', label: 'Remote console (RCON)', hint: 'for servers not started by pnx' },
            { heading: 'Dashboard' },
            ...(state.linked
                ? [
                    { value: 'link/supervise', label: 'Start supervising', hint: 'runs the server for the dashboard' },
                    { value: 'link/status', label: 'Link status' },
                    { value: 'link/forget', label: 'Unlink this computer' },
                ]
                : [{ value: 'link/pair', label: 'Link to a dashboard', hint: 'needs a pairing code' }]),
            gap,
            back,
        ],
    },
};

export async function runMenu(): Promise<void> {
    if (!isInteractive()) {
        const { renderRootHelp } = await import('../cli/help.js');
        const { COMMANDS, GROUPS } = await import('../cli/registry.js');
        renderRootHelp(COMMANDS, GROUPS, VERSION);
        return;
    }

    let screen = 'home';
    for (;;) {
        const state = await readState();
        const preamble = await header(state);
        // the menu owns the screen: always drawn from the top, scrollback kept
        process.stdout.write('\u001b[2J\u001b[H');

        const sub = SUBMENUS[screen];
        let picked: string;
        try {
            picked = await select<string>({
                message: sub ? sub.title : 'What do you want to do?',
                options: sub ? sub.items(state) : homeItems(state),
                escapeValue: sub ? BACK : QUIT,
                escapeLabel: sub ? 'back' : 'quit',
                shortcuts: sub ? { b: BACK } : { q: QUIT },
                maxItems: 16,
                preamble,
                fullscreen: true,
            });
        } catch {
            picked = QUIT; // Ctrl+C
        }

        if (picked === QUIT) {
            process.stdout.write(`\n  ${c.brand(S.logo)} ${c.muted('See you soon. Run')} ${c.info('pnx')} ${c.muted('to come back, or')} ${c.info('pnx --help')} ${c.muted('for every command.')}\n\n`);
            return;
        }
        if (picked === BACK) { screen = 'home'; continue; }
        if (SUBMENUS[picked]) { screen = picked; continue; }

        const action = actions[picked];
        if (action) await action(state);
    }
}
export { header as dashboardLines, readState as readMenuState };
