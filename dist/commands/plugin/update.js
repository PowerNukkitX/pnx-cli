import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { intro, outro, log, spin, progress } from '../../ui/output.js';
import { promptMulti } from '../../ui/prompts.js';
import { resolveServerDir } from '../../services/server.js';
import { getInstalled, updatePlugin } from '../../services/plugins.js';
export const updateCmd = defineCommand({
    meta: { description: 'Update installed plugins' },
    args: { names: { type: 'positional', description: 'Plugin slugs', required: false } },
    async run({ args }) {
        const serverPath = (await resolveServerDir()) ?? '.';
        const pluginsDir = join(serverPath, 'plugins');
        if (!existsSync(pluginsDir)) {
            log.error("No plugins/ directory");
            return;
        }
        const jars = (await readdir(pluginsDir)).filter(f => f.endsWith('.jar'));
        let names = args.names ? [args.names] : [];
        if (names.length === 0) {
            names = await promptMulti("Select plugins to update:", jars.map(j => ({ value: j.replace('.jar', ''), label: j.replace('.jar', '') })));
        }
        intro(`🔄 ${"Update plugins"}`);
        const tracked = await getInstalled();
        for (const slug of names) {
            const sp = spin(slug);
            try {
                const meta = tracked.find(p => p.slug === slug);
                const existingJar = jars.find(j => j.toLowerCase().startsWith(slug.toLowerCase()));
                const entry = await updatePlugin(slug, pluginsDir, meta?.version, existingJar, (pct, f) => progress(pct, f));
                if (!entry) {
                    sp.stop(`${slug} is already up to date (v${meta?.version ?? '?'})`);
                    continue;
                }
                sp.stop(`${entry.name} v${entry.version}`);
                log.success(`${entry.name} updated to v${entry.version}`);
            }
            catch (e) {
                const msg = e.message;
                if (msg.startsWith('no-release'))
                    sp.fail(`No release available for ${slug}`);
                else if (msg.startsWith('no-file'))
                    sp.fail(`No file for ${slug}`);
                else
                    sp.fail(`Error installing ${slug}`);
            }
        }
        log.info("Restart the server to load plugins");
        outro('');
    },
});
