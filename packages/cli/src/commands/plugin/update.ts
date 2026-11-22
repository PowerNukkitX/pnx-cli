import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type RunContext } from '../../cli/define.js';
import { downloadBar, introHead, isInteractive, askMulti, nextSteps, outroTail, empty, log } from '../../ui/kit.js';
import { c, S } from '../../ui/theme.js';
import { resolveServerDir } from '../../services/server.js';
import { getInstalled, removeInstalled, updatePlugin, type PluginEntry } from '../../services/plugins.js';

/**
 * Updating installed plugins to their newest release.
 *
 * One version check per plugin is enough: the marketplace speaks for each one,
 * and a plugin already at the top says so and moves on. Slugs come as
 * arguments, or a multiselect of everything tracked.
 */

interface UpdateTarget {
    slug: string;
    meta?: PluginEntry;
    existingJar?: string;
}

async function readTargets(pluginsDir: string, asked: string[]): Promise<UpdateTarget[]> {
    const jars = (await readdir(pluginsDir)).filter((f) => f.endsWith('.jar'));
    const tracked = await getInstalled();

    if (asked.length > 0) {
        return asked.map((slug) => ({
            slug,
            meta: tracked.find((entry) => entry.slug === slug),
            existingJar: jars.find((jar) => jar.toLowerCase().startsWith(slug.toLowerCase())),
        }));
    }

    const choices = jars.map((jar) => {
        const meta = tracked.find((entry) => entry.fileName === jar);
        return { value: meta?.slug ?? jar.replace(/\.jar$/i, ''), label: jar.replace(/\.jar$/i, ''), hint: meta?.version };
    });
    const picked = await askMulti({
        message: 'Plugins to update',
        options: choices,
    });
    return picked.map((slug) => ({
        slug,
        meta: tracked.find((entry) => entry.slug === slug),
        existingJar: jars.find((jar) => jar.toLowerCase().startsWith(String(slug).toLowerCase())),
    }));
}

export async function runUpdatePlugins(asked: string[]): Promise<void> {
    const serverPath = (await resolveServerDir()) ?? '.';
    const pluginsDir = join(serverPath, 'plugins');

    introHead('pnx plugin update', 'newest release for each');

    if (!existsSync(pluginsDir)) {
        empty(`No plugins/ directory in ${serverPath}`, [
            ['pnx plugin install', 'install one, which creates it'],
        ]);
        outroTail('Nothing to update.');
        return;
    }

    let targets: UpdateTarget[];
    if (asked.length === 0 && !isInteractive()) {
        outroTail('Pass plugin slugs as arguments - there is no picker without a terminal.', 'fail');
        return;
    }
    try {
        targets = await readTargets(pluginsDir, asked);
    } catch (error) {
        outroTail(error instanceof Error ? error.message : String(error), 'fail');
        return;
    }

    if (targets.length === 0) {
        outroTail('Nothing selected.');
        return;
    }

    const updated: string[] = [];
    for (const target of targets) {
        const holder: { entry: PluginEntry | null } = { entry: null };
        const result = await downloadBar(`Updating ${target.slug}`, async (update) => {
            holder.entry = await updatePlugin(
                target.slug,
                pluginsDir,
                target.meta?.version,
                target.existingJar,
                (progress) => update(progress),
            );
        });
        const entry = holder.entry;

        if (result === true && entry === null) {
            log.message(c.muted(`${target.slug} already at the newest version${target.meta ? ` (v${target.meta.version})` : ''}`));
        } else if (result === true && entry) {
            updated.push(entry.name);
            log.success(`${entry.name} updated to v${entry.version}`);
        } else if (typeof result === 'string' && result.startsWith('no-release:')) {
            log.error(`${target.slug} has no published release`);
        } else if (typeof result === 'string' && result.startsWith('no-file:')) {
            log.error(`${target.slug} has no downloadable file`);
        } else {
            log.error(`Could not update ${target.slug}: ${String(result)}`);
        }
    }

    if (updated.length === 0) {
        nextSteps([['pnx plugin installed', 'see what is tracked']], 'Info');
        outroTail('Everything was already up to date.');
        return;
    }

    nextSteps([
        ['pnx stop', 'stop the server'],
        ['pnx start', 'start it, so the new builds load'],
    ]);
    outroTail(`${updated.length} plugin${updated.length === 1 ? '' : 's'} updated.`, 'ok');
}

export function updateCommand(ctx: RunContext): Promise<void> {
    const asked = ctx.args.positionals.length > 0 ? [...ctx.args.positionals] : [];
    return runUpdatePlugins(asked);
}
