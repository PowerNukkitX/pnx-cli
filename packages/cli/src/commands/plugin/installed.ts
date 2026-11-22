import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { table, empty, note, outroTail, log } from '../../ui/kit.js';
import { c, S } from '../../ui/theme.js';
import { resolveServerDir } from '../../services/server.js';
import { getInstalled } from '../../services/plugins.js';
import { json } from '../../infra/json.js';

/**
 * The jars on disk, and what this CLI knows about them.
 *
 * A jar installed by pnx carries a name and a version; one dropped in by hand
 * carries neither, and that difference is worth showing rather than hiding.
 * The dot in the first column is the whole of it: tracked jars can be updated
 * by slug, untracked ones cannot.
 */
export async function runInstalledPlugins(): Promise<void> {
    const serverPath = await resolveServerDir();
    const pluginsDir = serverPath ? join(serverPath, 'plugins') : 'plugins';

    if (!existsSync(pluginsDir)) {
        if (json.isJson()) {
            json.emit({ plugins: [] });
            return;
        }
        empty('No plugins/ directory here.', [
            ['pnx plugin install', 'install one, which creates it'],
        ]);
        outroTail('Nothing installed.');
        return;
    }

    const jars = (await readdir(pluginsDir)).filter((f) => f.endsWith('.jar'));

    if (json.isJson()) {
        const tracked = await getInstalled();
        json.emit({
            plugins: jars.map((jar) => {
                const meta = tracked.find((p) => p.fileName === jar);
                return { file: jar, name: meta?.name, version: meta?.version, slug: meta?.slug };
            }),
        });
        return;
    }

    if (jars.length === 0) {
        note(c.warn('Nothing installed yet.'), 'Plugins');
        outroTail('Find something with `pnx plugin search <term>`.');
        return;
    }

    const tracked = await getInstalled();
    const rows = jars.map((jar) => {
        const meta = tracked.find((p) => p.fileName === jar);
        return [
            meta ? c.success(S.dot) : c.muted(S.ring),
            meta ? meta.name : jar.replace(/\.jar$/i, ''),
            meta?.version ? c.brand(`v${meta.version}`) : c.muted('unknown'),
            c.muted(jar),
        ];
    });
    table(['', 'Name', 'Version', 'File'], rows, 'Plugins');
    log.message(c.muted(`${S.dot} installed by pnx, so \`pnx plugin update\` knows where it came from`));
    outroTail(`${jars.length} plugin${jars.length === 1 ? '' : 's'} - restart the server to load changes.`);
}
