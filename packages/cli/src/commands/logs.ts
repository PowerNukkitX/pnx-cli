import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { readString, readBool, type RunContext } from '../cli/define.js';
import { introHead, nextSteps, outroTail } from '../ui/kit.js';
import { c, S } from '../ui/theme.js';
import { createInterface } from 'node:readline';
import { isAlive, loadPid, sendControl } from '../services/process.js';
import { resolveServerDir } from '../services/server.js';

/**
 * Reading the server's log.
 *
 * This command's own frame appears for the failure paths; the log stream itself
 * gets none, on purpose. Gened from a rail, a live log that could be pasted
 * into a support ticket instead has to be cleaned up by hand first - so the
 * stream is the payload, undecorated except for the level markers.
 */

export interface LogsOptions {
    lines: string;
    follow: boolean;
    /** Also send typed lines to the server (when `pnx start` runs it). */
    console?: boolean;
}

const colorize = (line: string) =>
    line
        .replace(/\[ERROR ?\]/g, (m) => c.error(m))
        .replace(/\[WARN ?\]/g, (m) => c.warn(m))
        .replace(/\[INFO ?\]/g, (m) => c.info(m));

export async function runLogs(options: LogsOptions): Promise<void> {
    const serverPath = await resolveServerDir();
    if (!serverPath) {
        introHead('pnx logs');
        nextSteps([['pnx init', 'create one'], ['pnx use <path>', 'point at an existing one']], 'Try');
        outroTail('No server found here.', 'fail');
        return;
    }

    const logsDir = join(serverPath, 'logs');
    if (!existsSync(logsDir)) {
        introHead('pnx logs');
        process.stdout.write(`${c.warn(`No logs/ directory in ${serverPath}`)}\n`);
        nextSteps([['pnx start', 'boot the server once - the directory appears with it']], 'Do');
        outroTail('Nothing to read.');
        return;
    }

    const files = readdirSync(logsDir)
        .filter((f) => f.endsWith('.log') || f === 'latest.log')
        .map((f) => ({ name: f, mtime: statSync(join(logsDir, f)).mtime.getTime() }))
        .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) {
        introHead('pnx logs');
        outroTail('No .log files in that directory yet.');
        return;
    }

    const logPath = join(logsDir, files[0]!.name);
    const count = Number.parseInt(options.lines, 10) || 50;

    process.stdout.write(`${c.muted(`── ${logPath}  ·  last ${count} lines${options.follow ? '  ·  following' : ''}`)}\n\n`);
    const content = readFileSync(logPath, 'utf-8');
    const tail = content.split('\n').filter(Boolean).slice(-count);
    for (const line of tail) process.stdout.write(`${colorize(line)}\n`);

    if (!options.follow) {
        process.stdout.write(c.muted(`\nFollow it live with \`pnx logs\`, or read further back with --lines.\n`));
        return;
    }

    const control = options.console ? await loadPid() : null;
    const canSend = Boolean(control?.control && isAlive(control.pid));
    process.stdout.write(`\n${c.muted(canSend
        ? 'Live console: type a command and press Enter. Ctrl+C to leave (the server keeps running).'
        : 'Following. Ctrl+C to stop.')}\n`);

    let buffer = content;
    const watcher = watch(logPath, () => {
        try {
            const updated = readFileSync(logPath, 'utf-8');
            if (updated.length > buffer.length) {
                process.stdout.write(colorize(updated.slice(buffer.length)));
                buffer = updated;
            } else if (updated.length < buffer.length) {
                buffer = updated; // rotated: start over from the new file
            }
        } catch {
            // half-written or rotated for a moment; the next tick catches up
        }
    });

    // Ctrl+C leaves this view, not the whole tool: the menu gets its turn back
    await new Promise<void>((resolveFollow) => {
        const reader = process.stdin.isTTY ? createInterface({ input: process.stdin, terminal: true }) : null;
        const leave = () => {
            watcher.close();
            process.off('SIGINT', leave);
            reader?.close();
            process.stdin.pause();
            process.stdout.write('\n');
            resolveFollow();
        };
        process.on('SIGINT', leave);
        reader?.on('SIGINT', leave);
        reader?.on('line', (line) => {
            const command = line.trim().replace(/^\//, '');
            if (!command) return;
            if (['exit', 'quit'].includes(command) && !canSend) { leave(); return; }
            if (!canSend) {
                process.stdout.write(`${c.muted('Not sent: this server was not started with pnx start.')}\n`);
                return;
            }
            void sendControl(control!, command).then((ok) => {
                if (!ok) process.stdout.write(`${c.error(S.cross)} the server did not take that command\n`);
            });
        });
    });
}

export async function logsCommand(ctx: RunContext): Promise<void> {
    await runLogs({
        lines: readString(ctx.args, 'lines') ?? '50',
        follow: readBool(ctx.args, 'follow') !== false && !(ctx.args.flags['follow'] === false),
    });
}
