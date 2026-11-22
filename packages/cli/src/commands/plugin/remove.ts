import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type RunContext } from '../../cli/define.js';
import { introHead, isInteractive, askMulti, askConfirm, nextSteps, outroTail, empty, log } from '../../ui/kit.js';
import { c, S } from '../../ui/theme.js';
import { resolveServerDir } from '../../services/server.js';
import { getInstalled, removeInstalled } from '../../services/plugins.js';

/**
 * Removing plugins, one confirmation per jar.
 *
 * Deleting a jar is two things: no server reloads it and the copy is gone.
 * The first matters next boot; the second is why every removal asks its own
 * confirm, even in a batch, so an enter-pressed-in-a-row cannot cost a jar
 * somebody's world companion depends on.
 */

interface RemoveCandidate {
    /** The jar file as it sits in plugins/. */
    file: string;
    /** The slug this CLI recorded, when it did the installing. */
    slug?: string;
}

export async function runRemovePlugins(asked: string[], assumeYes: boolean): Promise<void> {
    introHead('pnx plugin remove', 'off the disk, once confirmed');

    const serverPath = (await resolveServerDir()) ?? '.';
    const pluginsDir = join(serverPath, 'plugins');

    if (!existsSync(pluginsDir)) {
        empty(`No plugins/ directory in ${serverPath}`, [
            ['pnx plugin install', 'install one, which creates it'],
        ]);
        outroTail('Nothing to remove.');
        return;
    }

    const jars = (await readdir(pluginsDir)).filter((f) => f.endsWith('.jar'));
    if (jars.length === 0) {
        empty('No plugins are installed.', [
            ['pnx plugin search <term>', 'find one'],
        ]);
        outroTail('Nothing to remove.');
        return;
    }

    let targets: RemoveCandidate[];
    if (asked.length === 0 && !isInteractive()) {
        outroTail('Pass plugin names as arguments - there is no picker without a terminal.', 'fail');
        return;
    }

    if (asked.length > 0) {
        targets = asked.map((name) => {
            const target = name.endsWith('.jar') ? name : `${name}.jar`;
            const found = jars.find((jar) => jar.toLowerCase() === target.toLowerCase());
            return found ? { file: found } : { file: name };
        });
    } else {
        const tracked = await getOrEmpty();
        const picked = await askMulti({
            message: 'Plugins to remove',
            options: jars.map((jar) => {
                const known = tracked.find((p) => p.fileName === jar);
                return {
                    value: jar,
                    label: jar.replace(/\.jar$/i, ''),
                    hint: known?.version ? `v${known.version}` : undefined,
                };
            }),
        });
        if (picked.length === 0) {
            outroTail('Nothing selected.');
            return;
        }
        targets = picked.map((file) => {
            const known = tracked.find((p) => p.fileName === file);
            return { file, slug: known?.slug };
        });
    }

    const removed: string[] = [];
    for (const target of targets) {
        const found = jars.find((jar) => jar.toLowerCase() === target.file.toLowerCase());
        if (!found) {
            log.warn(`Plugin not found: ${target.file}`);
            continue;
        }

        const confirmed = assumeYes || (isInteractive() && (await askConfirm(`Remove ${found}?`, false)));
        if (!confirmed) continue;

        try {
            await rm(join(pluginsDir, found));
        } catch (cause) {
            log.error(`Could not delete ${found}: ${cause instanceof Error ? cause.message : cause}`);
            continue;
        }

        // the file is gone either way; the registry entry is only what a
        // tracked jar leaves behind, and an untracked one has none
        if (target.slug) await removeInstalled(target.slug);
        removed.push(found);
        log.success(`${found} removed`);
    }

    if (removed.length === 0) {
        outroTail('Nothing was removed.', 'fail');
        return;
    }

    nextSteps([
        ['pnx stop', 'stop the server'],
        ['pnx start', 'start it, so the change takes effect'],
    ]);
    outroTail(`${removed.length} plugin${removed.length === 1 ? '' : 's'} removed.`, 'ok');
}

async function getOrEmpty() {
    return getInstalled();
}

export async function removeCommand(ctx: RunContext): Promise<void> {
    await runRemovePlugins([...ctx.args.positionals], false);
}
