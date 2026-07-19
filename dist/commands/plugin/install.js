import { join } from 'node:path';
import { defineCommand } from 'citty';
import { intro, outro, log, spin, progress } from '../../ui/output.js';
import { promptMulti } from '../../ui/prompts.js';
import { resolveServerDir } from '../../services/server.js';
import { searchPlugins, installPlugin, installFromUrl } from '../../services/plugins.js';
export const installCmd = defineCommand({
    meta: { description: 'Install plugins' },
    args: { names: { type: 'positional', description: 'Plugin slugs or .jar URLs', required: false } },
    async run({ args }) {
        const serverPath = (await resolveServerDir()) ?? '.';
        const pluginsDir = join(serverPath, 'plugins');
        let names = args.names ? [args.names] : [];
        if (names.length === 0) {
            intro(`📦 ${"Install plugins"}`);
            const sp = spin("Fetching from marketplace...");
            const resp = await searchPlugins({ sort: 'stars', limit: 50 });
            sp.stop(`${resp.plugins.length} plugins`);
            names = await promptMulti("Select plugins to install:", resp.plugins.map(p => ({ value: p.slug, label: p.name, hint: p.description })));
            if (names.length === 0) {
                log.info("No plugin selected");
                return;
            }
        }
        intro(`📦 ${"Install plugins"}`);
        for (const name of names) {
            if (name.startsWith('http://') || name.startsWith('https://')) {
                try {
                    const file = await installFromUrl(name, pluginsDir, (pct, f) => progress(pct, f));
                    log.success(`${file} installed`);
                }
                catch {
                    log.error("URL must point to a .jar file");
                }
                continue;
            }
            const sp = spin(name);
            try {
                const entry = await installPlugin(name, pluginsDir, (pct, f) => progress(pct, f));
                sp.stop(`${entry.name} v${entry.version}`);
                log.success(`${entry.name} installed`);
            }
            catch (e) {
                const msg = e.message;
                if (msg.startsWith('no-release'))
                    sp.fail(`No release available for ${name}`);
                else if (msg.startsWith('no-file'))
                    sp.fail(`No file for ${name}`);
                else
                    sp.fail(`Error installing ${name}`);
            }
        }
        log.info("Restart the server to load plugins");
        outro('');
    },
});
