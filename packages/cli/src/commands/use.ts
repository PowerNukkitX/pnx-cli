import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CliError, readString, readBool, type RunContext } from '../cli/define.js';
import { askSelect, askText, introHead, nextSteps, outroTail } from '../ui/kit.js';
import { c } from '../ui/theme.js';
import { detectServers, setDefaultServer } from '../services/server.js';
import { JAR_NAME } from '../infra/paths.js';

/**
 * Choosing which server every other command works on.
 *
 * The default travels with `pnx use`, not with the shell's working directory -
 * a server lives in a directory, not in whatever tab the operator happens to
 * have open tonight.
 */

export interface UseOptions {
    dir?: string;
    clear?: boolean;
}

export async function runUse(options: UseOptions): Promise<void> {
    introHead('pnx use', 'choose the default server');

    if (options.clear) {
        await setDefaultServer(null);
        outroTail('Cleared. Commands will use the current directory again.');
        return;
    }

    let target = options.dir;
    if (!target) {
        const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
        if (!interactive) {
            throw new CliError(
                'Pass a path with `pnx use <path>` - there is no list to pick from without a terminal.',
                'Example: pnx use ~/minecraft/winter',
            );
        }
        const found = detectServers();
        target = (found.length > 0
            ? await askSelect({
                message: 'Which server?',
                options: found.map((dir) => ({ value: dir, label: dir })),
            })
            : await askText({ message: 'Full path of the server folder', placeholder: 'D:\\Servers\\winter' }));
    }

    const expanded = target.replace(/^~(?=$|[\\/])/, homedir());
    const serverDir = resolve(expanded);
    if (!existsSync(join(serverDir, JAR_NAME))) {
        nextSteps(
            [
                ['pnx init --dir <path>', `create a server under ${serverDir}`],
                ['pnx use', 'pick from the servers found on this machine'],
            ],
            'Try',
        );
        outroTail(`No ${c.bold(JAR_NAME)} in ${serverDir}. The default is unchanged.`, 'fail');
        return;
    }

    await setDefaultServer(serverDir);
    nextSteps([
        ['pnx info', 'see what is installed there'],
        ['pnx start', 'boot it'],
    ]);
    outroTail(`Every command now works on ${serverDir}.`, 'ok');
}

export async function useCommand(ctx: RunContext): Promise<void> {
    await runUse({
        dir: ctx.args.positionals[0] ?? readString(ctx.args, 'dir'),
        clear: readBool(ctx.args, 'clear'),
    });
}
