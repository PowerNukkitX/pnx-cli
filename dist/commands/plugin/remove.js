import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { intro, outro, log } from '../../ui/output.js';
import { promptMulti, promptConfirm } from '../../ui/prompts.js';
import { resolveServerDir } from '../../services/server.js';
import { removeInstalled } from '../../services/plugins.js';
export const removeCmd = defineCommand({
    meta: { description: 'Remove installed plugins' },
    args: { names: { type: 'positional', description: 'Plugin names', required: false } },
    async run({ args }) {
        const serverPath = (await resolveServerDir()) ?? '.';
        const pluginsDir = join(serverPath, 'plugins');
        if (!existsSync(pluginsDir)) {
            log.error("No plugins/ directory");
            return;
        }
        const jars = (await readdir(pluginsDir)).filter(f => f.endsWith('.jar'));
        if (jars.length === 0) {
            log.warn("No plugins installed");
            return;
        }
        let names = args.names ? [args.names] : [];
        if (names.length === 0) {
            names = await promptMulti("Select plugins to remove:", jars.map(j => ({ value: j, label: j.replace('.jar', '') })));
        }
        intro(`🗑️ ${"Remove plugins"}`);
        for (const name of names) {
            const target = name.endsWith('.jar') ? name : `${name}.jar`;
            const found = jars.find(j => j.toLowerCase() === target.toLowerCase());
            if (!found) {
                log.warn(`Plugin not found: ${name}`);
                continue;
            }
            if (await promptConfirm(`Remove ${found}?`, false)) {
                await rm(join(pluginsDir, found));
                await removeInstalled(found.replace('.jar', ''));
                log.success(`${found} removed`);
            }
        }
        outro('');
    },
});
