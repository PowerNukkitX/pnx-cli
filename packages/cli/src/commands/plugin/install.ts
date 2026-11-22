import { join } from 'node:path';
import { type RunContext } from '../../cli/define.js';
import { downloadBar, introHead, isInteractive, askMulti, nextSteps, outroTail, spinner, log } from '../../ui/kit.js';
import { c, S } from '../../ui/theme.js';
import { resolveServerDir } from '../../services/server.js';
import { searchPlugins, installPlugin, installFromUrl, type DownloadProgress } from '../../services/plugins.js';

/**
 * Installing plugins.
 *
 * Given slugs on the command line, this is a batch runner: each one installs,
 * each failure is named, and none cancels the others. Given nothing, it asks
 * the marketplace for the most starred and offers them as a multiselect, so
 * choosing is a highlight and a spacebar rather than typing.
 */

export interface InstallOptions {
    names?: string[];
}

/** Adapts the service's (progress, file) callback to the bar's one argument. */
function sink(update: (progress: DownloadProgress) => void) {
    return (progress: DownloadProgress) => update(progress);
}

export async function runInstallPlugins(options: InstallOptions): Promise<void> {
    introHead('pnx plugin install', 'from the marketplace');

    const serverPath = await resolveServerDir();
    if (!serverPath) {
        nextSteps([['pnx init', 'create a server first'], ['pnx use <path>', 'or point at an existing one']], 'Try');
        outroTail('No server here to install into.', 'fail');
        return;
    }
    const pluginsDir = join(serverPath, 'plugins');

    let names: string[] = options.names ?? [];
    if (names.length === 0) {
        if (!isInteractive()) {
            outroTail('Pass plugin slugs as arguments - there is no picker without a terminal.', 'fail');
            return;
        }
        const sp = spinner();
        sp.start('Fetching the marketplace...');
        let plugins;
        try {
            plugins = (await searchPlugins({ sort: 'stars', limit: 50 })).plugins;
        } catch (cause) {
            sp.error('Could not reach the marketplace');
            log.message(c.muted(cause instanceof Error ? cause.message : String(cause)));
            nextSteps([['pnx plugin search <term>', 'search once the connection is back']], 'Try');
            outroTail('Nothing was installed.', 'fail');
            return;
        }
        sp.stop(`${plugins.length} plugins available`);

        if (plugins.length === 0) {
            outroTail('The marketplace returned no plugins to choose from.');
            return;
        }

        // required: an empty multiselect here means "nothing picked", and the
        // run should say so rather than read as a submission
        names = await askMulti({
            message: 'Plugins to install',
            options: plugins.map((plugin) => ({
                value: plugin.slug,
                label: plugin.name,
                hint: plugin.description,
            })),
        });
        if (names.length === 0) {
            outroTail('Nothing selected.');
            return;
        }
    }

    const installed: string[] = [];
    const failed: string[] = [];

    for (const name of names) {
        const isUrl = name.startsWith('http://') || name.startsWith('https://');

        // the bar alone on the line: a spinner over the same download would
        // fight it for the same row
        const result = await downloadBar(
            `Installing ${isUrl ? (name.split('/').pop() ?? name) : name}`,
            async (update) => {
                if (isUrl) await installFromUrl(name, pluginsDir, sink(update));
                else await installPlugin(name, pluginsDir, sink(update));
            },
        );

        if (result === true) {
            installed.push(name);
        } else if (result.includes('url-invalid')) {
            failed.push(`${name} is not a .jar URL`);
        } else if (result.startsWith('no-release:')) {
            failed.push(`${name} has no published release`);
        } else if (result.startsWith('no-file:')) {
            failed.push(`${name} has no downloadable file`);
        } else {
            failed.push(`Could not install ${name}: ${result}`);
        }
    }

    for (const line of failed) {
        log.error(`${line}`);
    }

    if (installed.length === 0) {
        nextSteps([[`pnx search <name>`, 'check the spelling of what you asked for']], 'Try');
        outroTail('Nothing was installed.', 'fail');
        return;
    }

    nextSteps([
        ['pnx stop', 'stop the server'],
        ['pnx start', 'start it, so the plugins load'],
        ['pnx plugin installed', 'check what is in plugins/'],
    ]);
    outroTail(`${installed.length} plugin${installed.length === 1 ? '' : 's'} installed${failed.length ? `, ${failed.length} failed` : ''}.`, failed.length ? 'fail' : 'ok');
}

export async function installCommand(ctx: RunContext): Promise<void> {
    const passed = ctx.args.positionals.length > 0 ? ctx.args.positionals : [];
    await runInstallPlugins({ names: passed });
}
