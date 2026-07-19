import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { intro, outro, log, isJson, json } from '../../ui/output.js';
import { c } from '../../ui/theme.js';
import { resolveServerDir } from '../../services/server.js';
import { getInstalled } from '../../services/plugins.js';
export const installedCmd = defineCommand({
    meta: { description: 'List installed plugins' },
    args: {},
    async run() {
        const serverPath = await resolveServerDir();
        const pluginsDir = serverPath ? join(serverPath, 'plugins') : 'plugins';
        if (!existsSync(pluginsDir)) {
            if (isJson())
                json({ plugins: [] });
            log.warn("No plugins/ directory");
            return;
        }
        const jars = (await readdir(pluginsDir)).filter(f => f.endsWith('.jar'));
        if (isJson())
            json({ plugins: jars.map(j => ({ file: j })) });
        intro(`📁 ${"Installed plugins"}`);
        if (jars.length === 0) {
            log.warn("No plugins installed");
            return;
        }
        const tracked = await getInstalled();
        for (const j of jars) {
            const meta = tracked.find(p => p.fileName === j);
            if (meta)
                log.raw(`  ${c.accent('●')} ${c.bold(meta.name)}  ${c.dim('v' + meta.version)}`);
            else
                log.raw(`  ${c.dim('○')} ${j.replace('.jar', '')}`);
        }
        log.info(`${String(jars.length)} plugin(s)`);
        log.info("Restart the server to load plugins");
        outro('');
    },
});
