import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CliError, type RunContext } from '../cli/define.js';
import { outroTail } from '../ui/kit.js';
import { resolveServerDir } from '../services/server.js';
import { openConfig } from '../services/config-file.js';
import { json } from '../infra/json.js';

/**
 * `pnx open` - the server folder (or its config, log, plugins, backups) in the
 * system's own file manager or editor, without hunting for the path.
 */

const TARGETS = ['folder', 'config', 'logs', 'plugins', 'backups', 'worlds'] as const;

/** Opens a path with whatever the OS uses for it; never waits on it. */
export function openPath(path: string): void {
    const [command, args] = process.platform === 'win32'
        ? ['explorer.exe', [path]]
        : process.platform === 'darwin'
            ? ['open', [path]]
            : ['xdg-open', [path]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
}

export async function openCommand(ctx: RunContext): Promise<void> {
    const what = (ctx.args.positionals[0] ?? 'folder').toLowerCase();
    if (!TARGETS.includes(what as (typeof TARGETS)[number])) {
        throw new CliError(`Cannot open \`${what}\`.`, `Pick one of: ${TARGETS.join(', ')}.`);
    }
    const dir = await resolveServerDir();
    if (!dir) throw new CliError('No server found here.', 'Point at one with `pnx use <path>`.');

    let path = dir;
    if (what === 'config') {
        const file = openConfig(dir);
        if (!file) throw new CliError('No pnx.yml yet.', 'It is written on the first boot: run `pnx start` once.');
        path = file.path;
    } else if (what === 'logs') {
        path = join(dir, 'logs');
    } else if (what !== 'folder') {
        path = join(dir, what);
    }
    if (!existsSync(path)) throw new CliError(`${path} does not exist yet.`);

    if (json.isJson()) {
        json.emit({ path });
        return;
    }
    openPath(path);
    outroTail(`Opened ${path}`, 'ok');
}
