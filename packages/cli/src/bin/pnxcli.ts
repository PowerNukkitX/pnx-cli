#!/usr/bin/env node
import { argv } from 'node:process';
import { setColorEnabled, c, S } from '../ui/theme.js';
import { runCreate, printCreateSummary, type CreateOptions } from '../commands/create.js';
import { isInteractive, nextSteps, outroTail, launcherCard, askConfirm } from '../ui/kit.js';
import { runStart } from '../commands/start.js';
import { checkJava, MIN_JAVA } from '../services/server.js';
import { VERSION } from '../infra/version.js';

/**
 * `pnxcli` - the launcher.
 *
 * `pnx` is the whole tool. This binary is the one job most people install the
 * tool for: creating a server. It opens with the launcher card - the brand
 * from the site, the pane layout of a game launcher - walks the four steps of
 * a create as prompts, and ends with a summary card and the one question a new
 * server owner always has: start it now?
 *
 * Everything underneath is the shared create flow. One implementation, two
 * doors: the launcher is a door, never a fork.
 */

const rawArgs = argv.slice(2);

// `pnx --help | head` closes the pipe early: that is the reader's choice, not a crash
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
});
if (rawArgs.includes('--no-color') || !process.stdout.isTTY) setColorEnabled(false);

const HELP_FLAGS = new Set(['--help', '-h']);

function showHelp(): void {
    const rows: Array<[string, string]> = [
        ['--dir <path>', 'where to create it'],
        ['--version <tag>', 'pin a PowerNukkitX version'],
        ['--start', 'start it as soon as it is ready'],
        ['--no-color', 'plain text'],
    ];
    process.stdout.write(`\n${c.bold('pnxcli')}  create a PowerNukkitX server, step by step ${c.muted(`v${VERSION}`)}\n\n`);
    process.stdout.write(`${c.bold('Usage')}\n  ${c.brand('pnxcli [options]')}\n\n${c.bold('Options')}\n`);
    for (const [left, right] of rows) process.stdout.write(`  ${c.info(left.padEnd(16))}  ${right}\n`);
    process.stdout.write(`\n${c.muted('Everything else (start, stop, plugins, backups) lives in pnx: pnx --help')}\n\n`);
}

function fail(message: string, hint?: string): never {
    process.stderr.write(`${c.error(S.cross)} ${message}\n`);
    if (hint) process.stderr.write(`  ${c.muted(hint)}\n`);
    process.exit(1);
}

function flag(name: string): string | undefined {
    const index = rawArgs.indexOf(name);
    const value = index >= 0 ? rawArgs[index + 1] : undefined;
    if (index >= 0 && (!value || value.startsWith('-'))) fail(`${name} needs a value.`, 'Run `pnxcli --help`.');
    return value;
}

async function main(): Promise<void> {
    if (rawArgs.some((token) => HELP_FLAGS.has(token))) return showHelp();
    const known = new Set(['--dir', '--version', '--start', '--no-color', '--color']);
    const unknown = rawArgs.find((token, index) => token.startsWith('-') && !known.has(token)
        && !['--dir', '--version'].includes(rawArgs[index - 1] ?? ''));
    if (unknown) fail(`Unknown option ${unknown}.`, 'Run `pnxcli --help`.');

    const dir = flag('--dir');
    const version = flag('--version');
    const wantsStart = rawArgs.includes('--start');

    if (!isInteractive() && !dir) {
        fail(
            'There is no terminal here to answer prompts with.',
            'Run `pnxcli --dir <path>` (and optionally --version <tag>) instead.',
        );
    }

    const java = await checkJava();
    launcherCard(
        [['Java', java.ok ? `${java.version} ${c.muted(`(${java.vendor})`)}` : c.warn(`not found - Java ${MIN_JAVA} or newer is required`)]],
        `create a server  ${S.bullet}  v${VERSION}`,
    );

    if (!java.ok) {
        nextSteps([['https://adoptium.net/', `install Java ${MIN_JAVA} (Temurin), then run pnxcli again`]], 'Do');
        outroTail(`Java ${MIN_JAVA} or newer is required.`, 'fail');
        return;
    }

    const options: CreateOptions = { dir, version };
    const result = await runCreate(options);
    printCreateSummary(result, { close: false });

    const startNow = wantsStart || (isInteractive() && (await askConfirm('Start the server now?', false)));
    if (startNow) {
        outroTail('Server created - starting it now', 'ok');
        process.exitCode = await runStart({ dir: result.serverDir });
        return;
    }

    outroTail('Server ready.', 'ok');
}

process.on('unhandledRejection', (reason) => {
    fail(reason instanceof Error ? reason.message : String(reason), 'Re-run with PNX_DEBUG=1 for the full trace.');
});

main().catch((cause) => {
    if (cause?.name === 'CancelledError') {
        process.stdout.write(`${c.muted('Cancelled.')}\n`);
        process.exit(0);
    }
    fail(cause instanceof Error ? cause.message : String(cause), 'Re-run with PNX_DEBUG=1 for the full trace.');
});
