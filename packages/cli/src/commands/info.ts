import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { freemem, totalmem } from 'node:os';
import { type RunContext } from '../cli/define.js';
import { introHead, keyValue, nextSteps, outroTail } from '../ui/kit.js';
import { c } from '../ui/theme.js';
import { resolveServerDir } from '../services/server.js';
import { json } from '../infra/json.js';

/**
 * What is installed here, in two aligned blocks.
 *
 * A path is a fact, not a verdict, so only `status` is allowed to be a colour.
 * Two deliberately boring labels - version, java - are the ones an operator is
 * usually cross-checking against something else.
 */

export async function runInfo(): Promise<void> {
    const serverPath = await resolveServerDir();
    const installed = serverPath !== null;

    let plugins: string[] = [];
    let worlds: string[] = [];
    if (serverPath && existsSync(join(serverPath, 'plugins'))) {
        plugins = (await readdir(join(serverPath, 'plugins'))).filter((f) => f.endsWith('.jar'));
    }
    if (serverPath && existsSync(join(serverPath, 'worlds'))) {
        worlds = await readdir(join(serverPath, 'worlds'));
    }

    const freeMb = Math.round(freemem() / 1024 / 1024);
    const totalMb = Math.round(totalmem() / 1024 / 1024);

    if (json.isJson()) {
        json.emit({
            status: installed ? 'installed' : 'not_installed',
            serverDir: serverPath,
            plugins: plugins.length,
            worlds: worlds.length,
            ram: { freeMb, totalMb },
        });
        return;
    }

    introHead('pnx info', 'what is installed here');

    keyValue(
        {
            Status: installed ? c.success('installed') : c.error('not installed'),
            Path: serverPath ?? c.muted('not found'),
            Plugins: String(plugins.length),
            Worlds: String(worlds.length),
        },
        'Server',
    );
    keyValue(
        {
            Memory: `${freeMb} MB free of ${totalMb} MB`,
            Platform: `${process.platform} ${process.arch}`,
        },
        'System',
    );

    if (!installed) {
        nextSteps([['pnxcli', 'walk through creating one'], ['pnx init', 'create one from the terminal']]);
        outroTail('Nothing is here yet.');
        return;
    }
    outroTail('Start it with `pnx start`.');
}

export function infoCommand(ctx: RunContext): Promise<void> {
    void ctx;
    return runInfo();
}
